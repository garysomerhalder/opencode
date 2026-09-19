import type {
  GoalLoopEvent,
  GoalLoopModel,
  GoalLoopStartInput,
  GoalLoopState,
  GoalLoopStatus,
  GoalTicket,
} from "@opencode-ai/app/goal-loop/types"

export type { GoalLoopEvent, GoalLoopModel, GoalLoopStartInput, GoalLoopState, GoalLoopStatus, GoalTicket }

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
  /** How long a busy session may go without progress (or one tool may run) before it counts as one error. */
  waitTimeoutMs?: number
  /** How often a busy session's newest message is re-read to look for progress. */
  progressCheckMs?: number
  startTimeoutMs?: number
  pollIntervalMs?: number
  maxConsecutiveErrors?: number
  /** Consecutive aborted turns tolerated before the loop gives up. */
  maxConsecutiveAborts?: number
  /** First wait after an aborted turn; doubles per consecutive abort. */
  abortBackoffMs?: number
  /** How long the server may stay unreachable (refused, 5xx) before it counts as one error. */
  outageToleranceMs?: number
  /** First retry wait after a failed request; doubles per attempt. */
  retryBackoffMs?: number
  maxBackoffMs?: number
}

export const DEFAULT_COMPLETION_MARKER = "GOAL_COMPLETE"
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_PROGRESS_CHECK_MS = 10 * 1000
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3
const DEFAULT_MAX_CONSECUTIVE_ABORTS = 5
const DEFAULT_ABORT_BACKOFF_MS = 5 * 1000
const DEFAULT_OUTAGE_TOLERANCE_MS = 2 * 60 * 1000
const DEFAULT_RETRY_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 30 * 1000
const HISTORY_LIMIT = 20
const ACTIVE_POLL_INTERVAL_MS = 2000
const EXECUTION_START_TIMEOUT_MS = 30 * 1000

// The server is unreachable or restarting (connection refused/reset, 5xx,
// 429). The loop retries these with backoff instead of counting an error.
class TransientError extends Error {}

type SessionMessage = { id: string | null; role: unknown; aborted: boolean; raw: unknown }

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

// Reads a message list (v1 info/parts or v2 envelope) in chronological order.
function parseMessages(payload: unknown): SessionMessage[] {
  const record = (payload ?? {}) as Record<string, unknown>
  const items =
    [Array.isArray(payload) ? payload : undefined, record["data"], record["messages"], record["items"]].find(
      (value): value is unknown[] => Array.isArray(value),
    ) ?? []
  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const info = (item["info"] ?? item) as Record<string, unknown>
      const error = (info["error"] ?? {}) as { name?: unknown; data?: { message?: unknown } }
      return {
        id: typeof info["id"] === "string" ? info["id"] : null,
        role: info["role"] ?? item["type"],
        aborted: error.name === "MessageAbortedError" || error.data?.message === "Aborted",
        raw: item,
      }
    })
}

// Assistant output of the latest turn: everything after the last user message.
function turnText(messages: SessionMessage[]): string {
  const start = messages.findLastIndex((message) => message.role === "user") + 1
  return extractAssistantText(messages.slice(start).map((message) => message.raw))
}

function seconds(ms: number): number {
  return Math.round(ms / 1000)
}

// Summarizes the newest message: any change in the fingerprint between two
// reads means the turn is still moving (a new message or part, a part that
// finished, text or tool output that grew). `tool` is set while the newest
// part is a tool call that is still running.
function progressOf(messages: SessionMessage[]) {
  const last = messages.at(-1)
  const record = (last?.raw ?? {}) as Record<string, unknown>
  const info = (record["info"] ?? record) as Record<string, unknown>
  const parts =
    [record["parts"], info["parts"], record["content"]].find((value): value is unknown[] => Array.isArray(value)) ?? []
  const part = (parts.at(-1) ?? {}) as Record<string, unknown>
  const state = (part["state"] ?? {}) as { status?: unknown; time?: unknown; metadata?: { output?: unknown } }
  const time = (state.time ?? part["time"] ?? {}) as { start?: unknown; end?: unknown }
  const text = part["text"]
  const output = state.metadata?.output
  const running = part["type"] === "tool" && state.status === "running"
  return {
    fingerprint: [
      last?.id,
      parts.length,
      part["id"],
      state.status,
      time.start,
      time.end,
      typeof text === "string" ? text.length : 0,
      typeof output === "string" ? output.length : 0,
    ].join("|"),
    tool: running
      ? { id: `${last?.id}:${String(part["id"] ?? part["callID"])}`, name: String(part["tool"] ?? "tool") }
      : null,
  }
}

export function createGoalLoop(deps: GoalLoopDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const randomID = deps.randomID ?? (() => crypto.randomUUID())
  const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const progressCheckMs = deps.progressCheckMs ?? DEFAULT_PROGRESS_CHECK_MS
  const startTimeoutMs = deps.startTimeoutMs ?? EXECUTION_START_TIMEOUT_MS
  const pollIntervalMs = deps.pollIntervalMs ?? ACTIVE_POLL_INTERVAL_MS
  const maxConsecutiveErrors = deps.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS
  const maxConsecutiveAborts = deps.maxConsecutiveAborts ?? DEFAULT_MAX_CONSECUTIVE_ABORTS
  const abortBackoffMs = deps.abortBackoffMs ?? DEFAULT_ABORT_BACKOFF_MS
  const outageToleranceMs = deps.outageToleranceMs ?? DEFAULT_OUTAGE_TOLERANCE_MS
  const retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS

  let active: GoalLoopState | null = null
  let stopped = false
  let directory = ""

  async function request(server: GoalLoopServer, path: string, init?: RequestInit): Promise<unknown> {
    // fetch only rejects when the request never got an HTTP answer (refused,
    // reset, DNS), which is what a restarting server looks like.
    const res = await fetchImpl(new URL(path, server.url), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(directory ? { "x-opencode-directory": directory } : {}),
        ...authHeader(server),
        ...(init?.headers ?? {}),
      },
    }).catch((error: unknown) => {
      throw new TransientError(`goal loop request failed: ${path} ${error instanceof Error ? error.message : String(error)}`)
    })
    if (res.status >= 500 || res.status === 429) {
      throw new TransientError(`goal loop request failed: ${res.status} ${path} ${(await res.text()).slice(0, 300)}`)
    }
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

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function sessionMessages(server: GoalLoopServer, sessionID: string): Promise<SessionMessage[]> {
    return parseMessages(
      await request(
        server,
        `/session/${sessionID}/message?directory=${encodeURIComponent(directory)}&limit=${HISTORY_LIMIT}`,
        { method: "GET" },
      ),
    )
  }

  // Drives the session by watching for "the latest turn completed in this
  // session" rather than only the turns the loop started itself: another
  // client may post prompts into the same session (an architect sending
  // corrections), and the server may abort a turn (config reload) or restart.
  // A turn counts as completed when the session is idle, no admitted user
  // message is still waiting to run, and either a busy period was observed or
  // a new assistant message appeared (turns shorter than one poll interval).
  async function drive(
    state: GoalLoopState,
    server: GoalLoopServer,
    input: GoalLoopStartInput,
    baselineAssistantID: string | null,
  ): Promise<void> {
    const sessionID = state.sessionID ?? ""
    const alive = () => !stopped && active?.id === state.id && active.status === "running"
    const track = {
      errors: 0,
      aborts: 0,
      outageSince: null as number | null,
      sawBusy: false,
      // progress seen during the current busy stretch; null while idle
      watch: null as {
        progressAt: number
        checkedAt: number | null
        fingerprint: string | null
        tool: { id: string; name: string; since: number } | null
        noted: number
      } | null,
      sentAt: now(),
      pendingUser: null as { id: string | null; at: number } | null,
      staleUserID: undefined as string | null | undefined,
      retries: 0,
      lastAssistantID: baselineAssistantID,
      // text of the continue prompt the loop owes the session, sent as soon as
      // the session is observed idle with nothing queued
      owed: null as string | null,
      delay: 0,
    }

    const send = async (text: string) => {
      track.owed = text
      await prompt(server, sessionID, text, input)
      track.owed = null
      track.sawBusy = false
      track.sentAt = now()
    }

    // Advances the iteration counter and returns the continue prompt text, or
    // null when the iteration cap ends the loop.
    const nextContinue = () => {
      const current = active
      if (!current) return null
      const nextIteration = current.iteration + 1
      if (current.maxIterations !== null && nextIteration > current.maxIterations) {
        finish("capped", `reached ${current.maxIterations} iterations without ${current.completionMarker}`)
        return null
      }
      const next = setState({ ...current, iteration: nextIteration, updatedAt: now() })
      emit({ loopID: next.id, type: "iteration", state: next })
      return continuePromptText(next.goal, next.completionMarker, nextIteration, next.maxIterations)
    }

    while (alive()) {
      if (track.delay > 0) {
        await sleep(track.delay)
        track.delay = 0
        if (!alive()) return
      }
      try {
        const busy = await sessionBusy(server, sessionID)
        track.retries = 0
        if (track.outageSince !== null) {
          const down = seconds(now() - track.outageSince)
          track.outageSince = null
          note(`server reachable again after ${down}s; continuing`)
        }
        if (busy) {
          track.sawBusy = true
          track.delay = pollIntervalMs
          // A long turn is fine as long as it moves. Only a busy session whose
          // newest message stops changing for waitTimeoutMs counts as stalled,
          // and a single tool call gets at most waitTimeoutMs, so a hung
          // command that keeps printing cannot hold the loop forever.
          const watch = (track.watch ??= {
            progressAt: now(),
            checkedAt: null,
            fingerprint: null,
            tool: null,
            noted: 0,
          })
          if (watch.checkedAt === null || now() - watch.checkedAt >= progressCheckMs) {
            watch.checkedAt = now()
            const progress = progressOf(await sessionMessages(server, sessionID))
            if (progress.tool?.id !== watch.tool?.id) watch.tool = progress.tool && { ...progress.tool, since: now() }
            if (progress.fingerprint !== watch.fingerprint) {
              const gap = now() - watch.progressAt
              if (watch.fingerprint !== null && gap * 4 >= waitTimeoutMs) {
                note(`working (progress resumed after ${seconds(gap)}s)`)
              }
              watch.fingerprint = progress.fingerprint
              watch.progressAt = now()
              // a still-running tool keeps the milestones it already reported
              watch.noted = watch.tool ? Math.floor((4 * (now() - watch.tool.since)) / waitTimeoutMs) : 0
            }
          }
          const quiet = now() - watch.progressAt
          const toolAge = watch.tool ? now() - watch.tool.since : 0
          if (quiet < waitTimeoutMs && toolAge < waitTimeoutMs) {
            // Report a long quiet stretch at each quarter of the timeout, not every poll.
            const milestone = Math.floor((4 * Math.max(quiet, toolAge)) / waitTimeoutMs)
            if (milestone > watch.noted) {
              watch.noted = milestone
              note(
                watch.tool && toolAge > quiet
                  ? `working (${watch.tool.name} running for ${seconds(toolAge)}s)`
                  : `working (last progress ${seconds(quiet)}s ago)`,
              )
            }
            continue
          }
          const stall =
            watch.tool && toolAge >= waitTimeoutMs
              ? `${watch.tool.name} has been running for ${seconds(toolAge)}s without finishing`
              : `session made no progress for ${seconds(quiet)}s`
          // the next stall window starts now
          watch.progressAt = now()
          watch.noted = 0
          if (watch.tool) watch.tool.since = now()
          throw new Error(stall)
        }
        track.watch = null

        const messages = await sessionMessages(server, sessionID)
        const last = messages.at(-1)
        if (last?.role === "user" && last.id !== track.staleUserID) {
          // An admitted prompt (the loop's own or another client's) has not run
          // yet. Never send on top of it; wait for its turn instead.
          if (track.pendingUser?.id !== last.id) track.pendingUser = { id: last.id, at: now() }
          track.delay = pollIntervalMs
          if (now() - track.pendingUser.at < startTimeoutMs) continue
          // It never ran; stop waiting on it and re-prompt on the next idle poll.
          track.staleUserID = last.id
          track.pendingUser = null
          track.owed ??= nextContinue()
          if (track.owed === null) return
          throw new Error("session did not start executing")
        }
        track.pendingUser = null

        const latest = messages.findLast((message) => message.role === "assistant")
        const newTurn = track.sawBusy || (latest?.id != null && latest.id !== track.lastAssistantID)
        if (!newTurn) {
          if (track.owed !== null) {
            await send(track.owed)
            continue
          }
          track.delay = pollIntervalMs
          if (now() - track.sentAt < startTimeoutMs) continue
          track.owed = nextContinue()
          if (track.owed === null) return
          throw new Error("session did not start executing")
        }

        track.sawBusy = false
        track.lastAssistantID = latest?.id ?? track.lastAssistantID
        track.errors = 0
        const current = active
        if (!current) return
        if (completionReached(turnText(messages), current.completionMarker)) {
          finish("completed", null)
          return
        }
        if (latest?.aborted) {
          track.aborts += 1
          if (track.aborts >= maxConsecutiveAborts) {
            finish("failed", `turn aborted ${track.aborts} times in a row`)
            return
          }
          note(`recovered from an aborted turn (${track.aborts} of ${maxConsecutiveAborts}); continuing`)
          track.owed ??= nextContinue()
          if (track.owed === null) return
          // Re-poll after the backoff so the continue only goes out once the
          // session is confirmed idle.
          track.delay = Math.min(abortBackoffMs * 2 ** (track.aborts - 1), maxBackoffMs)
          continue
        }
        track.aborts = 0
        // a continue still owed from an earlier abort or failed send covers this turn too
        const text = track.owed ?? nextContinue()
        if (text === null) return
        await send(text)
      } catch (error) {
        if (!alive()) return
        const message = error instanceof Error ? error.message : String(error)
        track.delay = Math.min(retryBackoffMs * 2 ** track.retries, maxBackoffMs)
        track.retries += 1
        if (error instanceof TransientError) {
          track.outageSince ??= now()
          if (now() - track.outageSince < outageToleranceMs) {
            note(`server unreachable, retrying: ${message}`)
            continue
          }
          // A sustained outage counts as one error; the next window starts fresh.
          track.outageSince = null
        }
        track.errors += 1
        if (track.errors >= maxConsecutiveErrors) {
          await interruptQuietly(server, sessionID)
          finish("failed", message)
          return
        }
        note(`recovered from an error (${track.errors} of ${maxConsecutiveErrors}): ${message}`)
      }
    }
  }

  // Keeps the loop running while recording what it just recovered from, so
  // goalLoop.status() and the UI show why the loop is still going.
  function note(reason: string) {
    const current = active
    if (!current || current.status !== "running" || current.reason === reason) return
    const next = setState({ ...current, reason, updatedAt: now() })
    emit({ loopID: next.id, type: "iteration", state: next })
  }

  async function sessionBusy(server: GoalLoopServer, sessionID: string): Promise<boolean> {
    const payload = (await request(server, `/session/status?directory=${encodeURIComponent(directory)}`, {
      method: "GET",
    })) as Record<string, { type?: string }> | null
    // v1 reports per-session status; a missing entry means idle.
    return (payload?.[sessionID]?.type ?? "idle") !== "idle"
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
    const ticket: GoalTicket | null = input.ticket ?? null
    if (ticket !== null) {
      if (typeof ticket.identifier !== "string" || ticket.identifier.trim().length === 0) {
        throw new Error("ticket must have identifier and title")
      }
      if (typeof ticket.title !== "string" || ticket.title.trim().length === 0) {
        throw new Error("ticket must have identifier and title")
      }
    }
    stopped = false
    directory = input.directory
    const server = await deps.getServer()
    const sessionID = await createSession(server, input)
    // A reused session already has turns; remember the newest assistant
    // message so an old reply is never mistaken for the loop's first turn.
    const baselineAssistantID = input.sessionID
      ? await sessionMessages(server, sessionID)
          .then((messages) => messages.findLast((message) => message.role === "assistant")?.id ?? null)
          .catch(() => null)
      : null
    const state = setState({
      id: randomID(),
      status: "running",
      directory: input.directory,
      goal,
      ticket,
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
    void drive(state, server, input, baselineAssistantID)
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
