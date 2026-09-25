// What the host records about a verifier session (docs/accuracy-e.md §11.8, re-review
// of Phase 3): the result of each check it ran, and the verdict tool's submissions.
// The verdict tool reads these, not the session's message storage, which anything
// with storage access could rewrite: a check's part could be changed to exit 0, and
// the parts of rejected submissions or a recorded verdict could be deleted.
//
// Kept in metadata.verifyRecord, a host-only key (Session.HOST_METADATA): clients can
// neither write it nor erase it. Written under the session's metadata lock only.
// Its presence seals the session: its writing and steering routes take the host token.
import { createHash } from "crypto"
import { Effect, Option, Schema } from "effect"
import { SessionMetadataLock } from "./metadata-lock"
import type { Session } from "./session"
import type { SessionID } from "./schema"

export const Check = Schema.Struct({
  /** The exit code; null when the command did not report one (aborted). */
  exit: Schema.NullOr(Schema.Number),
  /** The output's sha256 and length: the part's output is evidence only while they match. */
  sha256: Schema.String,
  length: Schema.Number,
})
export type Check = Schema.Schema.Type<typeof Check>

export const Record = Schema.Struct({
  /** The checks the host ran in this session, by part id. */
  checks: Schema.Record(Schema.String, Check),
  /** Submissions counted against the verifier's limit (a stale-goal refusal is not one). */
  submissions: Schema.Number,
  /** Whether a verdict was recorded: then it is final. */
  recorded: Schema.optional(Schema.Boolean),
})
export type Record = Schema.Schema.Type<typeof Record>

export const EMPTY: Record = { checks: {}, submissions: 0 }

const decode = Schema.decodeUnknownOption(Record)

export function read(metadata: Session.Info["metadata"]): Record | undefined {
  return Option.getOrUndefined(decode(metadata?.verifyRecord))
}

export function digest(output: string) {
  return { sha256: createHash("sha256").update(output).digest("hex"), length: output.length }
}

/** Whether `output` is what the host recorded for the check. */
export function matches(check: Check, output: string) {
  const actual = digest(output)
  return actual.length === check.length && actual.sha256 === check.sha256
}

/** Applies `change` to the session's record (created when absent), under the metadata lock. */
export function update(
  sessions: Pick<Session.Interface, "get" | "setMetadata">,
  sessionID: SessionID,
  change: (current: Record) => Record,
) {
  return SessionMetadataLock.withLock(
    sessionID,
    Effect.gen(function* () {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const next = change(read(session.metadata) ?? EMPTY)
      yield* sessions.setMetadata({ sessionID, metadata: { ...session.metadata, verifyRecord: next } })
      return next
    }),
  )
}

export * as VerifyRecord from "./verify-record"
