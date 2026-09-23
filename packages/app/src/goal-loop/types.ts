export type GoalLoopModel = {
  providerID: string
  modelID: string
}

export interface GoalTicket {
  identifier: string
  title: string
}

export type GoalLoopStartInput = {
  directory: string
  goal: string
  ticket?: GoalTicket | null
  maxIterations?: number
  completionMarker?: string
  sessionID?: string
  agent?: string
  model?: GoalLoopModel
}

export type GoalLoopStatus = "running" | "completed" | "capped" | "failed" | "stopped"

/**
 * What a running loop is doing right now.
 * - `turn`: the session is busy with a turn the loop is watching.
 * - `waiting`: the session is idle and the loop is about to prompt, backing off, or recovering.
 */
export type GoalLoopPhase = "turn" | "waiting"

export type GoalLoopState = {
  id: string
  status: GoalLoopStatus
  directory: string
  goal: string
  ticket: GoalTicket | null
  sessionID: string | null
  serverURL: string | null
  iteration: number
  maxIterations: number | null
  completionMarker: string
  reason: string | null
  updatedAt: number
  /** Optional so records persisted before these fields existed still load. */
  phase?: GoalLoopPhase
  /** When the loop last polled the session. */
  checkedAt?: number | null
  /** When the loop last sent the session a prompt (the first prompt or a continue). */
  promptedAt?: number | null
}

export type GoalLoopEvent =
  | { loopID: string; type: "started"; state: GoalLoopState }
  | { loopID: string; type: "iteration"; state: GoalLoopState }
  | { loopID: string; type: "progress"; state: GoalLoopState }
  | { loopID: string; type: "completed"; state: GoalLoopState }
  | { loopID: string; type: "capped"; state: GoalLoopState }
  | { loopID: string; type: "failed"; state: GoalLoopState }
  | { loopID: string; type: "stopped"; state: GoalLoopState }

/** The terminal event types: the loop ended and will not emit again. */
export const TERMINAL_EVENTS = ["completed", "capped", "failed", "stopped"] as const

export type GoalLoopPlatform = {
  start(input: GoalLoopStartInput): Promise<GoalLoopState>
  /**
   * Stops the loop driving `sessionID`. Without a session id it stops the only running
   * loop, and refuses when several are running.
   */
  stop(sessionID?: string): Promise<GoalLoopState | null>
  /** The loop of `sessionID` (running or recently ended); without one, the newest running loop. */
  status(sessionID?: string): Promise<GoalLoopState | null>
  /** Every running loop, and every ended one not yet dismissed. */
  list?(): Promise<GoalLoopState[]>
  /** Forgets an ended loop so its session's panel goes back to idle. */
  dismiss?(sessionID: string): Promise<void>
  /** The last start input for `sessionID`; without one, the last input of any session. */
  last?(sessionID?: string): Promise<GoalLoopStartInput | null>
  subscribe(cb: (event: GoalLoopEvent) => void): () => void
}
