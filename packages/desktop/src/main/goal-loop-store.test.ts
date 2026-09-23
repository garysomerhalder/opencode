import { describe, expect, test } from "bun:test"
import type { GoalLoopState } from "./goal-loop"
import { readLast, saveLast, saveState, takeOrphans, type KeyValueStore } from "./goal-loop-store"

function memory(initial: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    delete: (key) => {
      delete data[key]
    },
  }
}

const running = (sessionID: string): GoalLoopState => ({
  id: `loop_${sessionID}`,
  status: "running",
  directory: "C:/work",
  goal: `goal of ${sessionID}`,
  ticket: null,
  sessionID,
  serverURL: null,
  iteration: 1,
  maxIterations: null,
  completionMarker: "GOAL_COMPLETE",
  reason: null,
  updatedAt: 1,
})

describe("goal loop store", () => {
  test("keeps one running record per session and drops ended ones", () => {
    const store = memory()
    saveState(store, "ses_a", running("ses_a"))
    saveState(store, "ses_b", running("ses_b"))
    saveState(store, "ses_a", { ...running("ses_a"), status: "completed" })
    expect(Object.keys(store.data["states"] as object)).toEqual(["ses_b"])
    saveState(store, "ses_b", null)
    expect(store.data["states"]).toEqual({})
  })

  test("takes the legacy single record and the per-session ones as orphans, then clears them", () => {
    const store = memory({ state: running("ses_old"), states: { ses_a: running("ses_a") } })
    const orphans = takeOrphans(store)
    expect(orphans.map((state) => state.sessionID).sort()).toEqual(["ses_a", "ses_old"])
    expect(store.data["state"]).toBeUndefined()
    expect(store.data["states"]).toBeUndefined()
    expect(takeOrphans(store)).toEqual([])
  })

  test("ignores records that are not running or have no session", () => {
    const store = memory({ state: { ...running("ses_x"), status: "stopped" }, states: { bad: { id: 1 } } })
    expect(takeOrphans(store)).toEqual([])
  })

  test("the last input is per session and never another session's", () => {
    const store = memory()
    saveLast(store, "ses_a", { directory: "C:/a", goal: "goal A", sessionID: "ses_a" })
    saveLast(store, "ses_b", { directory: "C:/b", goal: "goal B", sessionID: "ses_b" })
    expect(readLast(store, "ses_a")?.goal).toBe("goal A")
    expect(readLast(store, "ses_c")).toBeNull()
    // without a session: the newest input of any session
    expect(readLast(store)?.goal).toBe("goal B")
  })
})
