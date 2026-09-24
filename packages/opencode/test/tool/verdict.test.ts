// Accuracy E, phase 2: the verdict tool checks every citation against the host's
// records, with the agent's own read rules, before it records anything. The
// records are the session's full history in storage, not the model's context.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
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

const nodes = [
  CrossSpawnSpawner.node,
  FSUtil.node,
  Database.node,
  EventV2Bridge.node,
  Session.node,
  SessionProjector.node,
  Snapshot.node,
  Truncate.node,
  Agent.node,
]
const it = testEffect(LayerNode.compile(LayerNode.group(nodes)))

const SECRET = "sk-live-4f9a2c"

// The host's diff, as `git diff --cached <base>` writes it (captured from the
// snapshot service). Snapshot's own timing is not what these tests are about: on
// this machine its diff can stay empty for a while after files change (reported).
const DIFF = [
  "diff --git a/.env b/.env",
  "index 1111111..9bbcedd 100644",
  "--- a/.env",
  "+++ b/.env",
  "@@ -1 +1,2 @@",
  ` API_KEY=${SECRET}`,
  "+OTHER=value",
  "diff --git a/Plan b/secret.txt b/Plan b/secret.txt",
  "index 3333333..ff568e8 100644",
  "--- a/Plan b/secret.txt\t",
  "+++ b/Plan b/secret.txt\t",
  "@@ -1 +1 @@",
  "-KEY old",
  `+KEY ${SECRET}`,
  "diff --git a/src/budget.ts b/src/budget.ts",
  "index 83db48f..bf269f4 100644",
  "--- a/src/budget.ts",
  "+++ b/src/budget.ts",
  "@@ -1,2 +1,2 @@",
  "-export const LIMIT = 4096",
  "+export const LIMIT = 81920",
  " export const cut = 1",
].join("\n")
const withDiff = testEffect(
  LayerNode.compile(LayerNode.group(nodes), [
    [Snapshot.node, Layer.mock(Snapshot.Service, { diff: () => Effect.succeed(DIFF) })],
  ]),
)

// The verifier's rules as the session evaluates them, with a session rule that
// keeps secrets/ from it: check() answers like the permission service does.
// (the verifier starts from the default "*": "allow"; the lock takes away)
const rules = Permission.effective(
  { name: Permission.VERIFIER, native: true, permission: Permission.agentRules(Permission.fromConfig({ "*": "allow" })) },
  Permission.fromConfig({ read: { "secrets/*": "deny", "Plan b/*": "deny" } }),
)
const check = (input: { permission: string; patterns: ReadonlyArray<string> }) => {
  const actions = input.patterns.map((pattern) => Permission.evaluate(input.permission, pattern, rules).action)
  const action: PermissionV1.Action = actions.includes("deny") ? "deny" : actions.includes("ask") ? "ask" : "allow"
  return Effect.succeed(action)
}

const setup = Effect.fn("VerdictTest.setup")(function* () {
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
  const session = yield* sessions.create({ title: "verify" })
  return { directory, session }
})

/** Another verifier session in the same workspace: one verdict each, since a recorded one is final. */
const another = Effect.fn("VerdictTest.another")(function* (verify?: Record<string, unknown>) {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "verify" })
  if (verify) yield* sessions.setMetadata({ sessionID: session.id, metadata: { verify } })
  return session.id
})

/** Records the goal as the loop does (docs/accuracy-e.md §11.5). */
const goal = Effect.fn("VerdictTest.goal")(function* (sessionID: Session.Info["id"], verify: Record<string, unknown>) {
  const sessions = yield* Session.Service
  yield* sessions.setMetadata({ sessionID, metadata: { verify } })
})

/** Stores a tool part in the session, in a message of its own, and returns the part's id. */
const record = Effect.fn("VerdictTest.record")(function* (
  sessionID: Session.Info["id"],
  tool: string,
  callID: string,
  state: SessionV1.ToolPart["state"],
) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: "build",
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: Date.now() },
  })
  const id = PartID.ascending()
  yield* sessions.updatePart({ id, messageID: message.id, sessionID, type: "tool", tool, callID, state })
  return id
})

/** A shell run: ranBy "user" when the host ran it; exit undefined while it runs. */
const shell = (exit: number | undefined, output: string, ranBy?: "user"): SessionV1.ToolPart["state"] =>
  exit === undefined
    ? { status: "running", input: { command: "bun test" }, time: { start: 1 }, ...(ranBy ? { metadata: { ranBy } } : {}) }
    : {
        status: "completed",
        input: { command: "bun test" },
        output,
        title: "",
        metadata: ranBy ? { output, exit, ranBy } : { output, exit },
        time: { start: 1, end: 2 },
      }

const submit = Effect.fn("VerdictTest.submit")(function* (
  sessionID: Session.Info["id"],
  params: Record<string, unknown>,
  // messageID: the step; parallel calls in one step share it
  options: { agent?: string; messageID?: MessageID } = {},
) {
  const tool = yield* VerdictTool
  const def = yield* tool.init()
  const ctx: Tool.Context = {
    sessionID,
    messageID: options.messageID ?? MessageID.ascending(),
    callID: `call_${Math.random()}`,
    agent: options.agent ?? Permission.VERIFIER,
    abort: AbortSignal.any([]),
    // what the model sees: after a compaction, not the whole history
    messages: [],
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
const capped = { kind: "file", path: "src/budget.ts", lines: [1, 1], quote: "LIMIT = 4096" }

describe("tool.verdict: file citations follow the agent's read rules", () => {
  it.instance("a readable file in the workspace can be cited, by any spelling of its path", () =>
    Effect.gen(function* () {
      const { directory } = yield* setup()
      for (const file of ["src/budget.ts", "./src/budget.ts", path.join(directory, "src", "budget.ts")]) {
        const result = yield* submit(yield* another(), passWith([{ ...capped, path: file }]))
        expect([file, result.error]).toEqual([file, ""])
        if (file === "src/budget.ts") expect(result.output).toContain("Verdict recorded: PASS")
      }
    }),
  )

  // Otherwise "the quote is not in the file" answers questions about a file the
  // verifier may not read: the same oracle grep had.
  it.instance(
    "a link to .env, or a file a session rule denies, cannot be cited, whatever the quote",
    () =>
      Effect.gen(function* () {
        yield* setup()
        for (const [file, line] of [
          ["notes.txt", `API_KEY=${SECRET}`],
          ["secrets/key.txt", `KEY ${SECRET}`],
          [".env", `API_KEY=${SECRET}`],
        ]) {
          const right = yield* submit(yield* another(), passWith([{ kind: "file", path: file, lines: [1, 1], quote: line }]))
          const wrong = yield* submit(
            yield* another(),
            passWith([{ kind: "file", path: file, lines: [1, 1], quote: "nothing like it" }]),
          )
          expect([file, right.error]).toEqual([file, wrong.error])
          expect(right.error).toContain(`${file} cannot be read`)
        }
      }),
    { git: true },
  )

  it.instance("a file outside the workspace cannot be cited", () =>
    Effect.gen(function* () {
      const { directory, session } = yield* setup()
      const outside = path.join(path.dirname(directory), "outside.txt")
      yield* Effect.promise(() => fs.writeFile(outside, "capped at four\n"))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { force: true })))
      const result = yield* submit(
        session.id,
        passWith([{ kind: "file", path: outside, lines: [1, 1], quote: "capped at four" }]),
      )
      expect(result.error).toContain("cannot be read")
    }),
  )
})

describe("tool.verdict: checks are the host's records, bound to the loop", () => {
  it.instance("only a check the loop listed is evidence; a model's shell part or an unlisted one is not", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const listed = yield* record(session.id, ShellID.ToolID, "call_tests", shell(0, "15 pass", "user"))
      yield* record(session.id, ShellID.ToolID, "call_model", shell(0, "15 pass"))
      yield* record(session.id, ShellID.ToolID, "call_other", shell(0, "15 pass", "user"))
      yield* goal(session.id, { checks: [listed] })
      const cite = (callID: string) => passWith([{ kind: "check", callID, exit: 0, excerpt: "15 pass" }])
      for (const callID of ["call_model", "call_other"])
        expect((yield* submit(session.id, cite(callID))).error).toContain(
          `there is no check ${callID} in this verification`,
        )
      expect((yield* submit(session.id, cite("call_tests"))).error).toBe("")
    }),
  )

  it.instance("a failed check blocks a PASS, listed or not, cited or not", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const listed = yield* record(session.id, ShellID.ToolID, "call_lint", shell(0, "no problems", "user"))
      yield* record(session.id, ShellID.ToolID, "call_other", shell(1, "3 fail", "user"))
      yield* goal(session.id, { checks: [listed] })
      expect((yield* submit(session.id, passWith([capped]))).error).toContain("PASS, but check call_other exited 1")
    }),
  )

  // review finding 4: the model's context is filtered after a compaction; the
  // failed check is still in the session's history
  it.instance("a failed check the model no longer sees still blocks a PASS", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const listed = yield* record(session.id, ShellID.ToolID, "call_tests", shell(1, "3 fail", "user"))
      yield* goal(session.id, { checks: [listed] })
      expect((yield* submit(session.id, passWith([capped]))).error).toContain("PASS, but check call_tests exited 1")
    }),
  )

  // review finding 6
  it.instance("a check still running, or orphaned, blocks a PASS", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const listed = yield* record(session.id, ShellID.ToolID, "call_tests", shell(undefined, "", "user"))
      yield* goal(session.id, { checks: [listed] })
      expect((yield* submit(session.id, passWith([capped]))).error).toContain("PASS, but check call_tests did not finish")
    }),
  )
})

describe("tool.verdict: the goal's declared criteria", () => {
  it.instance("every criterion the session's goal declares must be judged", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      yield* goal(session.id, { criteria: ["the output is capped", "the README names --budget"] })
      const result = yield* submit(session.id, passWith([capped]))
      expect(result.error).toContain('the declared criterion "the README names --budget" is not judged')
    }),
  )
})

// review findings 1, 3 and 10, re-review 4: the host's diff as git writes it
describe("tool.verdict: diff citations", () => {
  withDiff.instance(
    "only changed lines count, and a diff of a file the agent may not read is not there at all",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const diff = (file: string, excerpt: string) => passWith([{ kind: "diff", path: file, excerpt }])
        const at = () => another({ base: "base" })
        expect((yield* submit(yield* at(), diff("src/budget.ts", "+export const LIMIT = 81920"))).error).toBe("")
        expect((yield* submit(yield* at(), diff("src/budget.ts", "diff --git a/src/budget.ts"))).error).toContain(
          "the excerpt is not in the diff for src/budget.ts",
        )
        const right = yield* submit(yield* at(), diff(".env", "+OTHER=value"))
        const wrong = yield* submit(yield* at(), diff(".env", "+OTHER=nothing"))
        expect(right.error).toEqual(wrong.error)
        expect(right.error).toContain("the diff does not touch .env")
        const planRight = yield* submit(yield* at(), diff("Plan b/secret.txt", `+KEY ${SECRET}`))
        const planWrong = yield* submit(yield* at(), diff("Plan b/secret.txt", "+KEY sk-dead-000"))
        expect(planRight.error).toEqual(planWrong.error)
        expect(planRight.error).toContain("the diff does not touch Plan b/secret.txt")
      }),
    { git: true },
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
  it.instance("submissions are counted from the session's history; the third stores what checks out", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const bad = passWith([{ ...capped, quote: "LIMIT = 9999" }])
      const first = yield* submit(session.id, bad)
      expect(first.error).toContain("2 of 3 submissions left")
      for (const n of [1, 2])
        yield* record(session.id, "verdict", `call_err_${n}`, {
          status: "error",
          input: {},
          error: "not accepted",
          time: { start: 1, end: 2 },
        })
      const third = yield* submit(session.id, bad)
      expect(third.error).toBe("")
      expect(third.output).toContain("Recorded as PARTIAL")
      expect(third.metadata?.verdict?.verdict).toBe("PARTIAL")
    }),
  )

  it.instance("a recorded verdict is final, in storage and in this process", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      // in one step: the part is not in storage yet
      const step = MessageID.ascending()
      expect((yield* submit(session.id, passWith([capped]), { messageID: step })).error).toBe("")
      expect((yield* submit(session.id, passWith([capped]), { messageID: step })).error).toContain("already recorded")
      // in a later step: storage holds the recorded verdict
      const other = { id: yield* another() }
      yield* record(other.id, "verdict", "call_done", {
        status: "completed",
        input: {},
        output: "",
        title: "",
        metadata: {},
        time: { start: 1, end: 2 },
      })
      expect((yield* submit(other.id, passWith([capped]))).error).toContain("already recorded")
    }),
  )

  // review finding 5
  it.instance("parallel submissions in one step record one verdict", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const step = { messageID: MessageID.ascending() }
      const results = yield* Effect.all(
        [submit(session.id, passWith([capped]), step), submit(session.id, passWith([capped]), step)],
        { concurrency: "unbounded" },
      )
      expect(results.filter((result) => result.error === "")).toHaveLength(1)
      expect(results.filter((result) => result.error.includes("already recorded"))).toHaveLength(1)
    }),
  )

  // re-review 5: what the tool remembers in this process is the step's, not the
  // session's forever: after a revert removes the recorded verdict from storage,
  // a later step can submit again
  it.instance("a reverted session can submit again", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      expect((yield* submit(session.id, passWith([capped]))).error).toBe("")
      // (the verdict's part never reached storage, as after a revert)
      expect((yield* submit(session.id, passWith([capped]))).error).toBe("")
    }),
  )

  // review finding 11
  it.instance("no agent but the verifier can submit a verdict", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      expect((yield* submit(session.id, passWith([capped]), { agent: "build" })).error).toContain(
        "only the goal verifier",
      )
    }),
  )
})
