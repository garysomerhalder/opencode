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
import { SessionGoal } from "../../src/session/goal"
import { Todo } from "../../src/session/todo"
import { contentKey } from "../../src/session/checkpoint"
import { VerifyRecord } from "../../src/session/verify-record"
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
  SessionGoal.node,
  Todo.node,
]
const it = testEffect(LayerNode.compile(LayerNode.group(nodes)))

const SECRET = "sk-live-4f9a2c"

// The host's diff, as `git diff --cached <base>` writes it (captured from the
// snapshot service). Snapshot's own git failures are covered in the snapshot tests;
// a base of "gone" stands for one git cannot read, where diff() returns undefined.
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
    [
      Snapshot.node,
      Layer.mock(Snapshot.Service, { diff: (base) => Effect.succeed(base === "gone" ? undefined : DIFF) }),
    ],
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

/** Records the goal as the loop does (docs/accuracy-e.md §11.5), keeping the host's check records. */
const goal = Effect.fn("VerdictTest.goal")(function* (sessionID: Session.Info["id"], verify: Record<string, unknown>) {
  const sessions = yield* Session.Service
  const metadata = (yield* sessions.get(sessionID)).metadata
  yield* sessions.setMetadata({ sessionID, metadata: { ...metadata, verify } })
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
  // A finished check the host ran (the loop, with its token) is recorded host-side as
  // the shell route records it: its exit, and its output's hash and length.
  if (tool === ShellID.ToolID && state.status === "completed" && state.metadata?.ranBy === "user")
    yield* VerifyRecord.update(sessions, sessionID, (current) => ({
      ...current,
      checks: {
        ...current.checks,
        [id]: {
          exit: typeof state.metadata?.exit === "number" ? state.metadata.exit : null,
          ...VerifyRecord.digest(state.output),
        },
      },
    }))
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

  // Re-review of Phase 3, branch 2 (CRITICAL): a check's result is the host's record
  // of it, not the part's metadata, which storage writes could change.
  it.instance("a check's part rewritten after it ran is not evidence, and its recorded exit stands", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const sessions = yield* Session.Service
      const failed = yield* record(session.id, ShellID.ToolID, "call_tests", shell(1, "3 fail", "user"))
      const passed = yield* record(session.id, ShellID.ToolID, "call_lint", shell(0, "no problems", "user"))
      yield* goal(session.id, { checks: [failed, passed] })
      // rewrite both parts in storage: the failed run to exit 0, the passing one's output
      for (const [id, output] of [
        [failed, "15 pass"],
        [passed, "no problems at all, and 99 pass"],
      ] as const) {
        const part = (yield* sessions.messages({ sessionID: session.id }))
          .flatMap((message) => message.parts)
          .find((item) => item.id === id)!
        yield* sessions.updatePart({
          ...part,
          state: { ...shell(0, output, "user"), time: { start: 1, end: 2 } },
        } as SessionV1.Part)
      }
      const cited = yield* submit(
        session.id,
        passWith([{ kind: "check", callID: "call_lint", exit: 0, excerpt: "99 pass" }]),
      )
      expect(cited.error).toContain("did not finish")
      expect(cited.error).not.toContain("Verdict recorded")
    }),
  )

  // final re-review, B2-3: a check the host recorded whose part is gone from storage
  it.instance("a recorded check whose part was deleted blocks a PASS", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const sessions = yield* Session.Service
      const listed = yield* record(session.id, ShellID.ToolID, "call_tests", shell(1, "3 fail", "user"))
      yield* goal(session.id, { checks: [listed] })
      for (const message of yield* sessions.messages({ sessionID: session.id }))
        for (const part of message.parts)
          if (part.id === listed)
            yield* sessions.removePart({ sessionID: session.id, messageID: message.info.id, partID: part.id })
      const result = yield* submit(session.id, passWith([capped]))
      expect(result.error).toContain("is gone from the session")
    }),
  )

  it.instance("deleting the parts of rejected submissions does not give the verifier more", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const sessions = yield* Session.Service
      const wrong = passWith([{ ...capped, quote: "LIMIT = 9999" }])
      expect((yield* submit(session.id, wrong)).error).toContain("(2 of 3 submissions left)")
      expect((yield* submit(session.id, wrong)).error).toContain("(1 of 3 submissions left)")
      // erase them from storage, as a worker with storage access could
      for (const message of yield* sessions.messages({ sessionID: session.id }))
        for (const part of message.parts)
          if (part.type === "tool" && part.tool === "verdict")
            yield* sessions.removePart({ sessionID: session.id, messageID: message.info.id, partID: part.id })
      // still the third, final submission: its bad citations are dropped and the PASS
      // they supported is recorded as PARTIAL (before, it would be a first submission)
      expect((yield* submit(session.id, wrong)).output).toContain("Recorded as PARTIAL")
    }),
  )

  it.instance("deleting a recorded verdict's part does not allow a second one", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const sessions = yield* Session.Service
      expect((yield* submit(session.id, passWith([capped]))).error).toBe("")
      for (const message of yield* sessions.messages({ sessionID: session.id }))
        for (const part of message.parts)
          if (part.type === "tool" && part.tool === "verdict")
            yield* sessions.removePart({ sessionID: session.id, messageID: message.info.id, partID: part.id })
      expect((yield* submit(session.id, passWith([capped]))).error).toContain("A verdict is already recorded")
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

  // Snapshot.track() returns undefined when git cannot write a snapshot, so the loop
  // records no base; Snapshot.diff() returns undefined when git cannot read one.
  // Either way nothing can be said about the diff: not "does not touch X".
  withDiff.instance(
    "with no host snapshot a diff citation is unavailable, not absent from the diff",
    () =>
      Effect.gen(function* () {
        yield* setup()
        const cited = passWith([{ kind: "diff", path: "src/budget.ts", excerpt: "+export const LIMIT = 81920" }])
        const unavailable = "no host snapshot for this verification; diff citations are unavailable"
        expect((yield* submit(yield* another(), cited)).error).toContain(unavailable)
        const gone = yield* submit(yield* another({ base: "gone" }), cited)
        expect(gone.error).toContain(unavailable)
        expect(gone.error).not.toContain("does not touch")
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

  // re-review 5 had a revert re-open a verification. The Phase 3 re-review made a
  // recorded verdict final in the host's record: removing its part from storage (a
  // revert, a deleted part) does not allow another one. A verifier session is sealed,
  // so only the host could revert it; to verify again, the host starts a new one.
  it.instance("a verdict stays recorded when its part leaves storage", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      expect((yield* submit(session.id, passWith([capped]))).error).toBe("")
      // (the verdict's part never reached storage, as after a revert)
      expect((yield* submit(session.id, passWith([capped]))).error).toContain("A verdict is already recorded")
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

  // final check: a fork is not the verification it was forked from
  it.instance("a fork carries no metadata.verify, and its copied checks cannot be cited", () =>
    Effect.gen(function* () {
      const { session } = yield* setup()
      const listed = yield* record(session.id, ShellID.ToolID, "call_tests", shell(0, "15 pass", "user"))
      yield* goal(session.id, { criteria: ["the output is capped"], checks: [listed] })
      const sessions = yield* Session.Service
      yield* sessions.setMetadata({
        sessionID: session.id,
        metadata: { ...(yield* sessions.get(session.id)).metadata, goal: { id: "goal_1" }, note: "kept" },
      })
      const forked = yield* sessions.fork({ sessionID: session.id })
      expect(forked.metadata?.verify).toBeUndefined()
      // nor the worker's goal record (§11.8): a fork is a new session, not the loop's
      expect(forked.metadata?.goal).toBeUndefined()
      expect(forked.metadata?.note).toBe("kept")
      const cite = passWith([{ kind: "check", callID: "call_tests", exit: 0, excerpt: "15 pass" }])
      expect((yield* submit(forked.id, cite)).error).toContain("there is no check call_tests in this verification")
    }),
  )
})

// Phase 3 (docs/accuracy-e.md §11.8): a recorded verdict is written onto the worker
// session the verifier checks, in-process: the last verdict and the todos it found
// met, only while the verification's goal is still the worker's active goal.
const loop = Effect.fn("VerdictTest.loop")(function* () {
  const sessions = yield* Session.Service
  const goals = yield* SessionGoal.Service
  const worker = yield* sessions.create({ title: "worker" })
  const started = yield* goals.start(worker.id, { text: "cap the output", criteria: ["the output is capped"] })
  const verifier = () =>
    Effect.gen(function* () {
      const child = yield* sessions.create({ title: "verify", parentID: worker.id })
      yield* sessions.setMetadata({
        sessionID: child.id,
        metadata: { verify: { goal: started.id, criteria: ["the output is capped"] } },
      })
      return child.id
    })
  return { worker: worker.id, goal: started.id, verifier }
})

describe("tool.verdict: the records on the worker session", () => {
  const todos = (status: "met" | "unmet") => [
    { content: "cap the output", status, ...(status === "met" ? { evidence: [capped] } : {}) },
    { content: "write the docs", status: "unmet" },
  ]

  it.instance("a recorded verdict writes the last verdict and the met todos", () =>
    Effect.gen(function* () {
      yield* setup()
      const { worker, verifier } = yield* loop()
      const goals = yield* SessionGoal.Service
      const todo = yield* Todo.Service
      const child = yield* verifier()
      const result = yield* submit(child, { ...passWith([capped]), todos: todos("met") })
      expect(result.error).toBe("")
      const last = (yield* goals.get(worker))?.lastVerdict
      expect(last).toMatchObject({ verdict: "PASS", verifierSessionID: child, unmet: [] })
      expect(last?.at).toBeNumber()
      const verified = yield* todo.verified(worker)
      expect([...verified.keys()]).toEqual([contentKey("cap the output")])
      const [row] = yield* todo.evidence(worker)
      expect(row).toMatchObject({ content: "cap the output", contentKey: contentKey("cap the output") })
      expect(row?.verifierSessionID).toBe(child)
      // the citations that checked out, as the verdict stored them
      expect(row?.evidence).toEqual([expect.objectContaining({ kind: "file", quote: capped.quote })])
    }),
  )

  it.instance("a FAIL lists the criteria it did not find met", () =>
    Effect.gen(function* () {
      yield* setup()
      const { worker, verifier } = yield* loop()
      const result = yield* submit(yield* verifier(), {
        verdict: "FAIL",
        criteria: [{ id: "C1", text: "the output is capped", status: "unmet", evidence: [] }],
        missing: [{ criterion: "C1", need: "a test that caps the output" }],
      })
      expect(result.error).toBe("")
      expect((yield* (yield* SessionGoal.Service).get(worker))?.lastVerdict).toMatchObject({
        verdict: "FAIL",
        unmet: ["the output is capped"],
      })
    }),
  )

  it.instance("a rejected submission writes nothing", () =>
    Effect.gen(function* () {
      yield* setup()
      const { worker, verifier } = yield* loop()
      const wrong = { ...capped, quote: "LIMIT = 9999" }
      const result = yield* submit(yield* verifier(), { ...passWith([wrong]), todos: todos("met") })
      expect(result.error).toContain("The verdict was not accepted")
      expect((yield* (yield* SessionGoal.Service).get(worker))?.lastVerdict).toBeUndefined()
      expect((yield* (yield* Todo.Service).verified(worker)).size).toBe(0)
    }),
  )

  it.instance("a verdict for a goal that was replaced or ended is refused, and nothing is recorded", () =>
    Effect.gen(function* () {
      yield* setup()
      const { worker, goal, verifier } = yield* loop()
      const goals = yield* SessionGoal.Service
      const stale = `this verification is for goal ${goal}, which is no longer the session's goal; the verdict is not recorded`
      const child = yield* verifier()
      yield* goals.start(worker, { text: "a different goal" })
      expect((yield* submit(child, { ...passWith([capped]), todos: todos("met") })).error).toContain(stale)
      expect((yield* goals.get(worker))?.lastVerdict).toBeUndefined()
      expect((yield* (yield* Todo.Service).verified(worker)).size).toBe(0)

      const again = yield* loop()
      const ended = yield* again.verifier()
      yield* goals.end(again.worker)
      const refused = yield* submit(ended, passWith([capped]))
      expect(refused.error).toContain(`this verification is for goal ${again.goal}`)
      expect((yield* goals.get(again.worker))?.lastVerdict).toBeUndefined()
    }),
  )

  // Security review of Phase 3, ruling 1: otherwise a worker could use up the
  // verifier's submissions by replacing the goal while it verifies.
  it.instance("a stale-goal refusal does not use up a submission", () =>
    Effect.gen(function* () {
      yield* setup()
      const { goal, verifier } = yield* loop()
      const child = yield* verifier()
      // three refusals as the session stores them: tool parts in error
      for (let i = 0; i < 3; i++)
        yield* record(child, "verdict", `call_stale_${i}`, {
          status: "error",
          input: {},
          error: `Error: ${SessionGoal.stale(goal)}`,
          time: { start: 1, end: 2 },
        })
      const wrong = { ...capped, quote: "LIMIT = 9999" }
      const result = yield* submit(child, passWith([wrong]))
      expect(result.error).toContain("The verdict was not accepted")
      expect(result.error).toContain(`(2 of 3 submissions left)`)
    }),
  )

  it.instance("the latest verification wins: a later not-met clears the mark", () =>
    Effect.gen(function* () {
      yield* setup()
      const { worker, verifier } = yield* loop()
      const todo = yield* Todo.Service
      expect((yield* submit(yield* verifier(), { ...passWith([capped]), todos: todos("met") })).error).toBe("")
      expect((yield* todo.verified(worker)).has(contentKey("cap the output"))).toBe(true)
      const later = yield* verifier()
      const result = yield* submit(later, {
        verdict: "FAIL",
        criteria: [{ id: "C1", text: "the output is capped", status: "unmet", evidence: [] }],
        missing: [{ criterion: "C1", need: "a test" }],
        todos: todos("unmet"),
      })
      expect(result.error).toBe("")
      expect((yield* todo.verified(worker)).size).toBe(0)
      expect((yield* (yield* SessionGoal.Service).get(worker))?.lastVerdict).toMatchObject({
        verdict: "FAIL",
        verifierSessionID: later,
      })
    }),
  )
})
