// The verifier's verdict tool (accuracy E, docs/accuracy-e.md §2). Offered to
// the built-in verifier only. It validates before it accepts: every citation
// is checked against the host's records (Verdict.validate), a rejected verdict
// comes back as a tool error with the reasons, and after the third submission
// what survives the check is stored. A recorded verdict is final.

import { Effect, Option, Schema, Semaphore } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { containsPath } from "@/project/instance-context"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import type { SessionID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { VerifyRecord } from "@/session/verify-record"
import { VerifierPin } from "@/session/verifier-pin"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { CanonicalPath } from "@/util/canonical-path"
import { Snapshot } from "@/snapshot"
import { Verdict } from "@/session/verdict"
import { ShellID } from "./shell/id"
import { TRUNCATION_DIR } from "./truncation-dir"

export const ID = "verdict"
export const MAX_SUBMISSIONS = 3

const Evidence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String.annotate({ description: "The file, relative to the workspace root" }),
    lines: Schema.Tuple([Schema.Number, Schema.Number]).annotate({
      description: "First and last line of the quote, 1-based, inclusive",
    }),
    quote: Schema.String.annotate({ description: "Text copied from those lines" }),
  }),
  Schema.Struct({
    kind: Schema.Literal("check"),
    callID: Schema.String.annotate({ description: "The call id of a check run for this verification" }),
    exit: Schema.Number.annotate({ description: "Its exit code" }),
    excerpt: Schema.String.annotate({ description: "Text copied from its output" }),
  }),
  Schema.Struct({
    kind: Schema.Literal("diff"),
    path: Schema.String.annotate({ description: "The file the diff changes, relative to the workspace root" }),
    excerpt: Schema.String.annotate({ description: "Text copied from the diff for that file" }),
  }),
])

export const Parameters = Schema.Struct({
  verdict: Schema.Literals(["PASS", "FAIL", "PARTIAL"]),
  criteria: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ description: "A short id, e.g. C1" }),
      text: Schema.String,
      status: Schema.Literals(["met", "unmet", "unknown"]),
      evidence: Schema.Array(Evidence),
    }),
  ),
  missing: Schema.Array(
    Schema.Struct({
      criterion: Schema.String.annotate({ description: "A criterion id" }),
      need: Schema.String.annotate({ description: "What evidence would settle it" }),
    }),
  ),
  todos: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.String,
        status: Schema.Literals(["met", "unmet", "unknown", "obsolete"]),
        evidence: Schema.optional(Schema.Array(Evidence)),
      }),
    ),
  ),
})

export type Metadata = {
  verdict?: Verdict.Verdict
  downgraded?: boolean
  errors?: string[]
  submission?: number
}

const DESCRIPTION = [
  "Submit your verdict on the goal. Call it once, at the end, and stop after it is recorded.",
  "",
  "Judge every acceptance criterion as met, unmet or unknown. Judge every criterion the user declared, with its text as written; you may add your own. A met criterion must cite evidence, and every citation is checked:",
  '- file: a quote copied from the file at the cited lines ({ kind: "file", path, lines: [first, last], quote }); only a file you are allowed to read;',
  '- check: a check run for this verification, by call id, with its exit code and an excerpt of its output ({ kind: "check", callID, exit, excerpt });',
  '- diff: an excerpt of the diff for a file it touches ({ kind: "diff", path, excerpt }).',
  "A todo you mark met needs evidence too, cited the same way.",
  "PASS means every criterion is met. For each criterion that is not met, say in `missing` what evidence would settle it.",
  "A PASS cannot stand while any check run for this verification failed or was aborted, whether you cite it or not: a check succeeds only with exit 0. You never declare what exit code a check should have.",
  `A verdict whose citations do not check out is returned with the reasons, and you can submit ${MAX_SUBMISSIONS} times. After that, citations that do not check out are dropped, and a PASS they supported is recorded as PARTIAL.`,
].join("\n")

export const VerdictTool = Tool.define<
  typeof Parameters,
  Metadata,
  | FSUtil.Service
  | Session.Service
  | Snapshot.Service
  | Database.Service
  | SessionGoal.Service
  | Todo.Service
  | Agent.Service
  | Provider.Service
>(
  ID,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const database = yield* Database.Service
    const goals = yield* SessionGoal.Service
    const todo = yield* Todo.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service

    /** Whether `goal` is the active goal of the worker session (none: not). */
    const activeGoal = (worker: SessionID | undefined, goal: string) =>
      worker === undefined
        ? Effect.succeed(false)
        : goals.get(worker).pipe(
            Effect.map((record) => record?.id === goal && record.endedAt === undefined),
            Effect.catchTag("NotFoundError", () => Effect.succeed(false)),
          )

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // the registry offers it to the verifier only; refuse anyone else anyway
          if (ctx.agent !== Permission.VERIFIER)
            throw new Error("A verdict can be submitted by only the goal verifier.")
          // one submission at a time per session: parallel calls in one step are
          // taken in turn, and once one is recorded the rest are refused
          return yield* submitting.withPermits(1)(submit(params, ctx))
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>

    function submit(params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) {
      return Effect.gen(function* () {
          // The session's whole history, from storage: the model's context is
          // filtered after a compaction, and must not hide a failed check or an
          // earlier submission.
          const messages = yield* MessageV2.stream(ctx.sessionID).pipe(
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          )
          const history = messages.flatMap((message) => message.parts)
          const earlier = history.filter(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === ID && part.callID !== ctx.callID,
          )
          const step = current(ctx.sessionID, ctx.messageID)
          // The loop records the goal on the session it verifies in (phase 4,
          // docs/accuracy-e.md §11.5): the diff's base snapshot, the criteria the
          // user declared, and the part ids of the checks it ran.
          const verifying = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          const verify = verifying.metadata?.verify
          // The host's record of this session (§11.8): the checks it ran, the submissions
          // counted and whether a verdict was recorded. Storage can be rewritten or have
          // parts deleted; this cannot, so it decides.
          const hostRecord = VerifyRecord.read(verifying.metadata) ?? VerifyRecord.EMPTY
          if (step.recorded || hostRecord.recorded || earlier.some((part) => part.state.status === "completed"))
            throw new Error("A verdict is already recorded for this verification. Stop here.")
          // The model this verifier was pinned to at creation (§11.8): if config now
          // resolves it differently (another model, provider, endpoint or provider config),
          // the one answering may not be the verifier, and nothing is recorded. The step's
          // own model must be the pinned one too.
          const pinned = decodePin(verify?.pin)
          if (pinned) {
            const live = yield* VerifierPin.resolve.pipe(
              Effect.provideService(Agent.Service, agents),
              Effect.provideService(Provider.Service, provider),
            )
            const reason = VerifierPin.differs(pinned, live) ?? stepModel(messages, ctx.messageID, pinned)
            if (reason) throw new Error(VerifierPin.refused(reason))
          }
          // The worker's goal this verification is for (§11.8). A verdict for a goal
          // the worker no longer has is refused before anything is checked.
          const target = typeof verify?.goal === "string" ? verify.goal : undefined
          const worker = verifying.parentID
          if (target !== undefined && !(yield* activeGoal(worker, target))) throw new Error(SessionGoal.stale(target))
          // A stale-goal refusal is not a submission: otherwise the worker could use
          // up the verifier's submissions by replacing the goal. Only that exact error
          // for this verification's goal is skipped, so text a model gets echoed into
          // another error cannot pass for one.
          const staleError = target === undefined ? undefined : SessionGoal.stale(target)
          const refusedAsStale = (error: string) =>
            staleError !== undefined && (error === staleError || error === `Error: ${staleError}`)
          const inStorage = new Set(earlier.map((part) => part.callID))
          const fromStorage =
            earlier.filter((part) => part.state.status === "error" && !refusedAsStale(part.state.error)).length +
            [...step.rejected].filter((callID) => !inStorage.has(callID)).length
          // the host's count wins over storage, where the parts of rejected submissions
          // could have been deleted; storage covers submissions before the record existed
          const submission = Math.max(fromStorage, hostRecord.submissions) + 1
          const final = submission >= MAX_SUBMISSIONS

          const instance = yield* InstanceState.context
          // one spelling per file for every citation: relative to the worktree
          const cited = normalizePaths(params, instance.directory, instance.worktree)
          const files = new Map<string, string | undefined>()
          for (const item of [
            ...cited.criteria.flatMap((criterion) => criterion.evidence),
            ...(cited.todos ?? []).flatMap((todo) => todo.evidence ?? []),
          ]) {
            if (item.kind !== "file" || files.has(item.path)) continue
            const target = yield* citable(ctx, item.path)
            files.set(
              item.path,
              target === undefined ? undefined : yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => undefined)),
            )
          }
          const base = verify?.base
          // undefined: no base recorded (Snapshot.track() could not write one) or git
          // cannot diff against it. Citations are then unavailable, not "not in the diff".
          const raw = typeof base === "string" && base ? yield* snapshot.diff(base) : undefined
          const diff = raw === undefined ? undefined : yield* readableDiff(ctx, raw)
          const declared: unknown = verify?.criteria
          const listed: unknown = verify?.checks
          // The checks the loop ran: verify.checks when it lists them, otherwise every
          // check the host ran in this session (Session.createVerifier writes verify at
          // birth, before any check runs; §11.5)
          const runs = checks(
            history,
            Array.isArray(listed) ? listed.filter((id) => typeof id === "string") : Object.keys(hostRecord.checks),
            hostRecord,
          )
          const world: Verdict.World = {
            file: (file) => files.get(file),
            checks: runs.listed,
            unlisted: runs.unlisted,
            diff,
            criteria: Array.isArray(declared) ? declared.filter((item) => typeof item === "string") : undefined,
          }

          const result = Verdict.validate(cited, world, { final })
          if (!result.verdict) step.rejected.add(ctx.callID ?? `call_${submission}`)
          if (!result.verdict) {
            yield* VerifyRecord.update(sessions, ctx.sessionID, (record) => ({ ...record, submissions: submission }))
            const reasons = result.errors.map((error) => `- ${error}`).join("\n")
            if (final)
              throw new Error(
                `No verdict could be recorded after ${MAX_SUBMISSIONS} submissions:\n${reasons}\nThe verification failed.`,
              )
            throw new Error(
              `The verdict was not accepted:\n${reasons}\nFix it and submit again (${MAX_SUBMISSIONS - submission} of ${MAX_SUBMISSIONS} submissions left).`,
            )
          }
          const stored = result.verdict
          // The worker's records, written in-process under the goal's lock: the last
          // verdict and the todos this verification judged. Refused like above if the
          // goal was replaced or ended while the citations were checked.
          if (target !== undefined && worker !== undefined) {
            const written = yield* goals
              .verdict(
                worker,
                target,
                Effect.gen(function* () {
                  yield* todo.verify({
                    sessionID: worker,
                    verifierSessionID: ctx.sessionID,
                    todos: (stored.todos ?? []).map((item) => ({
                      content: item.content,
                      met: item.status === "met",
                      evidence: item.evidence ?? [],
                    })),
                  })
                  return lastVerdict(stored, ctx.sessionID)
                }),
              )
              .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(false)))
            if (!written) throw new Error(SessionGoal.stale(target))
          }
          yield* VerifyRecord.update(sessions, ctx.sessionID, (record) => ({
            ...record,
            submissions: submission,
            recorded: true,
          }))
          step.recorded = true
          const dropped = result.errors.length > 0 ? ` Citations that did not check out were dropped.` : ""
          return {
            title: stored.verdict,
            output: result.downgraded
              ? `Recorded as PARTIAL: some criteria you marked met had no evidence that checks out.${dropped} Stop here.`
              : `Verdict recorded: ${stored.verdict}.${dropped} Stop here.`,
            metadata: { verdict: stored, downgraded: result.downgraded, errors: result.errors, submission },
          }
      })
    }
  }),
)

// Submissions are taken one at a time (they are rare and quick), so parallel calls
// in one step see each other.
const submitting = Semaphore.makeUnsafe(1)

// What storage cannot show yet: a tool part is written after its call returns, so
// for the calls of the step in progress (one assistant message) the tool remembers
// whether one recorded a verdict and which were rejected. Only that step's: a later
// step reads storage alone, so after a revert removes a recorded verdict the
// session can submit again. At most one entry per session, and the oldest are
// dropped past STEPS, so the map does not grow with every session ever verified.
const STEPS = 256
const steps = new Map<string, { messageID: string; recorded: boolean; rejected: Set<string> }>()

function current(sessionID: string, messageID: string) {
  const hit = steps.get(sessionID)
  if (hit && hit.messageID === messageID) return hit
  const next = { messageID, recorded: false, rejected: new Set<string>() }
  steps.delete(sessionID)
  steps.set(sessionID, next)
  for (const key of steps.keys()) {
    if (steps.size <= STEPS) break
    steps.delete(key)
  }
  return next
}

const decodePin = (value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(VerifierPin.Pin)(value))

/** Why the step answering is not on the pinned model; undefined when it is (or its message is not stored yet). */
function stepModel(messages: ReadonlyArray<SessionV1.WithParts>, messageID: string, pinned: VerifierPin.Pin) {
  const step = messages.find((message) => message.info.id === messageID)?.info
  if (!step || step.role !== "assistant") return undefined
  if (String(step.providerID) === pinned.providerID && String(step.modelID) === pinned.modelID) return undefined
  return `this step ran on ${step.providerID}/${step.modelID}, not ${pinned.providerID}/${pinned.modelID}`
}

const UNMET_MAX = 20
const UNMET_BYTES = 500

/** The last verdict as the worker's goal record keeps it: the criteria not met, capped. */
function lastVerdict(stored: Verdict.Verdict, verifierSessionID: string): SessionGoal.LastVerdict {
  const unmet = stored.criteria.filter((criterion) => criterion.status !== "met").map((criterion) => criterion.text)
  const kept = unmet.slice(0, UNMET_MAX).map((text) => (text.length > UNMET_BYTES ? `${text.slice(0, UNMET_BYTES)}…` : text))
  return {
    verdict: stored.verdict,
    at: Date.now(),
    verifierSessionID,
    unmet: unmet.length > UNMET_MAX ? [...kept, `(+${unmet.length - UNMET_MAX} more)`] : kept,
  }
}

/** The citations with each file path relative to the worktree, with forward slashes. */
function normalizePaths(params: Schema.Schema.Type<typeof Parameters>, directory: string, worktree: string) {
  const relative = (file: string) => path.relative(worktree, path.resolve(directory, file)).replaceAll("\\", "/")
  const evidence = (item: Verdict.Evidence): Verdict.Evidence =>
    item.kind === "check" ? item : { ...item, path: relative(item.path) }
  return {
    ...params,
    criteria: params.criteria.map((criterion) => ({ ...criterion, evidence: criterion.evidence.map(evidence) })),
    ...(params.todos
      ? { todos: params.todos.map((todo) => ({ ...todo, evidence: todo.evidence?.map(evidence) })) }
      : {}),
  }
}

/**
 * The host's diff without the sections for files the agent may not read, old or
 * new path: a citation of one reads as "does not touch", the same answer whatever
 * the excerpt, so the diff cannot be used to probe a file's content.
 */
const readableDiff = Effect.fnUntraced(function* (ctx: Tool.Context, diff: string) {
  const instance = yield* InstanceState.context
  const kept: string[] = []
  for (const section of Verdict.sections(diff)) {
    let readable = true
    for (const file of section.paths)
      if (!(yield* Tool.readable(ctx, instance.worktree, path.resolve(instance.worktree, file), "content")))
        readable = false
    if (readable) kept.push(section.text)
  }
  return kept.join("")
})

/**
 * The file a citation may be checked against, as the system resolves it, or
 * undefined. It must be inside the workspace (or the archived tool output), and
 * the agent's own read rules, the session's and the lock included, must let it
 * read the content without asking, as its read tool would: otherwise "the
 * quote is not in the file" would answer questions about a file it may not
 * read. Missing and not citable look the same to the verifier.
 */
const citable = Effect.fnUntraced(function* (ctx: Tool.Context, file: string) {
  const instance = yield* InstanceState.context
  const named = path.resolve(instance.worktree, file)
  const target = CanonicalPath.resolve(named)
  // the workspace, or this session's own archived tool output
  const archive = CanonicalPath.resolve(path.join(TRUNCATION_DIR, ctx.sessionID))
  const inside = containsPath(target, instance) || FSUtil.contains(archive, target)
  if (!inside) return undefined
  if (!(yield* Tool.readable(ctx, instance.worktree, named, "content"))) return undefined
  return target
})

/**
 * The commands the host ran in this session: shell parts with ranBy "user"
 * (set from the part's start; no tool sets it), so a model's own shell call is
 * never one. Those whose part ids the loop listed (verify.checks) are the
 * citable checks; the rest are unlisted, never evidence but still able to block
 * a PASS. A part that did not complete (running, or orphaned by a crash, or an
 * error) has no exit code, which blocks a PASS.
 */
function checks(parts: SessionV1.Part[], listed: string[], record: VerifyRecord.Record) {
  const runs = parts.flatMap((part) => {
    if (part.type !== "tool" || part.tool !== ShellID.ToolID) return []
    const metadata = "metadata" in part.state ? part.state.metadata : undefined
    if (metadata?.ranBy !== "user") return []
    const output = part.state.status === "completed" ? part.state.output : ""
    // The exit is the host's record of the run (§11.8), never the part's metadata:
    // a listed check counts only while its output is what the host recorded. A run
    // with no record, or whose part changed after it ran, reads as not finished:
    // it cannot be cited, and it blocks a PASS.
    const host = record.checks[part.id]
    const intact = part.state.status === "completed" && host !== undefined && VerifyRecord.matches(host, output)
    const exit = intact ? (host.exit ?? undefined) : undefined
    return [{ id: part.id, intact, check: { callID: part.callID, exit, output } }]
  })
  // A check the host recorded whose part is gone from storage (deleted, or its message
  // was): its outcome is unknown, so it blocks a PASS like one that did not finish.
  const stored = new Set<string>(runs.map((run) => run.id))
  const gone = Object.keys(record.checks)
    .filter((id) => !stored.has(id))
    .map((id) => ({ callID: `${id} (its part is gone from the session)`, exit: undefined, output: "" }))
  return {
    listed: runs.filter((run) => run.intact && listed.includes(run.id)).map((run) => run.check),
    unlisted: [...runs.filter((run) => !run.intact || !listed.includes(run.id)).map((run) => run.check), ...gone],
  }
}
