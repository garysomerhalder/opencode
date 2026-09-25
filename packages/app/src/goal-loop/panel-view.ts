import type { GoalLoopEvent, GoalLoopState } from "./types"

// What the goal panel above a session shows. Pure: the component renders this
// and nothing else decides which loop belongs to which page.

export type GoalPanelTone = "info" | "success" | "error" | "warning" | "neutral"

export type GoalPanelView =
  | { kind: "idle" }
  | {
      kind: "loop"
      state: GoalLoopState
      running: boolean
      /** An i18n key. */
      label: string
      tone: GoalPanelTone
      /** The goal as given, never shortened here; the component clamps it visually. */
      goal: string
      iteration: { current: number; max: number | null }
      /** Milliseconds since the loop last polled the session, or null when unknown. */
      checkedAgo: number | null
      /** Milliseconds since the loop last prompted the session, or null when unknown. */
      promptedAgo: number | null
      reason: string | null
    }

function describe(state: GoalLoopState): { label: string; tone: GoalPanelTone } {
  switch (state.status) {
    case "running":
      if (state.phase === "verifying") return { label: "goalPanel.state.verifying", tone: "info" }
      return state.phase === "waiting"
        ? { label: "goalPanel.state.waiting", tone: "info" }
        : { label: "goalPanel.state.turn", tone: "info" }
    // the worker said it was done, but no independent check found it so
    case "unverified":
      return { label: "goalPanel.state.unverified", tone: "error" }
    case "completed":
      return { label: "goalPanel.state.completed", tone: "success" }
    case "failed":
      return { label: "goalPanel.state.failed", tone: "error" }
    case "capped":
      return { label: "goalPanel.state.capped", tone: "neutral" }
    case "stopped":
      return { label: "goalPanel.state.stopped", tone: "neutral" }
  }
}

const since = (now: number, at: number | null | undefined) => (typeof at === "number" ? Math.max(0, now - at) : null)

/** The loop of the page's own session, and only that one. */
export function goalPanelView(input: {
  states: ReadonlyArray<GoalLoopState>
  sessionID: string | undefined
  now: number
}): GoalPanelView {
  if (!input.sessionID) return { kind: "idle" }
  const state = input.states.find((item) => item.sessionID === input.sessionID)
  if (!state) return { kind: "idle" }
  const running = state.status === "running"
  return {
    kind: "loop",
    state,
    running,
    ...describe(state),
    goal: state.goal,
    iteration: { current: state.iteration, max: state.maxIterations },
    checkedAgo: running ? since(input.now, state.checkedAt) : null,
    promptedAgo: running ? since(input.now, state.promptedAt) : null,
    reason: state.reason,
  }
}

/**
 * Folds one loop event into the per-session records. A session has at most one
 * record; an event from an older loop of the same session (a late "stopped"
 * after a new loop started) does not replace the newer one.
 */
export function applyEvent(map: ReadonlyMap<string, GoalLoopState>, event: GoalLoopEvent) {
  const sessionID = event.state.sessionID
  if (!sessionID) return map as Map<string, GoalLoopState>
  const current = map.get(sessionID)
  if (current && current.id !== event.state.id && current.updatedAt > event.state.updatedAt) {
    return map as Map<string, GoalLoopState>
  }
  const next = new Map(map)
  next.set(sessionID, event.state)
  return next
}

/** Sessions that have a loop running right now, for the badge in the session list. */
export function runningSessions(states: Iterable<GoalLoopState>) {
  const set = new Set<string>()
  for (const state of states) if (state.status === "running" && state.sessionID) set.add(state.sessionID)
  return set
}

/** "3s", "2m", "2h", "3d": the unit a glance needs. */
export function ago(ms: number | null): string | null {
  if (ms === null) return null
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
