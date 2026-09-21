import type { GoalLoop, GoalLoopDeps, GoalLoopEvent, GoalLoopStartInput, GoalLoopState } from "./goal-loop"

// One goal loop per session. Each loop is an ordinary createGoalLoop instance;
// this only routes calls to the right one and keeps per-session records.
//
// Before this, the app held a single loop (`active` in goal-loop.ts), and the
// strip above every session showed that loop, or the last goal anyone started,
// whichever session you were looking at. It also meant a second session could
// not have a loop at all.

export const DEFAULT_MAX_RUNNING = 4

export type GoalLoopsDeps = {
  /** Builds one loop. The manager supplies the hooks; everything else is the caller's. */
  create: (hooks: Pick<GoalLoopDeps, "persist" | "onEvent" | "onProgress">) => GoalLoop
  /** Saves (or, with null, deletes) the running record of one session. */
  persist?: (sessionID: string, state: GoalLoopState | null) => void
  /** Remembers the input a session's loop was started with. */
  persistLast?: (sessionID: string, input: GoalLoopStartInput) => void
  onEvent?: (event: GoalLoopEvent) => void
  maxRunning?: number
}

export function createGoalLoops(deps: GoalLoopsDeps) {
  const maxRunning = deps.maxRunning ?? DEFAULT_MAX_RUNNING
  // Latest known state per session: running, or ended and not yet dismissed.
  const states = new Map<string, GoalLoopState>()
  const loops = new Map<string, GoalLoop>()
  const starting = new Set<string>()

  const running = () => [...states.values()].filter((state) => state.status === "running")

  function record(state: GoalLoopState) {
    if (state.sessionID) states.set(state.sessionID, state)
  }

  function spawn() {
    // A loop does not know its session until start resolves (it may create
    // one), so remember the last session id each instance reported.
    let sessionID: string | null = null
    return deps.create({
      persist: (state) => {
        if (state?.sessionID) sessionID = state.sessionID
        if (!sessionID) return
        deps.persist?.(sessionID, state)
      },
      onEvent: (event) => {
        record(event.state)
        deps.onEvent?.(event)
      },
      onProgress: (state) => {
        record(state)
        deps.onEvent?.({ loopID: state.id, type: "progress", state })
      },
    })
  }

  async function start(input: GoalLoopStartInput): Promise<GoalLoopState> {
    const target = input.sessionID
    if (target && (states.get(target)?.status === "running" || starting.has(target))) {
      throw new Error("a goal loop is already running in this session")
    }
    if (running().length + starting.size >= maxRunning) {
      throw new Error(`${maxRunning} goal loops are already running; stop one first`)
    }
    const key = target ?? `pending:${starting.size}:${Date.now()}`
    starting.add(key)
    try {
      const loop = spawn()
      const state = await loop.start(input)
      if (state.sessionID) {
        loops.set(state.sessionID, loop)
        record(state)
        deps.persistLast?.(state.sessionID, { ...input, sessionID: state.sessionID })
      }
      return state
    } finally {
      starting.delete(key)
    }
  }

  function target(sessionID?: string): string | null {
    if (sessionID) return sessionID
    const live = running()
    if (live.length === 0) return null
    if (live.length > 1) throw new Error("several goal loops are running; say which session to stop")
    return live[0]!.sessionID
  }

  async function stop(sessionID?: string): Promise<GoalLoopState | null> {
    const id = target(sessionID)
    if (!id) return null
    const loop = loops.get(id)
    if (!loop || states.get(id)?.status !== "running") return states.get(id) ?? null
    await loop.stop()
    return states.get(id) ?? null
  }

  function status(sessionID?: string): GoalLoopState | null {
    if (sessionID) return states.get(sessionID) ?? null
    return running().reduce<GoalLoopState | null>(
      (newest, state) => (!newest || state.updatedAt >= newest.updatedAt ? state : newest),
      null,
    )
  }

  function list(): GoalLoopState[] {
    return [...states.values()]
  }

  function dismiss(sessionID: string) {
    if (states.get(sessionID)?.status === "running") return
    states.delete(sessionID)
    loops.delete(sessionID)
  }

  function adoptOrphans(records: ReadonlyArray<GoalLoopState>) {
    for (const orphan of records) {
      if (orphan.status !== "running" || !orphan.sessionID) continue
      if (states.get(orphan.sessionID)?.status === "running") continue
      spawn().adoptOrphan(orphan)
    }
  }

  function markInterrupted(reason: string) {
    for (const state of running()) {
      if (state.sessionID) loops.get(state.sessionID)?.markInterrupted(reason)
    }
  }

  return { start, stop, status, list, dismiss, adoptOrphans, markInterrupted }
}

export type GoalLoops = ReturnType<typeof createGoalLoops>
