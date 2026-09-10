export type GoalLoopModel = {
  providerID: string
  modelID: string
}

export type GoalLoopStartInput = {
  directory: string
  goal: string
  maxIterations?: number
  completionMarker?: string
  sessionID?: string
  agent?: string
  model?: GoalLoopModel
}

export type GoalLoopStatus = "running" | "completed" | "capped" | "failed" | "stopped"

export type GoalLoopState = {
  id: string
  status: GoalLoopStatus
  directory: string
  goal: string
  sessionID: string | null
  serverURL: string | null
  iteration: number
  maxIterations: number | null
  completionMarker: string
  reason: string | null
  updatedAt: number
}

export type GoalLoopEvent =
  | { loopID: string; type: "started"; state: GoalLoopState }
  | { loopID: string; type: "iteration"; state: GoalLoopState }
  | { loopID: string; type: "completed"; state: GoalLoopState }
  | { loopID: string; type: "capped"; state: GoalLoopState }
  | { loopID: string; type: "failed"; state: GoalLoopState }
  | { loopID: string; type: "stopped"; state: GoalLoopState }

export type GoalLoopPlatform = {
  start(input: GoalLoopStartInput): Promise<GoalLoopState>
  stop(): Promise<GoalLoopState | null>
  status(): Promise<GoalLoopState | null>
  last?(): Promise<GoalLoopStartInput | null>
  subscribe(cb: (event: GoalLoopEvent) => void): () => void
}
