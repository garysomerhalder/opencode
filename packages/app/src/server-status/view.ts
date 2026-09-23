// What the app shows about the local server the desktop shell supervises.
// Pure: the banner renders this.

export type ServerStatus = "starting" | "running" | "restarting" | "failed" | "stopped"

/** The supervisor's state as the renderer sees it (no credentials). */
export type ServerState = {
  status: ServerStatus
  restarts: number
  lastExit?: { code: number; at: number }
  nextAt?: number
  error?: string
}

export type ServerStatePlatform = {
  state(): Promise<ServerState | null>
  restart(): Promise<void>
  subscribe(cb: (state: ServerState) => void): () => void
}

export type ServerStatusView = {
  tone: "warning" | "error"
  /** An i18n key. */
  key: "serverStatus.restarting" | "serverStatus.failed"
  params: Record<string, string | number>
  canRestart: boolean
}

/** Windows crash codes read better in hex (0xC0000005 is an access violation). */
function exitCode(code: number) {
  if (code > 0xffff) return `0x${code.toString(16).toUpperCase()}`
  return String(code)
}

export function serverStatusView(state: ServerState | null | undefined, now: number): ServerStatusView | undefined {
  if (!state) return undefined
  const code = state.lastExit ? exitCode(state.lastExit.code) : "?"
  if (state.status === "restarting")
    return {
      tone: "warning",
      key: "serverStatus.restarting",
      params: { code, seconds: Math.max(0, Math.ceil(((state.nextAt ?? now) - now) / 1000)), attempt: state.restarts },
      canRestart: false,
    }
  if (state.status === "failed")
    return {
      tone: "error",
      key: "serverStatus.failed",
      params: { code, reason: state.error ?? "" },
      canRestart: true,
    }
  return undefined
}
