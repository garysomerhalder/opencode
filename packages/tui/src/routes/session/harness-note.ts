// Harness notes: messages the server injects into a turn that is already
// running (runaway-guard nudges, task-completion reminders, background-task
// wakes). They ride on a user message but carry a `reminder` part instead of
// text, so anything that reads the user's own text ignores them already.
//
// What still needs to know about them is anything that picks "a user message":
// undo and redo must step over a note, or the revert boundary lands on the
// reminder and keeps the prompt and its edits.

import type { Part } from "@opencode-ai/sdk/v2"

export function isNote(parts: Part[] | undefined): boolean {
  return parts !== undefined && parts.length > 0 && parts.every((part) => part.type === "reminder")
}

/** The newest message the user actually sent, ignoring harness notes. */
export function lastUser<T extends { id: string; role: string }>(
  messages: T[],
  parts: (id: string) => Part[] | undefined,
): T | undefined {
  return messages.findLast((message) => message.role === "user" && !isNote(parts(message.id)))
}

/** The oldest message the user actually sent after `messageID`. */
export function nextUser<T extends { id: string; role: string }>(
  messages: T[],
  messageID: string,
  parts: (id: string) => Part[] | undefined,
): T | undefined {
  return messages.find((message) => message.role === "user" && message.id > messageID && !isNote(parts(message.id)))
}

export * as HarnessNote from "./harness-note"
