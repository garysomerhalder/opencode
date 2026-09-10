import type {
  GoalLoopEvent,
  GoalLoopModel,
  GoalLoopStartInput,
  GoalLoopState,
  GoalLoopStatus,
} from "@opencode-ai/app/goal-loop/types"

export type { GoalLoopEvent, GoalLoopModel, GoalLoopStartInput, GoalLoopState, GoalLoopStatus }

export type GoalLoopServer = {
  url: string
  username: string | null
  password: string | null
}

export type GoalLoopDeps = {
  getServer: () => Promise<GoalLoopServer>
  fetchImpl?: typeof fetch
  now?: () => number
  randomID?: () => string
  onEvent?: (event: GoalLoopEvent) => void
  persist?: (state: GoalLoopState | null) => void
  persistLast?: (input: GoalLoopStartInput) => void
  waitTimeoutMs?: number
  startTimeoutMs?: number
  pollIntervalMs?: number
  maxConsecutiveErrors?: number
}

export const DEFAULT_COMPLETION_MARKER = "GOAL_COMPLETE"
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3
const HISTORY_LIMIT = 20
const ACTIVE_POLL_INTERVAL_MS = 2000
const EXECUTION_START_TIMEOUT_MS = 30 * 1000

function authHeader(server: GoalLoopServer): Record<string, string> {
  if (!server.username && !server.password) return {}
  const raw = `${server.username ?? "opencode"}:${server.password ?? ""}`
  return { authorization: `Basic ${Buffer.from(raw).toString("base64")}` }
}

function firstPromptText(goal: string, marker: string): string {
  return (
    `${goal}\n\nWork on this goal autonomously, one step at a time. ` +
    `When the goal is fully achieved, reply with ${marker} on its own line and stop. ` +
    `If you cannot make progress, say so plainly instead of repeating work.`
  )
}

function continuePromptText(goal: string, marker: string, iteration: number, maxIterations: number | null): string {
  const budget = maxIterations === null ? "" : ` (step ${iteration} of ${maxIterations})`
  return (
    `Continue working toward this goal${budget}: ${goal} ` +
    `If the goal is now fully achieved, reply with ${marker} on its own line and stop.`
  )
}

export function extractAssistantText(payload: unknown): string {
  const record = (payload ?? {}) as Record<string, unknown>
  const candidates = [
    Array.isArray(payload) ? payload : undefined,
    record["data"],
    record["messages"],
    record["items"],
  ]
  const items = candidates.find((value): value is unknown[] => Array.isArray(value)) ?? []
  const texts: string[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    // v2 shape: { type: "assistant", content: [{ type: "text", text }] }
    // v1 shape: { info: { role: "assistant" }, parts: [{ type: "text", text }] }
    const info = (record["info"] ?? record) as Record<string, unknown>
    const role = info["role"] ?? record["type"]
    if (role !== "assistant") continue
    if (typeof info["text"] === "string" && info["text"].length > 0) texts.push(info["text"])
    const parts = record["parts"] ?? info["parts"] ?? record["content"]
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue
      const entry = part as Record<string, unknown>
      if (entry["type"] !== "text") continue
      if (entry["synthetic"] === true || entry["ignored"] === true) continue
      if (typeof entry["text"] === "string" && entry["text"].length > 0) texts.push(entry["text"])
    }
  }
  return texts.join("\n")
}

export function completionReached(text: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped}$`, "m").test(text)
}

export function createGoalLoop(deps: GoalLoopDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const randomID = deps.randomID ?? (() => crypto.randomUUID())
  const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const startTimeoutMs = deps.startTimeoutMs ?? EXECUTION_START_TIMEOUT_MS
  const pollIntervalMs = deps.pollIntervalMs ?? ACTIVE_POLL_INTERVAL_MS
  const maxConsecutiveErrors = deps.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS

  let active: GoalLoopState | null = null
  let stopped = false
  let directory = ""

  async function request(server: GoalLoopServer, path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetchImpl(new URL(path, server.url), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(directory ? { "x-opencode-directory": directory } : {}),
        ...authHeader(server),
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) throw new Error(`goal loop request failed: ${res.status} ${path} ${(await res.text()).slice(0, 300)}`)
    const text = await res.text()
    if (!text) return null
    return JSON.parse(text) as unknown
  }

  function setState(next: GoalLoopState): GoalLoopState {
    active = next
    deps.persist?.(next.status === "running" ? next : null)
    return next
  }

  function emit(event: GoalLoopEvent) {
    deps.onEvent?.(event)
  }

  function finish(status: Exclude<GoalLoopStatus, "running">, reason: string | null): GoalLoopState {
    const current = active
    if (!current) throw new Error("no active goal loop")
    const next = setState({ ...current, status, reason, updatedAt: now() })
    emit({ loopID: next.id, type: status, state: next })
    active = null
    deps.persist?.(null)
    return next
  }

  async function createSession(server: GoalLoopServer, input: GoalLoopStartInput): Promise<string> {
    if (input.sessionID) return input.sessionID
    // v1 surface: the desktop UI reads sessions through it, so loop sessions
    // created here show up in lists, tabs, and transcripts. v2-created
    // sessions are invisible to v1 reads (same server, 200 with []).
    const created = (await request(
      server,
      `/session?directory=${encodeURIComponent(input.directory)}`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    )) as { id?: unknown; data?: { id?: unknown } }
    const id = created?.data?.id ?? created?.id
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("goal loop session creation returned no id")
    }
    return id
  }

  async function prompt(
    server: GoalLoopServer,
    sessionID: string,
    text: string,
    input: GoalLoopStartInput,
  ): Promise<void> {
    // prompt_async is the path the UI itself uses: it admits the message and
    // schedules the turn. Plain POST message 500s when a turn must run.
    await request(server, `/session/${sessionID}/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
      }),
    })
  }

  async function waitIdle(server: GoalLoopServer, sessionID: string): Promise<void> {
    await waitForActive(server, sessionID, true, startTimeoutMs, "session did not start executing")
    await waitForActive(server, sessionID, false, waitTimeoutMs, "session did not finish within the wait timeout")
  }

  async function waitForActive(
    server: GoalLoopServer,
    sessionID: string,
    wantActive: boolean,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<void> {
    const deadline = now() + timeoutMs
    while (true) {
      if (stopped) throw new Error("stopped")
      const payload = (await request(
        server,
        `/session/status?directory=${encodeURIComponent(directory)}`,
        { method: "GET" },
      )) as Record<string, { type?: string }>
      // v1 reports per-session status; a missing entry means idle.
      const status = payload?.[sessionID]?.type ?? "idle"
      const isActive = status !== "idle"
      if (isActive === wantActive) return
      if (now() >= deadline) throw new Error(timeoutMessage)
      await sleep(pollIntervalMs)
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function latestAssistantText(server: GoalLoopServer, sessionID: string): Promise<string> {
    const payload = await request(
      server,
      `/session/${sessionID}/message?directory=${encodeURIComponent(directory)}&limit=${HISTORY_LIMIT}`,
      { method: "GET" },
    )
    return extractAssistantText(payload)
  }

  async function drive(state: GoalLoopState, server: GoalLoopServer, input: GoalLoopStartInput): Promise<void> {
    let errors = 0
    while (!stopped) {
      const current = active
      if (!current || current.id !== state.id || current.status !== "running") return
      try {
        await waitIdle(server, current.sessionID ?? "")
        if (stopped) return
        const text = await latestAssistantText(server, current.sessionID ?? "")
        if (completionReached(text, current.completionMarker)) {
          finish("completed", null)
          return
        }
        errors = 0
        const nextIteration = current.iteration + 1
        if (current.maxIterations !== null && nextIteration > current.maxIterations) {
          finish("capped", `reached ${current.maxIterations} iterations without ${current.completionMarker}`)
          return
        }
        const next = setState({ ...current, iteration: nextIteration, updatedAt: now() })
        emit({ loopID: next.id, type: "iteration", state: next })
        await prompt(
          server,
          next.sessionID ?? "",
          continuePromptText(next.goal, next.completionMarker, nextIteration, next.maxIterations),
          input,
        )
      } catch (error) {
        errors += 1
        if (stopped) return
        if (errors >= maxConsecutiveErrors) {
          const message = error instanceof Error ? error.message : String(error)
          const sessionID = active?.sessionID ?? null
          if (sessionID) await interruptQuietly(server, sessionID)
          finish("failed", message)
          return
        }
      }
    }
  }

  async function interruptQuietly(server: GoalLoopServer, sessionID: string): Promise<void> {
    try {
      await request(server, `/session/${sessionID}/abort?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        body: "{}",
      })
    } catch {
      return
    }
  }

  async function start(input: GoalLoopStartInput): Promise<GoalLoopState> {
    if (active) throw new Error("a goal loop is already running")
    if (typeof input.directory !== "string" || input.directory.trim().length === 0) {
      throw new Error("directory must not be empty")
    }
    const goal = input.goal.trim()
    if (!goal) throw new Error("goal must not be empty")
    const maxIterations = input.maxIterations ?? null
    if (maxIterations !== null && (!Number.isInteger(maxIterations) || maxIterations < 1)) {
      throw new Error("maxIterations must be a positive integer")
    }
    const marker = (input.completionMarker ?? DEFAULT_COMPLETION_MARKER).trim() || DEFAULT_COMPLETION_MARKER
    stopped = false
    directory = input.directory
    const server = await deps.getServer()
    const sessionID = await createSession(server, input)
    const state = setState({
      id: randomID(),
      status: "running",
      directory: input.directory,
      goal,
      sessionID,
      serverURL: server.url,
      iteration: 1,
      maxIterations,
      completionMarker: marker,
      reason: null,
      updatedAt: now(),
    })
    deps.persistLast?.(input)
    emit({ loopID: state.id, type: "started", state })
    await prompt(server, sessionID, firstPromptText(goal, marker), input)
    void drive(state, server, input)
    return state
  }

  async function stop(): Promise<GoalLoopState | null> {
    const current = active
    if (!current) return null
    stopped = true
    try {
      const server = await deps.getServer()
      if (current.sessionID) await interruptQuietly(server, current.sessionID)
    } catch {
      // interrupting is best-effort; the loop still stops
    }
    if (active?.id !== current.id) return active
    return finish("stopped", "stopped by user")
  }

  function status(): GoalLoopState | null {
    return active
  }

  function adoptOrphan(record: GoalLoopState | null | undefined): GoalLoopState | null {
    if (active || !record || record.status !== "running") return active
    const next = setState({ ...record, status: "stopped", reason: "app restarted", updatedAt: now() })
    emit({ loopID: next.id, type: "stopped", state: next })
    active = null
    deps.persist?.(null)
    return null
  }

  function markInterrupted(reason: string): GoalLoopState | null {
    if (!active) return null
    stopped = true
    return finish("stopped", reason)
  }

  return { start, stop, status, markInterrupted, adoptOrphan }
}

export type GoalLoop = ReturnType<typeof createGoalLoop>
