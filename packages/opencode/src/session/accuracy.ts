// Effective settings for the accuracy harness (autonomy prompt, runaway guard,
// todo completion reminders). Every flag defaults to on; `experimental.accuracy`
// in the config turns them off or retunes them.

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { DEFAULT_THRESHOLD } from "./runaway-guard"
import { DEFAULT_INTERVAL } from "./todo-reminder"

export interface Settings {
  readonly autonomyPrompt: boolean
  readonly autonomyWhenNoQuestionTool: boolean
  readonly runawayGuard: boolean
  readonly runawayGuardThreshold: number
  readonly todoReminder: boolean
  readonly todoReminderInterval: number
  readonly outputReceipts: boolean
}

export function settings(config: ConfigV1.Info): Settings {
  const accuracy = config.experimental?.accuracy ?? {}
  return {
    autonomyPrompt: accuracy.autonomy_prompt !== false,
    autonomyWhenNoQuestionTool: accuracy.autonomy_when_no_question_tool === true,
    runawayGuard: accuracy.runaway_guard !== false,
    runawayGuardThreshold: Math.max(2, Math.trunc(accuracy.runaway_guard_threshold ?? DEFAULT_THRESHOLD)),
    todoReminder: accuracy.todo_reminder !== false,
    todoReminderInterval: Math.max(1, Math.trunc(accuracy.todo_reminder_interval ?? DEFAULT_INTERVAL)),
    outputReceipts: accuracy.output_receipts !== false,
  }
}

/**
 * Whether this turn runs without anyone to answer a question.
 *
 * The signal that counts is the caller saying so: `autonomous: true` on
 * prompt/prompt_async, carried on the user message. The desktop goal loop sets
 * it, because its prompts run inside a client that does have a question tool
 * but no human.
 *
 * A missing `question` tool is NOT treated as "nobody is watching" by default:
 * a user who denies the tool to stop being interrupted is still at the keyboard,
 * and should not silently be told never to ask. Opting in with
 * `experimental.accuracy.autonomy_when_no_question_tool` turns the absence of
 * the tool into the second signal — useful for scripted `opencode run` fleets,
 * where nothing can answer anyway.
 */
export function autonomous(input: {
  autonomous?: boolean
  questionAvailable: boolean
  inferFromMissingQuestionTool?: boolean
}) {
  if (input.autonomous === true) return true
  return input.inferFromMissingQuestionTool === true && !input.questionAvailable
}

export * as Accuracy from "./accuracy"
