import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { and, asc, eq } from "drizzle-orm"
import { TodoEvidenceTable, TodoTable } from "@opencode-ai/core/session/sql"
import { contentKey } from "./checkpoint"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionTodo } from "@opencode-ai/schema/session-todo"

export const Info = SessionTodo.Info
export type Info = SessionTodo.Info

export const Event = SessionTodo.Event

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: ReadonlyArray<Info> }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
  /**
   * When the list was last written. `update` replaces every row, so the rows'
   * creation time is the time of the last write. Undefined for no list.
   */
  readonly written: (sessionID: SessionID) => Effect.Effect<number | undefined>
  /**
   * Records what a verification found (accuracy E, docs/accuracy-e.md §11.8): an
   * item met with evidence is marked verified, replacing an earlier mark; any
   * other item it judged loses its mark. Called by the verdict tool only.
   */
  readonly verify: (input: {
    sessionID: SessionID
    verifierSessionID: SessionID
    todos: ReadonlyArray<{ content: string; met: boolean; evidence: ReadonlyArray<unknown> }>
  }) => Effect.Effect<void>
  /** The session's verified items: contentKey(content) -> when it was verified. */
  readonly verified: (sessionID: SessionID) => Effect.Effect<Map<string, number>>
  /** The session's verified items with their evidence, oldest first. */
  readonly evidence: (sessionID: SessionID) => Effect.Effect<Evidence[]>
}

export const Evidence = Schema.Struct({
  content: Schema.String,
  contentKey: Schema.String,
  verifierSessionID: Schema.String,
  evidence: Schema.Array(Schema.Unknown),
  time: Schema.Number,
})
export type Evidence = Schema.Schema.Type<typeof Evidence>

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: ReadonlyArray<Info> }) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return
            yield* tx
              .insert(TodoTable)
              .values(
                input.todos.map((todo, position) => ({
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .orderBy(asc(TodoTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    const written = Effect.fn("Todo.written")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select({ time: TodoTable.time_created })
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      return rows.length === 0 ? undefined : Math.max(...rows.map((row) => row.time))
    })

    const verify = Effect.fn("Todo.verify")(function* (input: Parameters<Interface["verify"]>[0]) {
      if (input.todos.length === 0) return
      const now = Date.now()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            for (const todo of input.todos) {
              const key = contentKey(todo.content)
              const where = and(eq(TodoEvidenceTable.session_id, input.sessionID), eq(TodoEvidenceTable.content_key, key))
              if (!todo.met || todo.evidence.length === 0) {
                yield* tx.delete(TodoEvidenceTable).where(where).run()
                continue
              }
              const row = {
                content: todo.content,
                verifier_session_id: input.verifierSessionID,
                evidence: [...todo.evidence],
                time_created: now,
                time_updated: now,
              }
              yield* tx
                .insert(TodoEvidenceTable)
                .values({ session_id: input.sessionID, content_key: key, ...row })
                .onConflictDoUpdate({ target: [TodoEvidenceTable.session_id, TodoEvidenceTable.content_key], set: row })
                .run()
            }
          }),
        )
        .pipe(Effect.orDie)
    })

    const rows = (sessionID: SessionID) =>
      db
        .select()
        .from(TodoEvidenceTable)
        .where(eq(TodoEvidenceTable.session_id, sessionID))
        .orderBy(asc(TodoEvidenceTable.time_created))
        .all()
        .pipe(Effect.orDie)

    const verified = Effect.fn("Todo.verified")(function* (sessionID: SessionID) {
      return new Map((yield* rows(sessionID)).map((row) => [row.content_key, row.time_created]))
    })

    const evidence = Effect.fn("Todo.evidence")(function* (sessionID: SessionID) {
      return (yield* rows(sessionID)).map(
        (row): Evidence => ({
          content: row.content,
          contentKey: row.content_key,
          verifierSessionID: row.verifier_session_id,
          evidence: row.evidence,
          time: row.time_created,
        }),
      )
    })

    return Service.of({ update, get, written, verify, verified, evidence })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Database.node] })

export * as Todo from "./todo"
