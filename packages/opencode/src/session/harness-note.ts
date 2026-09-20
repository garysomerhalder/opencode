// Harness notes: messages the harness injects into a turn that is already
// running — a runaway-guard nudge, a task-completion reminder, a background
// task announcing itself. They ride on a user message so the model reads them
// as user-role content, but the user did not send them.
//
// The carrier is a `reminder` part, not a text part with a flag, so every
// consumer that switches on part type gets one explicit arm: model conversion
// renders it, renderers show it as a system note, and anything that reads the
// user's own text ignores it without knowing it exists. This mirrors the
// `compaction` part, which is why compaction never had this class of bug.
//
// Shared: the accuracy reminders and the background-task wake both build their
// message here, so the consumer work stays in one place.

import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID } from "./schema"

export const TYPE = "reminder"

export function isNotePart(part: SessionV1.Part): part is SessionV1.ReminderPart {
  return part.type === TYPE
}

export function isNote(message: { info: SessionV1.Info; parts: SessionV1.Part[] } | undefined): boolean {
  if (!message || message.info.role !== "user") return false
  return message.parts.length > 0 && message.parts.every(isNotePart)
}

/** Which reminder this is: "runaway_guard", "todo_continue", "wake", … */
export function kind(parts: ReadonlyArray<SessionV1.Part>): string | undefined {
  return parts.find(isNotePart)?.kind
}

/** The newest message the user actually sent, skipping harness notes. */
export function lastRealUser<T extends { info: SessionV1.Info; parts: SessionV1.Part[] }>(
  messages: ReadonlyArray<T>,
): T | undefined {
  return messages.findLast((message) => message.info.role === "user" && !isNote(message))
}

/**
 * Build the message and part for a note. The caller persists them, which keeps
 * this usable from anywhere that already has a Session service — the accuracy
 * loop writes them mid-turn, a background task writes them on completion.
 *
 * Every field of the turn's user message is carried over (agent, model, format,
 * system, tools, `autonomous`), so the step that reads the note runs with the
 * same settings as the prompt it belongs to.
 */
export function build(input: {
  user: SessionV1.User
  kind: string
  text: string
  label?: string
  metadata?: Record<string, unknown>
}): { info: SessionV1.User; part: SessionV1.ReminderPart } {
  const info: SessionV1.User = {
    ...input.user,
    id: MessageID.ascending(),
    time: { created: Date.now() },
  }
  const now = Date.now()
  return {
    info,
    part: {
      id: PartID.ascending(),
      messageID: info.id,
      sessionID: info.sessionID,
      type: TYPE,
      kind: input.kind,
      text: input.text,
      ...(input.label ? { label: input.label } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      time: { start: now, end: now },
    },
  }
}

export * as HarnessNote from "./harness-note"
