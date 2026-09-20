/**
 * Waking a session with a harness note.
 *
 * Modeled on MiniMax Code (MIT), whose local runtime steers a
 * `<background-task-finished>` message into the owning conversation so the
 * agent resumes without polling.
 *
 * The note itself is built by `session/harness-note.ts`, the shared helper, so
 * a background task's result and an accuracy reminder are the same `reminder`
 * part and every consumer that switches on part type already handles both.
 * Building it there also means the note carries the real user message's agent,
 * model, format and system prompt, and that appending it writes nothing to the
 * session row: the settings the user is on cannot be changed by a message they
 * did not send.
 *
 * What is left here is delivery: persist the note, then run the session loop
 * and check it was answered. Running the loop separately closes the race where
 * the note lands between a running loop's final history read and the runner
 * going idle — the loop's top-of-loop check then sees a user message with no
 * answering assistant and keeps going, where a joined run would have finished
 * and left the note unanswered until the user's next turn.
 */
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { HarnessNote } from "../session/harness-note"
import type { Session } from "../session/session"
import type { SessionID } from "../session/schema"

export interface WakeOps {
  loop?(sessionID: SessionID): Effect.Effect<SessionV1.WithParts>
}

const ATTEMPTS = 3

function answered(result: SessionV1.WithParts | undefined, messageID: string) {
  if (!result) return false
  return result.info.role === "assistant" && result.info.parentID === messageID
}

/**
 * Appends a harness note to a session and makes sure a turn answers it.
 * Returns the id of the note's message, or undefined when the session has no
 * user message to carry one.
 */
export const deliver = Effect.fn("SessionWake.deliver")(function* (input: {
  sessions: Session.Interface
  ops: WakeOps
  sessionID: SessionID
  kind: string
  label?: string
  text: string
}) {
  const messages = yield* input.sessions
    .messages({ sessionID: input.sessionID })
    .pipe(Effect.catchCause(() => Effect.succeed([])))
  const user = HarnessNote.lastRealUser(messages)
  if (!user || user.info.role !== "user") return
  const built = HarnessNote.build({
    user: user.info,
    kind: input.kind,
    ...(input.label ? { label: input.label } : {}),
    text: input.text,
  })
  yield* input.sessions.updateMessage(built.info).pipe(Effect.catchCause(() => Effect.void))
  yield* input.sessions.updatePart(built.part).pipe(Effect.catchCause(() => Effect.void))

  const loop = input.ops.loop
  if (!loop) return built.info.id
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = yield* loop(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (answered(result, built.info.id)) break
  }
  return built.info.id
})

export * as SessionWake from "./wake"
