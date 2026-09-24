// The verifier's verdict tool (accuracy E, docs/accuracy-e.md §2). Offered to
// the built-in verifier only. It validates before it accepts: every citation
// is checked against the host's records (Verdict.validate), a rejected verdict
// comes back as a tool error with the reasons, and after the third submission
// what survives the check is stored. A recorded verdict is final.

import { Effect, Schema } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { Session } from "@/session/session"
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
    path: Schema.String,
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

export const VerdictTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service | Session.Service | Snapshot.Service>(
  ID,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const earlier = ctx.messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool" && part.tool === ID && part.callID !== ctx.callID)
          if (earlier.some((part) => part.type === "tool" && part.state.status === "completed"))
            throw new Error("A verdict is already recorded for this verification. Stop here.")
          const submission = earlier.filter((part) => part.type === "tool" && part.state.status === "error").length + 1
          const final = submission >= MAX_SUBMISSIONS

          const files = new Map<string, string | undefined>()
          for (const item of [
            ...params.criteria.flatMap((criterion) => criterion.evidence),
            ...(params.todos ?? []).flatMap((todo) => todo.evidence ?? []),
          ]) {
            if (item.kind !== "file" || files.has(item.path)) continue
            const target = yield* citable(ctx, item.path)
            files.set(
              item.path,
              target === undefined ? undefined : yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => undefined)),
            )
          }
          // The loop records the goal on the session it verifies in (phase 4):
          // the diff's base snapshot and the criteria the user declared.
          const verify = (yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)).metadata?.verify
          const base = verify?.base
          const diff = typeof base === "string" ? yield* snapshot.diff(base) : undefined
          const declared: unknown = verify?.criteria
          const world: Verdict.World = {
            file: (file) => files.get(file),
            checks: checks(ctx.messages),
            diff: diff || undefined,
            criteria: Array.isArray(declared) ? declared.filter((item) => typeof item === "string") : undefined,
          }

          const result = Verdict.validate(params, world, { final })
          if (!result.verdict) {
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
          const dropped = result.errors.length > 0 ? ` Citations that did not check out were dropped.` : ""
          return {
            title: stored.verdict,
            output: result.downgraded
              ? `Recorded as PARTIAL: some criteria you marked met had no evidence that checks out.${dropped} Stop here.`
              : `Verdict recorded: ${stored.verdict}.${dropped} Stop here.`,
            metadata: { verdict: stored, downgraded: result.downgraded, errors: result.errors, submission },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

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
  const named = path.resolve(instance.directory, file)
  const target = CanonicalPath.resolve(named)
  const inside = containsPath(target, instance) || FSUtil.contains(CanonicalPath.resolve(TRUNCATION_DIR), target)
  if (!inside) return undefined
  if (!(yield* Tool.readable(ctx, instance.worktree, named, "content"))) return undefined
  return target
})

/**
 * The checks run for this verification: shell parts the host ran (ranBy
 * "user", which no tool sets), so a model's own shell call is never one.
 */
function checks(messages: Tool.Context["messages"]): Verdict.Check[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.tool !== ShellID.ToolID || part.state.status !== "completed") return []
      if (part.state.metadata?.ranBy !== "user") return []
      const exit = part.state.metadata?.exit
      return [{ callID: part.callID, exit: typeof exit === "number" ? exit : undefined, output: part.state.output }]
    }),
  )
}
