import type { ShellTask } from "@opencode-ai/sdk/v2/client"

// What the background tasks dock shows. Pure: the dock renders rows from this,
// and the event fold lives here too so it is tested with the wording.

/** How long an ended task stays in the dock. */
export const RECENT_MS = 10 * 60 * 1000

/** Folds one shell.task.updated event into a session's task list, in start order. */
export function upsertTask(list: ReadonlyArray<ShellTask>, task: ShellTask): ShellTask[] {
  return [...list.filter((item) => item.id !== task.id), task].toSorted((a, b) => a.startedAt - b.startedAt)
}

/** Running tasks, plus tasks that ended in the last RECENT_MS. */
export function visibleTasks(list: ReadonlyArray<ShellTask>, now: number): ShellTask[] {
  return list.filter((task) => task.status === "running" || now - (task.endedAt ?? now) <= RECENT_MS)
}

export type TaskRowView = {
  running: boolean
  canStop: boolean
  /** i18n keys */
  status: string
  wake: string | undefined
  elapsedMs: number
  tail: string | undefined
}

export function taskRowView(task: ShellTask, now: number): TaskRowView {
  const running = task.status === "running"
  return {
    running,
    canStop: running,
    status: status(task),
    wake: wake(task),
    elapsedMs: Math.max(0, (running ? now : (task.endedAt ?? now)) - task.startedAt),
    tail: task.tail,
  }
}

function status(task: ShellTask) {
  if (task.status === "running") return "taskDock.status.running"
  if (task.status === "exited") return task.exitCode === 0 ? "taskDock.status.exited" : "taskDock.status.failed"
  if (task.status === "stopped") return "taskDock.status.stopped"
  if (task.status === "cancelled") return "taskDock.status.cancelled"
  // timed_out: the idle reaper is the one users need to be told about
  return task.reason === "idle" ? "taskDock.status.reaped" : "taskDock.status.timedOut"
}

function wake(task: ShellTask) {
  if (!task.wake || task.wake === "none") return undefined
  if (task.wake === "suppressed") return task.reason === "idle" ? "taskDock.wake.reaped" : "taskDock.wake.stopped"
  return `taskDock.wake.${task.wake}`
}

/** "45s", "6m 10s", "2h 5m": elapsed time at a glance. */
export function duration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
