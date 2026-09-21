// How a background shell task is described to clients: its last line of output,
// whether its finish will reach the agent, and when a change is worth sending.
// Pure, so the rules are unit-tested apart from the process plumbing.

export type Wake = "none" | "pending" | "delivered" | "read" | "suppressed"

type Status = "running" | "exited" | "stopped" | "timed_out" | "cancelled"

export const TAIL_CHARS = 200

/** The newest non-empty line. A carriage return starts a new frame (progress bars), so only the last frame counts. */
export function lastLine(text: string, max = TAIL_CHARS): string | undefined {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const frames = lines[i]!.split("\r").filter((frame) => frame.trim().length > 0)
    const line = frames.at(-1)?.trimEnd()
    if (line) return line.length > max ? line.slice(0, max) : line
  }
  return undefined
}

/**
 * Mirrors when the registry wakes a session: only a task that ended on its own,
 * or hit its deadline or lifetime cap, wakes it, and not when the agent already
 * read the end. A stop on request, a cancel and the idle reaper never wake.
 */
export function wakeState(input: {
  hasWake: boolean
  status: Status
  reason?: string
  observedTerminal: boolean
  woke: boolean
}): Wake {
  if (!input.hasWake) return "none"
  if (input.status === "running") return "pending"
  if (input.observedTerminal) return "read"
  const wakes = input.status === "exited" || input.reason === "deadline" || input.reason === "lifetime"
  if (!wakes) return "suppressed"
  return input.woke ? "delivered" : "pending"
}

/** A status change always goes out; output growth at most once per `everyMs`. */
export function shouldPublish(input: { force: boolean; lastAt: number | undefined; now: number; everyMs: number }) {
  if (input.force) return true
  if (input.lastAt === undefined) return true
  return input.now - input.lastAt >= input.everyMs
}
