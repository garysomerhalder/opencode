// Accuracy E, phase 2: the verdict tool checks every citation against the host's
// records, with the agent's own read rules, before it records anything.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Truncate } from "../../src/tool/truncate"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { Snapshot } from "../../src/snapshot"
import { ShellID } from "../../src/tool/shell/id"
import type * as Tool from "../../src/tool/tool"
import { VerdictTool } from "../../src/tool/verdict"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Database.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      Snapshot.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const SECRET = "sk-live-4f9a2c"

// The verifier's rules as the session evaluates them, with a session rule that
// keeps secrets/ from it: check() answers like the permission service does.
// (the verifier starts from the default "*": "allow"; the lock takes away)
const rules = Permission.effective(
  { name: Permission.VERIFIER, native: true, permission: Permission.agentRules(Permission.fromConfig({ "*": "allow" })) },
  Permission.fromConfig({ read: { "secrets/*": "deny" } }),
)
const check = (input: { permission: string; patterns: ReadonlyArray<string> }) => {
  const actions = input.patterns.map((pattern) => Permission.evaluate(input.permission, pattern, rules).action)
  const action: PermissionV1.Action = actions.includes("deny") ? "deny" : actions.includes("ask") ? "ask" : "allow"
  return Effect.succeed(action)
}

/** A shell part in the verifier's session: ranBy "user" when the host ran it. */
const shellPart = (callID: string, exit: number, output: string, ranBy?: "user"): SessionV1.WithParts => {
  const id = MessageID.ascending()
  return {
    info: { id, role: "assistant" } as SessionV1.Assistant,
    parts: [
      {
        type: "tool",
        id: PartID.ascending(),
        messageID: id,
        sessionID: "ses_verify" as SessionV1.ToolPart["sessionID"],
        tool: ShellID.ToolID,
        callID,
        state: {
          status: "completed",
          input: { command: "bun test" },
          output,
          title: "",
          metadata: ranBy ? { output, exit, ranBy } : { output, exit },
          time: { start: 1, end: 2 },
        },
      } as SessionV1.ToolPart,
    ],
  }
}

const setup = Effect.fn("VerdictTest.setup")(function* (metadata?: Record<string, unknown>) {
  const { directory } = yield* TestInstance
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(directory, "src"), { recursive: true })
    await fs.mkdir(path.join(directory, "secrets"), { recursive: true })
    await fs.writeFile(path.join(directory, "src", "budget.ts"), "export const LIMIT = 4096\nexport const cut = 1\n")
    await fs.writeFile(path.join(directory, ".env"), `API_KEY=${SECRET}\n`)
    await fs.writeFile(path.join(directory, "secrets", "key.txt"), `KEY ${SECRET}\n`)
    await fs.symlink(path.join(directory, ".env"), path.join(directory, "notes.txt"), "file")
  })
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "verify", ...(metadata ? { metadata } : {}) })
  return { directory, session }
})

const submit = Effect.fn("VerdictTest.submit")(function* (
  sessionID: Session.Info["id"],
  params: Record<string, unknown>,
  messages: SessionV1.WithParts[] = [],
) {
  const tool = yield* VerdictTool
  const def = yield* tool.init()
  const ctx: Tool.Context = {
    sessionID,
    messageID: MessageID.ascending(),
    callID: `call_${Math.random()}`,
    agent: Permission.VERIFIER,
    abort: AbortSignal.any([]),
    messages,
    metadata: () => Effect.void,
    ask: () => Effect.void,
    check,
  }
  const exit = yield* def.execute(params as never, ctx).pipe(Effect.exit)
  return Exit.isSuccess(exit)
    ? { output: exit.value.output, error: "", metadata: exit.value.metadata }
    : { output: "", error: String(Cause.squash(exit.cause)), metadata: undefined }
})

const passWith = (evidence: unknown[]) => ({
  verdict: "PASS",
  criteria: [{ id: "C1", text: "the output is capped", status: "met", evidence }],
  missing: [],
})

describe("tool.verdict: file citations follow the agent's read rules", () => {
  it.instance("a readable file in the workspace can be cited", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const result = yield* submit(
        session.id,
        passWith([{ kind: "file", path: "src/budget.ts", lines: [1, 1], quote: "LIMIT = 4096" }]),
      )
      expect(result.error).toBe("")
      expect(result.output).toContain("Verdict recorded: PASS")
    }),
  )

  // Otherwise "the quote is not in the file" answers questions about a file the
  // verifier may not read: the same oracle grep had.
  it.instance("a link to .env, or a file a session rule denies, cannot be cited, whatever the quote", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      for (const [file, line] of [
        ["notes.txt", `API_KEY=${SECRET}`],
        ["secrets/key.txt", `KEY ${SECRET}`],
        [".env", `API_KEY=${SECRET}`],
      ]) {
        const right = yield* submit(session.id, passWith([{ kind: "file", path: file, lines: [1, 1], quote: line }]))
        const wrong = yield* submit(session.id, passWith([{ kind: "file", path: file, lines: [1, 1], quote: "nope" }]))
        expect([file, right.error]).toEqual([file, wrong.error])
        expect(right.error).toContain(`${file} cannot be read`)
      }
    }),
    // a git workspace, so the session's "secrets/*" rule is matched against a relative path
    { git: true },
  )

  it.instance("a file outside the workspace cannot be cited", () =>
    Effect.gen(function* () {
      const { directory, session } = yield* setup()
      const outside = path.join(path.dirname(directory), "outside.txt")
      yield* Effect.promise(() => fs.writeFile(outside, "capped\n"))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { force: true })))
      const result = yield* submit(session.id, passWith([{ kind: "file", path: outside, lines: [1, 1], quote: "capped" }]))
      expect(result.error).toContain("cannot be read")
    }),
  )
})

describe("tool.verdict: checks are the host's records", () => {
  it.instance("only a shell part the host ran is a check; a model's shell part is not", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const cite = [{ kind: "check", callID: "call_tests", exit: 0, excerpt: "15 pass" }]
      const model = yield* submit(session.id, passWith(cite), [shellPart("call_tests", 0, "15 pass")])
      expect(model.error).toContain("there is no check call_tests in this verification")
      const host = yield* submit(session.id, passWith(cite), [shellPart("call_tests", 0, "15 pass", "user")])
      expect(host.error).toBe("")
    }),
  )

  it.instance("a PASS is not recorded while a check the host ran failed, cited or not", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const result = yield* submit(
        session.id,
        passWith([{ kind: "file", path: "src/budget.ts", lines: [1, 1], quote: "LIMIT = 4096" }]),
        [shellPart("call_tests", 1, "3 fail", "user")],
      )
      expect(result.error).toContain("PASS, but check call_tests exited 1")
    }),
  )
})

describe("tool.verdict: the goal's declared criteria", () => {
  it.instance("every criterion the session's goal declares must be judged", () =>
    Effect.gen(function* () {
      const { session } = yield* setup({ verify: { criteria: ["the output is capped", "the README names --budget"] } })
      const result = yield* submit(
        session.id,
        passWith([{ kind: "file", path: "src/budget.ts", lines: [1, 1], quote: "LIMIT = 4096" }]),
      )
      expect(result.error).toContain('the declared criterion "the README names --budget" is not judged')
    }),
  )
})

// The verifier learns the rules from the description: it should not find them out
// only from rejections.
describe("tool.verdict: the description states the rules the tool enforces", () => {
  it.instance("checks succeed with exit 0; declared criteria as written; todos need evidence", () =>
    Effect.gen(function* () {
      const tool = yield* VerdictTool
      const description = (yield* tool.init()).description
      expect(description).toContain("A PASS cannot stand while any check run for this verification failed")
      expect(description).toContain("a check succeeds only with exit 0")
      expect(description).toContain("You never declare what exit code a check should have")
      expect(description).toContain("Judge every criterion the user declared, with its text as written")
      expect(description).toContain("A todo you mark met needs evidence too")
    }),
  )
})

describe("tool.verdict: submissions", () => {
  it.instance("the third submission stores what checks out, as PARTIAL; a recorded verdict is final", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const bad = passWith([{ kind: "file", path: "src/budget.ts", lines: [1, 1], quote: "LIMIT = 9" }])
      const earlier = (status: "error" | "completed"): SessionV1.WithParts => {
        const id = MessageID.ascending()
        return {
          info: { id, role: "assistant" } as SessionV1.Assistant,
          parts: [
            {
              type: "tool",
              id: PartID.ascending(),
              messageID: id,
              sessionID: session.id,
              tool: "verdict",
              callID: `call_${status}_${Math.random()}`,
              state:
                status === "error"
                  ? { status, input: {}, error: "not accepted", time: { start: 1, end: 2 } }
                  : { status, input: {}, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } },
            } as SessionV1.ToolPart,
          ],
        }
      }
      const first = yield* submit(session.id, bad)
      expect(first.error).toContain("2 of 3 submissions left")
      const third = yield* submit(session.id, bad, [earlier("error"), earlier("error")])
      expect(third.error).toBe("")
      expect(third.output).toContain("Recorded as PARTIAL")
      expect(third.metadata?.verdict?.verdict).toBe("PARTIAL")
      const again = yield* submit(session.id, passWith([]), [earlier("completed")])
      expect(again.error).toContain("already recorded")
    }),
  )
})
