import type { GoalLoopStartInput, GoalLoopState } from "./goal-loop"
import { GOAL_LOOP_LAST_KEY, GOAL_LOOP_LASTS_KEY, GOAL_LOOP_STATE_KEY, GOAL_LOOP_STATES_KEY } from "./store-keys"

// Per-session persistence for the goal loops, over any key-value store with the
// electron-store shape. Kept apart from index.ts so it can be tested directly.

export type KeyValueStore = {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  delete: (key: string) => void
}

function isRunningRecord(value: unknown): value is GoalLoopState {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<GoalLoopState>
  return record.status === "running" && typeof record.id === "string" && typeof record.sessionID === "string"
}

function isStartInput(value: unknown): value is GoalLoopStartInput {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  const directory = record["directory"]
  const goal = record["goal"]
  return (
    typeof directory === "string" && directory.trim().length > 0 && typeof goal === "string" && goal.trim().length > 0
  )
}

function map(store: KeyValueStore, key: string): Record<string, unknown> {
  const value = store.get(key)
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {}
}

/**
 * Every loop record a previous run left marked running: the per-session map,
 * plus the single record the one-loop app wrote. All of them are orphans (the
 * process that drove them is gone), so the records are cleared once read.
 */
export function takeOrphans(store: KeyValueStore): GoalLoopState[] {
  const bySession = new Map<string, GoalLoopState>()
  const legacy = store.get(GOAL_LOOP_STATE_KEY)
  if (isRunningRecord(legacy)) bySession.set(legacy.sessionID!, legacy)
  for (const value of Object.values(map(store, GOAL_LOOP_STATES_KEY))) {
    if (isRunningRecord(value)) bySession.set(value.sessionID!, value)
  }
  store.delete(GOAL_LOOP_STATE_KEY)
  store.delete(GOAL_LOOP_STATES_KEY)
  return [...bySession.values()]
}

export function saveState(store: KeyValueStore, sessionID: string, state: GoalLoopState | null) {
  const states = map(store, GOAL_LOOP_STATES_KEY)
  if (state && state.status === "running") states[sessionID] = state
  else delete states[sessionID]
  store.set(GOAL_LOOP_STATES_KEY, states)
}

export function saveLast(store: KeyValueStore, sessionID: string, input: GoalLoopStartInput) {
  const lasts = map(store, GOAL_LOOP_LASTS_KEY)
  lasts[sessionID] = input
  store.set(GOAL_LOOP_LASTS_KEY, lasts)
  // The newest input of any session, for starting a loop in a new session.
  store.set(GOAL_LOOP_LAST_KEY, input)
}

/**
 * The input `sessionID`'s loop was last started with. Never another session's:
 * prefilling one session's goal on another session's page is the bug this
 * replaced. Without a session id: the newest input of any session.
 */
export function readLast(store: KeyValueStore, sessionID?: string): GoalLoopStartInput | null {
  const value = sessionID ? map(store, GOAL_LOOP_LASTS_KEY)[sessionID] : store.get(GOAL_LOOP_LAST_KEY)
  return isStartInput(value) ? value : null
}
