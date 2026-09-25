// The goal a goal loop drives a session with, as the host records it
// (docs/accuracy-e.md §11.8). The server takes the snapshot the goal starts from,
// so its hash never goes through a client; every change is appended to the
// goal's history, never rewritten. Only this module writes metadata.goal: the
// API refuses it from clients (Session.ClientMetadata), and its routes take the
// host token (server/host-token.ts).
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createHash } from "crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Identifier } from "@/id/id"
import { Snapshot } from "../snapshot"
import { Checkpoint } from "./checkpoint"
import { SessionMetadataLock } from "./metadata-lock"
import { Session } from "./session"
import type { SessionID } from "./schema"

/** Longest goal text and criterion kept verbatim; a longer one is refused, not cut. */
export const TEXT_MAX = 4_000
export const CRITERIA_MAX = 50
/** Changes kept in the history; older ones are dropped and counted in `elided`. */
export const HISTORY_MAX = 200
/** Goal changes allowed per session in RATE_WINDOW_MS; more are refused (429). */
export const RATE_MAX = 10
export const RATE_WINDOW_MS = 60_000

/** A session changed its goal RATE_MAX times within RATE_WINDOW_MS. */
export class RateLimited extends Schema.TaggedErrorClass<RateLimited>()(
  "GoalRateLimited",
  { message: Schema.String, retryAfterMs: Schema.Number },
  { httpApiStatus: 429 },
) {}

// A criterion is shown on one line (escaped) to the verifier and in the checkpoint:
// line breaks and other control characters are refused, not rewritten.
const Criterion = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(TEXT_MAX),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]*$/),
)

// The goal text may span lines (\n), but holds no other control character (C0, DEL, C1).
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(TEXT_MAX),
  Schema.isPattern(/^[^\u0000-\u0009\u000b-\u001f\u007f-\u009f]*$/),
)

export const Input = Schema.Struct({
  text: Text,
  criteria: Schema.optional(Schema.Array(Criterion).check(Schema.isMaxLength(CRITERIA_MAX))),
})
export type Input = Schema.Schema.Type<typeof Input>

export const Change = Schema.Struct({
  type: Schema.Literals(["set", "replace", "end"]),
  at: Schema.Number,
  /** Made by the process that holds the host token (every change so far). */
  via: Schema.Literal("host"),
  goal: Schema.String,
  /** set and replace: the snapshot that goal starts from (absent when git could not write one). */
  base: Schema.optional(Schema.String),
  /** set and replace: the goal text's hash and length; the full text is kept for the current goal only. */
  sha256: Schema.optional(Schema.String),
  length: Schema.optional(Schema.Number),
})
export type Change = Schema.Schema.Type<typeof Change>

export const LastVerdict = Schema.Struct({
  verdict: Schema.Literals(["PASS", "PARTIAL", "FAIL"]),
  at: Schema.Number,
  verifierSessionID: Schema.String,
  unmet: Schema.Array(Schema.String),
})
export type LastVerdict = Schema.Schema.Type<typeof LastVerdict>

export const Record = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  criteria: Schema.optional(Schema.Array(Schema.String)),
  base: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  /** The first goal this session was ever given, and its base: later bases are compared with it. */
  origin: Schema.Struct({ goal: Schema.String, base: Schema.optional(Schema.String) }),
  /** Goals set or replaced on a base other than origin.base. */
  baseChanges: Schema.optional(Schema.Number),
  history: Schema.Array(Change),
  /** Oldest changes dropped from `history` past HISTORY_MAX; it only grows. */
  elided: Schema.optional(Schema.Number),
  lastVerdict: Schema.optional(LastVerdict),
  /**
   * The session's task, as the user wrote it (its first user message), recorded when
   * the first goal started; the checkpoint shows this one, not the message, which a
   * client could otherwise rewrite. Kept across later goals.
   */
  task: Schema.optional(Schema.Struct({ text: Schema.String, sha256: Schema.String })),
})
export type Record = Schema.Schema.Type<typeof Record>

export const Started = Schema.Struct({
  id: Schema.String,
  base: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
})
export type Started = Schema.Schema.Type<typeof Started>

const decode = Schema.decodeUnknownOption(Record)

/** The session's goal record, active or ended; undefined when it has none (or it is unreadable). */
export function read(metadata: Session.Info["metadata"]): Record | undefined {
  return Option.getOrUndefined(decode(metadata?.goal))
}

/** The history with `change` appended, the oldest dropped past HISTORY_MAX and counted. */
function append(record: Record | undefined, change: Change): Pick<Record, "history" | "elided"> {
  const all = [...(record?.history ?? []), change]
  const dropped = Math.max(0, all.length - HISTORY_MAX)
  const elided = (record?.elided ?? 0) + dropped
  return { history: all.slice(dropped), ...(elided > 0 ? { elided } : {}) }
}

/** Refuses a change when the session made RATE_MAX in the last RATE_WINDOW_MS (from its own history). */
function limit(record: Record | undefined, now: number) {
  const recent = (record?.history ?? []).filter((change) => change.at > now - RATE_WINDOW_MS)
  if (recent.length < RATE_MAX) return Effect.void
  const retryAfterMs = Math.max(0, recent[recent.length - RATE_MAX]!.at + RATE_WINDOW_MS - now)
  return Effect.fail(
    new RateLimited({
      message: `the goal of this session changed ${RATE_MAX} times in the last minute; try again in ${Math.ceil(retryAfterMs / 1000)} s`,
      retryAfterMs,
    }),
  )
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Record | undefined, Session.NotFound>
  /** Sets the goal, or replaces the active one; takes the snapshot it starts from. */
  readonly start: (sessionID: SessionID, input: Input) => Effect.Effect<Started, Session.NotFound | RateLimited>
  /** Ends the active goal; undefined when there is none. */
  readonly end: (sessionID: SessionID) => Effect.Effect<Record | undefined, Session.NotFound | RateLimited>
  /**
   * Runs `record` and stores its verdict as the goal's last one, while `goal` is the
   * session's active goal, under the goal's lock (so the goal cannot be replaced or
   * ended in between). False, and `record` is not run, when it is not.
   */
  readonly verdict: <E, R>(
    sessionID: SessionID,
    goal: string,
    record: Effect.Effect<LastVerdict, E, R>,
  ) => Effect.Effect<boolean, E | Session.NotFound, R>
}

/** The error a verdict for a goal that is no longer the session's gets (§11.8). */
export function stale(goal: string) {
  return `this verification is for goal ${goal}, which is no longer the session's goal; the verdict is not recorded`
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service

    const write = Effect.fnUntraced(function* (session: Session.Info, goal: Record) {
      yield* sessions.setMetadata({ sessionID: session.id, metadata: { ...session.metadata, goal } })
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      return read((yield* sessions.get(sessionID)).metadata)
    })

    const start = Effect.fn("SessionGoal.start")(function* (sessionID: SessionID, input: Input) {
      return yield* SessionMetadataLock.withLock(
        sessionID,
        Effect.gen(function* () {
          const previous = read((yield* sessions.get(sessionID)).metadata)
          yield* limit(previous, Date.now())
          const base = yield* snapshot.track()
          // read again after the snapshot: metadata is written whole
          const session = yield* sessions.get(sessionID)
          const now = Date.now()
          const id = Identifier.create("goal", "ascending")
          const type = previous && previous.endedAt === undefined ? "replace" : "set"
          const origin = previous?.origin ?? { goal: id, ...(base ? { base } : {}) }
          const firstMessage = previous?.task
            ? undefined
            : Checkpoint.task(yield* sessions.messages({ sessionID }))
          const task =
            previous?.task ??
            (firstMessage ? { text: firstMessage, sha256: createHash("sha256").update(firstMessage).digest("hex") } : undefined)
          const baseChanges = (previous?.baseChanges ?? 0) + (previous && base !== origin.base ? 1 : 0)
          yield* write(session, {
            id,
            text: input.text,
            ...(input.criteria ? { criteria: [...input.criteria] } : {}),
            ...(base ? { base } : {}),
            startedAt: now,
            origin,
            ...(task ? { task } : {}),
            ...(baseChanges > 0 ? { baseChanges } : {}),
            ...append(previous, {
              type,
              at: now,
              via: "host",
              goal: id,
              ...(base ? { base } : {}),
              sha256: createHash("sha256").update(input.text).digest("hex"),
              length: input.text.length,
            }),
          })
          return { id, base: base ?? null, startedAt: now }
        }),
      )
    })

    const end = Effect.fn("SessionGoal.end")(function* (sessionID: SessionID) {
      return yield* SessionMetadataLock.withLock(
        sessionID,
        Effect.gen(function* () {
          const session = yield* sessions.get(sessionID)
          const current = read(session.metadata)
          if (!current || current.endedAt !== undefined) return undefined
          const now = Date.now()
          yield* limit(current, now)
          const ended: Record = {
            ...current,
            endedAt: now,
            ...append(current, { type: "end", at: now, via: "host", goal: current.id }),
          }
          yield* write(session, ended)
          return ended
        }),
      )
    })

    const verdict = <E, R>(sessionID: SessionID, goal: string, record: Effect.Effect<LastVerdict, E, R>) =>
      SessionMetadataLock.withLock(
        sessionID,
        Effect.gen(function* () {
          const current = read((yield* sessions.get(sessionID)).metadata)
          if (!current || current.id !== goal || current.endedAt !== undefined) return false
          const last = yield* record
          // read again: record may have taken a while, and metadata is replaced whole
          const session = yield* sessions.get(sessionID)
          yield* write(session, { ...(read(session.metadata) ?? current), lastVerdict: last })
          return true
        }),
      ).pipe(Effect.withSpan("SessionGoal.verdict"))

    return Service.of({ get, start, end, verdict })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Snapshot.node],
})

export * as SessionGoal from "./goal"
