// Effective settings for the accuracy harness (autonomy prompt, runaway guard,
// todo completion reminders). Every flag defaults to on; `experimental.accuracy`
// in the config turns them off or retunes them.

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { DEFAULT_THRESHOLD } from "./runaway-guard"
import { DEFAULT_INTERVAL } from "./todo-reminder"

export interface Settings {
  readonly autonomyPrompt: boolean
  readonly runawayGuard: boolean
  readonly runawayGuardThreshold: number
  readonly todoReminder: boolean
  readonly todoReminderInterval: number
}

export function settings(config: ConfigV1.Info): Settings {
  const accuracy = config.experimental?.accuracy ?? {}
  return {
    autonomyPrompt: accuracy.autonomy_prompt !== false,
    runawayGuard: accuracy.runaway_guard !== false,
    runawayGuardThreshold: Math.max(2, Math.trunc(accuracy.runaway_guard_threshold ?? DEFAULT_THRESHOLD)),
    todoReminder: accuracy.todo_reminder !== false,
    todoReminderInterval: Math.max(1, Math.trunc(accuracy.todo_reminder_interval ?? DEFAULT_INTERVAL)),
  }
}

/**
 * Whether this turn runs without anyone to answer a question.
 *
 * Two signals, either is enough:
 *  - the caller said so (`autonomous: true` on prompt/prompt_async, carried on
 *    the user message) — the desktop goal loop sets this, because its prompts
 *    run inside a client that does have a question tool but no human;
 *  - the `question` tool is not available for this step at all, which is the
 *    case for `opencode run` without --interactive, for clients that do not
 *    expose it, and for subagents.
 */
export function autonomous(input: { autonomous?: boolean; questionAvailable: boolean }) {
  return input.autonomous === true || !input.questionAvailable
}

export * as Accuracy from "./accuracy"
