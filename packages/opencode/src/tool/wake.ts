/**
 * Waking a session with a synthetic message.
 *
 * Modeled on MiniMax Code (MIT), whose local runtime steers a
 * `<background-task-finished>` message into the owning conversation so the
 * agent resumes without polling.
 *
 * The message is created first (`noReply`), then the session loop is started.
 * Starting the loop separately closes the race where the message lands between
 * the running loop's final history read and the runner going idle: the loop's
 * top-of-loop check then sees a user message with no answering assistant and
 * keeps running. A plain `SessionPrompt.prompt` would join the finishing run
 * and leave the message unanswered until the next user turn.
 */
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionID } from "../session/schema"

export interface WakeOps {
  prompt(input: {
    sessionID: SessionID
    agent?: string
    variant?: string
    noReply?: boolean
    parts: { type: "text"; text: string; synthetic?: boolean }[]
  }): Effect.Effect<SessionV1.WithParts>
  loop?(sessionID: SessionID): Effect.Effect<SessionV1.WithParts>
}

const ATTEMPTS = 3

function answered(result: SessionV1.WithParts | undefined, messageID: string) {
  if (!result) return false
  return result.info.role === "assistant" && result.info.parentID === messageID
}

/**
 * Appends a synthetic user message and makes sure a turn answers it. Returns
 * the id of the created message, or undefined when the session refused it.
 */
export const deliver = Effect.fn("SessionWake.deliver")(function* (input: {
  ops: WakeOps
  sessionID: SessionID
  agent?: string
  variant?: string
  text: string
}) {
  const base = {
    sessionID: input.sessionID,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
    parts: [{ type: "text" as const, text: input.text, synthetic: true }],
  }
  const loop = input.ops.loop
  const message = yield* input.ops
    .prompt(loop ? { ...base, noReply: true } : base)
    .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  if (!message || !loop) return message?.info.id
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = yield* loop(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (answered(result, message.info.id)) break
  }
  return message.info.id
})

export * as SessionWake from "./wake"
