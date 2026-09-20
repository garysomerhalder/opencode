// Task-completion reminders for sessions with unfinished todos.
//
// Adapted from MiniMax Code (MIT) — packages/agent-modules/system-reminder
// (todo-state.ts, the <task-completion-reminder> block). The interval gate and
// the "updating the list does not complete the work" framing are theirs; the
// state lives per turn here instead of in a module-level session map.

import type { SessionTodo } from "@opencode-ai/schema/session-todo"

export const DEFAULT_INTERVAL = 5

export interface Summary {
  readonly total: number
  readonly active: number
  readonly completed: number
  readonly cancelled: number
}

export interface Reminder {
  readonly kind: "periodic" | "stop"
  readonly text: string
  readonly log: { kind: "periodic" | "stop"; active: number; total: number }
}

export interface State {
  interval: number
  lastStep: number
  stopped: boolean
}

export function create(input?: { interval?: number }): State {
  return { interval: Math.max(1, Math.trunc(input?.interval ?? DEFAULT_INTERVAL)), lastStep: 0, stopped: false }
}

export function summarize(todos: ReadonlyArray<SessionTodo.Info>): Summary {
  let completed = 0
  let cancelled = 0
  let active = 0
  for (const todo of todos) {
    if (todo.status === "completed") completed += 1
    else if (todo.status === "cancelled") cancelled += 1
    else active += 1
  }
  return { total: todos.length, active, completed, cancelled }
}

/** Every `interval` steps while todos are pending or in progress. */
export function periodic(state: State, summary: Summary, step: number): Reminder | undefined {
  if (summary.active <= 0) return undefined
  if (step - state.lastStep < state.interval) return undefined
  state.lastStep = step
  return {
    kind: "periodic",
    text: text(summary, false),
    log: { kind: "periodic", active: summary.active, total: summary.total },
  }
}

/** Once per turn, when the model stops while todos are still open. */
export function onStop(state: State, summary: Summary): Reminder | undefined {
  if (summary.active <= 0) return undefined
  if (state.stopped) return undefined
  state.stopped = true
  return { kind: "stop", text: text(summary, true), log: { kind: "stop", active: summary.active, total: summary.total } }
}

function text(summary: Summary, stopped: boolean) {
  const head = stopped
    ? `You stopped with ${summary.active} of ${summary.total} todos still open ` +
      `(${summary.completed} completed, ${summary.cancelled} cancelled).`
    : `You still have ${summary.active} of ${summary.total} todos open ` +
      `(${summary.completed} completed, ${summary.cancelled} cancelled).`
  const body = stopped
    ? `Either finish the remaining work now, or update the list: mark what is really done as completed and what is no ` +
      `longer needed as cancelled. Updating the list does not complete the work. If something cannot be finished, say ` +
      `so plainly and explain why, rather than leaving it silently open.`
    : `Keep the list honest as you go: mark finished work completed, obsolete work cancelled, and do not present the ` +
      `task as complete while items are still pending or in progress.`
  return `<system-reminder>\n[task completion] ${head} ${body}\n` + `</system-reminder>`
}

export * as TodoReminder from "./todo-reminder"
