import { createRoot, createSignal, type Accessor } from "solid-js"
import { usePlatform } from "@/context/platform"
import { applyEvent } from "./panel-view"
import type { GoalLoopPlatform, GoalLoopState } from "./types"

// One app-wide view of every session's goal loop, fed by the desktop shell's
// list and its events. The goal panel and the session-list badge both read it,
// so a page never needs its own subscription to find out which loop is whose.

export type GoalLoopsStore = {
  states: Accessor<GoalLoopState[]>
  dismiss(sessionID: string): void
}

const stores = new WeakMap<GoalLoopPlatform, GoalLoopsStore>()

function create(api: GoalLoopPlatform): GoalLoopsStore {
  return createRoot(() => {
    const [map, setMap] = createSignal(new Map<string, GoalLoopState>())
    api.subscribe((event) => setMap((current) => applyEvent(current, event)))
    void Promise.resolve()
      .then(() => api.list?.())
      .then((list) => {
        if (!list) return
        setMap((current) => {
          const next = new Map(current)
          // events that arrived while the list was loading are newer; keep them
          for (const state of list) if (state.sessionID && !next.has(state.sessionID)) next.set(state.sessionID, state)
          return next
        })
      })
      .catch(() => undefined)
    return {
      states: () => [...map().values()],
      dismiss(sessionID: string) {
        setMap((current) => {
          if (current.get(sessionID)?.status === "running") return current
          const next = new Map(current)
          next.delete(sessionID)
          return next
        })
        void Promise.resolve(api.dismiss?.(sessionID)).catch(() => undefined)
      },
    }
  })
}

/** The shared store, or undefined where there is no goal loop (the web app). */
export function useGoalLoops(): GoalLoopsStore | undefined {
  const api = usePlatform().goalLoop
  if (!api) return undefined
  const existing = stores.get(api)
  if (existing) return existing
  const store = create(api)
  stores.set(api, store)
  return store
}
