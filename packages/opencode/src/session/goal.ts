// The goal a goal loop drives a session with, as the host records it
// (docs/accuracy-e.md §11.8). The server takes the snapshot the goal starts from,
// so its hash never goes through a client; every change is appended to the
// goal's history, never rewritten. Only this module writes metadata.goal: the
// API refuses it from clients (Session.ClientMetadata).
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { Identifier } from "@/id/id"
import { Snapshot } from "../snapshot"
import { Session } from "./session"
import type { SessionID } from "./schema"

/** Longest goal text and criterion kept verbatim; a longer one is refused, not cut. */
export const TEXT_MAX = 4_000
export const CRITERIA_MAX = 50

export const Input = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(TEXT_MAX)),
  criteria: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(TEXT_MAX))).check(
      Schema.isMaxLength(CRITERIA_MAX),
    ),
  ),
})
export type Input = Schema.Schema.Type<typeof Input>

export const Change = Schema.Struct({
  type: Schema.Literals(["set", "replace", "end"]),
  at: Schema.Number,
  /** Every change so far is made through the goal endpoint (ruling 5, §11.8). */
  via: Schema.Literal("api"),
  goal: Schema.String,
  text: Schema.optional(Schema.String),
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
  history: Schema.Array(Change),
  lastVerdict: Schema.optional(LastVerdict),
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

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Record | undefined, Session.NotFound>
  /** Sets the goal, or replaces the active one; takes the snapshot it starts from. */
  readonly start: (sessionID: SessionID, input: Input) => Effect.Effect<Started, Session.NotFound>
  /** Ends the active goal; undefined when there is none. */
  readonly end: (sessionID: SessionID) => Effect.Effect<Record | undefined, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const locks = new Map<string, Semaphore.Semaphore>()
    const locked = <A, E, R>(sessionID: SessionID, fx: Effect.Effect<A, E, R>) => {
      const lock = locks.get(sessionID) ?? Semaphore.makeUnsafe(1)
      locks.set(sessionID, lock)
      return lock.withPermits(1)(fx)
    }

    const write = Effect.fnUntraced(function* (session: Session.Info, goal: Record) {
      yield* sessions.setMetadata({ sessionID: session.id, metadata: { ...session.metadata, goal } })
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      return read((yield* sessions.get(sessionID)).metadata)
    })

    const start = Effect.fn("SessionGoal.start")(function* (sessionID: SessionID, input: Input) {
      return yield* locked(
        sessionID,
        Effect.gen(function* () {
          const session = yield* sessions.get(sessionID)
          const previous = read(session.metadata)
          const base = yield* snapshot.track()
          const now = Date.now()
          const id = Identifier.create("goal", "ascending")
          const type = previous && previous.endedAt === undefined ? "replace" : "set"
          yield* write(session, {
            id,
            text: input.text,
            ...(input.criteria ? { criteria: [...input.criteria] } : {}),
            ...(base ? { base } : {}),
            startedAt: now,
            history: [...(previous?.history ?? []), { type, at: now, via: "api", goal: id, text: input.text }],
          })
          return { id, base: base ?? null, startedAt: now }
        }),
      )
    })

    const end = Effect.fn("SessionGoal.end")(function* (sessionID: SessionID) {
      return yield* locked(
        sessionID,
        Effect.gen(function* () {
          const session = yield* sessions.get(sessionID)
          const current = read(session.metadata)
          if (!current || current.endedAt !== undefined) return undefined
          const now = Date.now()
          const ended: Record = {
            ...current,
            endedAt: now,
            history: [...current.history, { type: "end", at: now, via: "api", goal: current.id }],
          }
          yield* write(session, ended)
          return ended
        }),
      )
    })

    return Service.of({ get, start, end })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, Snapshot.node],
})

export * as SessionGoal from "./goal"
