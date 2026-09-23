// Keeps the local server (the sidecar) running.
//
// On 9/21 the sidecar crashed (0xC0000005 inside @parcel/watcher's native addon)
// and nothing restarted it: the window stayed up with no server behind it, and
// every Muse on this machine stopped. The supervisor restarts a sidecar that
// exits on its own, with a backoff, and gives up after too many crashes in a
// short window, reporting "failed" instead of looping. Each state change is
// reported, so the app can show it and server.json can be rewritten.
//
// Free of electron imports: the process is behind `start`, so this is tested
// with a fake child.

export type SidecarConnection = { url: string; username: string; password: string }

export type StartedSidecar = {
  connection: SidecarConnection
  /** Resolves with the exit code when the process ends, for any reason. */
  exited: Promise<number>
  stop: () => Promise<void>
}

export type SidecarStatus = "starting" | "running" | "restarting" | "failed" | "stopped"

export type SidecarState = {
  status: SidecarStatus
  connection?: SidecarConnection
  /** Restarts since the app started (not counting the first start). */
  restarts: number
  lastExit?: { code: number; at: number }
  /** When the next restart attempt runs, while restarting. */
  nextAt?: number
  error?: string
}

export type SupervisorPolicy = {
  /** Wait before the 1st, 2nd, ... restart; the last value repeats. */
  delays: number[]
  /** This many crashes within windowMs stops the restarts. */
  maxCrashes: number
  windowMs: number
}

export const DEFAULT_POLICY: SupervisorPolicy = {
  delays: [1000, 2000, 5000, 10_000],
  maxCrashes: 5,
  windowMs: 10 * 60 * 1000,
}

export function createSidecarSupervisor(deps: {
  /** Starts the process; `previous` is the last connection, to reuse its port and credentials. */
  start: (previous: SidecarConnection | undefined) => Promise<StartedSidecar>
  onState?: (state: SidecarState) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  policy?: SupervisorPolicy
}) {
  const policy = deps.policy ?? DEFAULT_POLICY
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let state: SidecarState = { status: "stopped", restarts: 0 }
  let current: StartedSidecar | undefined
  let stopping = false
  // crash times inside the window, oldest first
  let crashes: number[] = []
  // restarts since the last manual start, for the backoff schedule
  let streak = 0

  const set = (next: Partial<SidecarState> & { status: SidecarStatus }) => {
    state = { ...state, ...next }
    if (next.status !== "restarting") delete state.nextAt
    if (next.status === "running") delete state.error
    deps.onState?.({ ...state })
  }

  const launch = async (): Promise<SidecarConnection> => {
    set({ status: "starting" })
    const started = await deps.start(state.connection)
    current = started
    set({ status: "running", connection: started.connection })
    void started.exited.then((code) => {
      if (current !== started || stopping) return
      current = undefined
      void onCrash(code)
    })
    return started.connection
  }

  const onCrash = async (code: number, error?: string): Promise<void> => {
    const at = now()
    crashes = [...crashes.filter((time) => at - time < policy.windowMs), at]
    state = { ...state, lastExit: { code, at } }
    if (crashes.length >= policy.maxCrashes) {
      set({ status: "failed", error: error ?? `server exited ${crashes.length} times in a row (last code ${code})` })
      return
    }
    const wait = policy.delays[Math.min(streak, policy.delays.length - 1)]!
    streak += 1
    set({ status: "restarting", restarts: state.restarts + 1, nextAt: at + wait, ...(error ? { error } : {}) })
    await sleep(wait)
    if (stopping || state.status !== "restarting") return
    await launch().catch((cause: unknown) =>
      onCrash(-1, `restart failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    )
  }

  return {
    /** First start. Rejects if it fails; crashes after that are supervised. */
    start: () => {
      stopping = false
      return launch()
    },
    /** Starts again after "failed", with a fresh crash window and backoff. */
    restart: async () => {
      stopping = false
      crashes = []
      streak = 0
      if (current) {
        const previous = current
        current = undefined
        await previous.stop()
      }
      return launch()
    },
    stop: async () => {
      stopping = true
      const previous = current
      current = undefined
      await previous?.stop()
      set({ status: "stopped" })
    },
    state: () => ({ ...state }),
    connection: () => state.connection,
  }
}

export type SidecarSupervisor = ReturnType<typeof createSidecarSupervisor>
