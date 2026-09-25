import type {
  GoalLoopEvent,
  GoalLoopPhase,
  GoalLoopModel,
  GoalLoopStartInput,
  GoalLoopState,
  GoalLoopStatus,
  GoalTicket,
} from "@opencode-ai/app/goal-loop/types"

export type {
  GoalLoopEvent,
  GoalLoopModel,
  GoalLoopPhase,
  GoalLoopStartInput,
  GoalLoopState,
  GoalLoopStatus,
  GoalTicket,
}

import { RequestError, verifyOnce } from "./goal-verify"

export type GoalLoopServer = {
  url: string
  username: string | null
  password: string | null
}

export type GoalLoopDeps = {
  getServer: () => Promise<GoalLoopServer>
  fetchImpl?: typeof fetch
  /** One-line warnings for the log (e.g. when the compaction backstop has to fire). */
  warn?: (message: string, detail: Record<string, unknown>) => void
  now?: () => number
  randomID?: () => string
  onEvent?: (event: GoalLoopEvent) => void
  /**
   * Live, unpersisted progress: the phase, the last poll and the last prompt. Called on a
   * phase change and otherwise at most every progressEveryMs, so a UI can show "checked 3s ago"
   * without the state being written to disk on every poll.
   */
  onProgress?: (state: GoalLoopState) => void
  progressEveryMs?: number
  persist?: (state: GoalLoopState | null) => void
  persistLast?: (input: GoalLoopStartInput) => void
  /** How long a busy session may go without progress before it counts as one error. */
  waitTimeoutMs?: number
  /** Hard cap on one tool call that keeps producing output; past it the call counts as one error. */
  maxToolRunMs?: number
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
  /** Context size (tokens of the last successful turn) above which the session is summarized before the next continue. */
  compactAtTokens?: number
  /**
   * The local server's host token (hostToken() in main/server.ts; accuracy E §11.8).
   * A loop that verifies needs it; without it, the loop ends `unverified`.
   */
  hostToken?: (server: GoalLoopServer) => string | undefined
  /** Wall-clock cap on one verifier turn. */
  verifyTimeoutMs?: number
  /** Deadline for each verification check; one that does not finish is a failed check. */
  checkTimeoutMs?: number
  /**
   * Whether the user approved a proposed check command for the project (host-side,
   * goal-check-approvals.ts). Without it, no proposal runs.
   */
  checkApproved?: (directory: string, command: string) => boolean
}

const DEFAULT_MAX_VERIFICATIONS = 3
const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000
/** Uncounted (stale-goal) drops in a row before the loop ends unverified. */
const MAX_DROPS = 2
// Bounds on what start accepts for verification (the renderer supplies it until PR 3
// moves check commands to trusted config).
const CHECKS_MAX = 20
const CHECK_CHARS = 2_000
const CRITERIA_MAX = 50
const CRITERION_CHARS = 4_000
const VERIFICATIONS_MAX = 10

export const DEFAULT_COMPLETION_MARKER = "GOAL_COMPLETE"
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_PROGRESS_CHECK_MS = 10 * 1000
const DEFAULT_MAX_TOOL_RUN_MS = 60 * 60 * 1000
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3
const DEFAULT_MAX_CONSECUTIVE_ABORTS = 5
const DEFAULT_ABORT_BACKOFF_MS = 5 * 1000
const DEFAULT_OUTAGE_TOLERANCE_MS = 2 * 60 * 1000
const DEFAULT_RETRY_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 30 * 1000
const DEFAULT_COMPACT_AT_TOKENS = 600_000
const DEFAULT_PROGRESS_EVERY_MS = 10 * 1000
const HISTORY_LIMIT = 20
const ACTIVE_POLL_INTERVAL_MS = 2000
const EXECUTION_START_TIMEOUT_MS = 30 * 1000

// The server is unreachable or restarting (connection refused/reset, 5xx,
// 429). The loop retries these with backoff instead of counting an error.
class TransientError extends Error {}

type SessionMessage = {
  id: string | null
  role: unknown
  // A user message the server's accuracy harness wrote itself (runaway guard or
  // todo reminder). It belongs to the turn already running: it is neither a new
  // user prompt to wait on nor a boundary the turn's output starts after.
  harness: boolean
  aborted: boolean
  // set when the turn ended with an error other than an abort
  error: { message: string; statusCode: number | null; retryable: boolean } | null
  // context size the turn ran with (tokens.total), null when not reported
  tokens: number | null
  // a compaction summary
  summary: boolean
  model: GoalLoopModel | null
  raw: unknown
}

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
  const candidates = [Array.isArray(payload) ? payload : undefined, record["data"], record["messages"], record["items"]]
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
      const error = (info["error"] ?? {}) as {
        name?: unknown
        data?: { message?: unknown; statusCode?: unknown; isRetryable?: unknown }
      }
      const aborted = error.name === "MessageAbortedError" || error.data?.message === "Aborted"
      return {
        id: typeof info["id"] === "string" ? info["id"] : null,
        role: info["role"] ?? item["type"],
        harness: isHarnessNote(item),
        aborted,
        error:
          !aborted && typeof error.name === "string"
            ? {
                message: typeof error.data?.message === "string" ? error.data.message : error.name,
                statusCode: typeof error.data?.statusCode === "number" ? error.data.statusCode : null,
                retryable: error.data?.isRetryable === true,
              }
            : null,
        tokens: tokensOf(info["tokens"]),
        summary: info["summary"] === true,
        model:
          typeof info["providerID"] === "string" && typeof info["modelID"] === "string"
            ? { providerID: info["providerID"], modelID: info["modelID"] }
            : null,
        raw: item,
      }
    })
}

function tokensOf(value: unknown): number | null {
  const tokens = (value ?? {}) as {
    total?: unknown
    input?: unknown
    output?: unknown
    cache?: { read?: unknown; write?: unknown }
  }
  if (typeof tokens.total === "number" && tokens.total > 0) return tokens.total
  const sum = [tokens.input, tokens.output, tokens.cache?.read, tokens.cache?.write]
    .filter((n): n is number => typeof n === "number")
    .reduce((acc, n) => acc + n, 0)
  return sum > 0 ? sum : null
}

// Context the session is known to carry: the newest assistant turn that did
// not fail. A summary means the session was just compacted. null when unknown.
function contextOf(messages: SessionMessage[]): { id: string | null; tokens: number } | null {
  const last = messages.findLast((message) => message.role === "assistant" && !message.error && !message.aborted)
  if (!last) return null
  if (last.summary) return { id: last.id, tokens: 0 }
  return last.tokens === null ? null : { id: last.id, tokens: last.tokens }
}

/**
 * A harness note: a user message the server injected into a running turn (a
 * runaway-guard or task-completion reminder, a background-task wake). It
 * carries `reminder` parts instead of text.
 */
export function isHarnessNote(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false
  const record = item as Record<string, unknown>
  const info = (record["info"] ?? record) as Record<string, unknown>
  const role = info["role"] ?? record["type"]
  if (role !== "user") return false
  const parts = record["parts"] ?? info["parts"] ?? record["content"]
  if (!Array.isArray(parts) || parts.length === 0) return false
  return parts.every(
    (part) => typeof part === "object" && part !== null && (part as Record<string, unknown>)["type"] === "reminder",
  )
}

// Assistant output of the latest turn: everything after the last real user
// message. Harness notes are skipped, so a turn the server continued after its
// own reminder still reads as one turn — including a completion marker the
// model emitted before the reminder landed.
export function turnText(messages: SessionMessage[]): string {
  const start = messages.findLastIndex((message) => message.role === "user" && !message.harness) + 1
  return extractAssistantText(messages.slice(start).map((message) => message.raw))
}

// Length plus an FNV-1a hash of the last 256 chars. Length alone misses
// streaming shell output: the shell tool keeps only a sliding 30k-char tail
// in metadata.output, so a long build's output stops growing but keeps changing.
function contentSignature(value: unknown): string {
  if (typeof value !== "string") return ""
  const tail = value.slice(-256)
  const hash = Array.from(tail).reduce(
    (acc, char) => Math.imul(acc ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0,
    0x811c9dc5,
  )
  return `${value.length}:${hash.toString(16)}`
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
      contentSignature(text),
      contentSignature(output),
    ].join("|"),
    tool: running
      ? { id: `${last?.id}:${String(part["id"] ?? part["callID"])}`, name: String(part["tool"] ?? "tool") }
      : null,
  }
}

/**
 * Bounds what start takes for verification: it comes from the renderer over IPC until
 * PR 3 moves check commands to trusted config (PR 2 review, 4).
 */
function validateVerify(verify: GoalLoopStartInput["verify"]) {
  const strings = (value: unknown, max: number, chars: number) =>
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= chars)
  if (!verify || typeof verify !== "object") throw new Error("verify must be an object")
  if (verify.proposals !== undefined && !strings(verify.proposals, CHECKS_MAX, CHECK_CHARS))
    throw new Error(
      `verify.proposals must be at most ${CHECKS_MAX} non-empty commands of at most ${CHECK_CHARS} characters`,
    )
  if (verify.criteria !== undefined && !strings(verify.criteria, CRITERIA_MAX, CRITERION_CHARS))
    throw new Error(`verify.criteria must be at most ${CRITERIA_MAX} non-empty criteria of at most ${CRITERION_CHARS} characters`)
  const max = verify.maxVerifications
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > VERIFICATIONS_MAX))
    throw new Error(`verify.maxVerifications must be an integer from 1 to ${VERIFICATIONS_MAX}`)
}

export function createGoalLoop(deps: GoalLoopDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const randomID = deps.randomID ?? (() => crypto.randomUUID())
  const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const progressCheckMs = deps.progressCheckMs ?? DEFAULT_PROGRESS_CHECK_MS
  const maxToolRunMs = deps.maxToolRunMs ?? DEFAULT_MAX_TOOL_RUN_MS
  const startTimeoutMs = deps.startTimeoutMs ?? EXECUTION_START_TIMEOUT_MS
  const pollIntervalMs = deps.pollIntervalMs ?? ACTIVE_POLL_INTERVAL_MS
  const maxConsecutiveErrors = deps.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS
  const maxConsecutiveAborts = deps.maxConsecutiveAborts ?? DEFAULT_MAX_CONSECUTIVE_ABORTS
  const abortBackoffMs = deps.abortBackoffMs ?? DEFAULT_ABORT_BACKOFF_MS
  const outageToleranceMs = deps.outageToleranceMs ?? DEFAULT_OUTAGE_TOLERANCE_MS
  const retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  const compactAtTokens = deps.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  const checkTimeoutMs = deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS

  const progressEveryMs = deps.progressEveryMs ?? DEFAULT_PROGRESS_EVERY_MS

  let active: GoalLoopState | null = null
  let progressAt = Number.NEGATIVE_INFINITY
  let stopped = false
  let directory = ""

  async function request(
    server: GoalLoopServer,
    path: string,
    init?: RequestInit & { host?: boolean },
  ): Promise<unknown> {
    const { host, ...rest } = init ?? {}
    const target = new URL(path, server.url)
    // The host token is chosen for the URL this request actually goes to, and such a
    // request never follows a redirect (PR 2 review, 5): it cannot be carried elsewhere.
    const hostToken = host ? deps.hostToken?.({ ...server, url: target.href }) : undefined
    // fetch only rejects when the request never got an HTTP answer (refused,
    // reset, DNS), which is what a restarting server looks like.
    const res = await fetchImpl(target, {
      ...rest,
      ...(hostToken ? { redirect: "error" as const } : {}),
      headers: {
        "content-type": "application/json",
        ...(directory ? { "x-opencode-directory": directory } : {}),
        ...authHeader(server),
        ...(hostToken ? { "x-opencode-host-token": hostToken } : {}),
        ...(rest.headers ?? {}),
      },
    }).catch((error: unknown) => {
      throw new TransientError(
        `goal loop request failed: ${path} ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (res.status >= 500 || res.status === 429) {
      throw new TransientError(`goal loop request failed: ${res.status} ${path} ${(await res.text()).slice(0, 300)}`)
    }
    if (!res.ok)
      throw new RequestError(res.status, `goal loop request failed: ${res.status} ${path} ${(await res.text()).slice(0, 300)}`)
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

  // Updates the live fields without persisting: they change on every poll, and
  // the persisted record only has to survive a restart. The next setState
  // carries them into the record anyway, because it spreads the current state.
  function touch(patch: { phase?: GoalLoopPhase; checkedAt?: number; promptedAt?: number }) {
    const current = active
    if (!current || current.status !== "running") return
    const phaseChanged = patch.phase !== undefined && patch.phase !== current.phase
    active = { ...current, ...patch }
    if (!phaseChanged && now() - progressAt < progressEveryMs) return
    progressAt = now()
    deps.onProgress?.(active)
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
    const created = (await request(server, `/session?directory=${encodeURIComponent(input.directory)}`, {
      method: "POST",
      body: JSON.stringify({}),
    })) as { id?: unknown; data?: { id?: unknown } }
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
      body: JSON.stringify(promptBody(text, input)),
    })
  }

  function promptBody(text: string, input: GoalLoopStartInput) {
    return {
      parts: [{ type: "text", text }],
      // Nobody is at the keyboard for a goal-loop turn, even though the
      // desktop client does expose a question tool. Tell the server, so the
      // agent decides and reports instead of stopping to ask.
      autonomous: true,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
    }
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
        tool: { id: string; name: string; since: number; noted: number } | null
        // quarters of waitTimeoutMs of quiet already reported
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
      // id of the turn whose context size last triggered a compaction
      compactedFor: undefined as string | null | undefined,
      // a failed turn already triggered a compaction in this error streak
      overflowCompacted: false,
    }

    const send = async (text: string) => {
      track.owed = text
      await prompt(server, sessionID, text, input)
      track.owed = null
      track.sawBusy = false
      track.sentAt = now()
      touch({ promptedAt: track.sentAt })
    }

    // Sends the owed continue, summarizing the session first when its last
    // successful turn ran with more than compactAtTokens of context. A session
    // left to grow toward the model's window starts failing every request.
    const sendOwed = async (messages: SessionMessage[]) => {
      const text = track.owed
      if (text === null) return
      const context = contextOf(messages)
      if (context && context.tokens > compactAtTokens && context.id !== track.compactedFor) {
        track.compactedFor = context.id
        // A backstop only: goal-loop turns are autonomous, and the server compacts
        // those at its own threshold (150K by default) long before this. Reaching
        // it means that threshold is off or set too high, so say so.
        deps.warn?.(
          "goal loop compacted the session itself: the server's compaction threshold did not (is experimental.accuracy.autonomous_compact_at off, or compaction.threshold set above the backstop?)",
          { sessionID, tokens: context.tokens, backstopAt: compactAtTokens },
        )
        await compact(messages, `compacted the session at ${context.tokens} tokens`)
        if (!alive()) return
      }
      await send(text)
    }

    // POST /summarize, then wait for the session to be idle. The summary turn
    // becomes the baseline so it is never mistaken for a loop turn. Returns
    // false when no model is known to summarize with.
    const compact = async (messages: SessionMessage[], reason: string) => {
      const model = input.model ?? messages.findLast((message) => message.model !== null)?.model
      if (!model) return false
      await request(server, `/session/${sessionID}/summarize?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID }),
      })
      const since = now()
      while (await sessionBusy(server, sessionID)) {
        if (now() - since >= waitTimeoutMs)
          throw new Error(`session still busy ${seconds(now() - since)}s after compaction`)
        await sleep(pollIntervalMs)
        if (!alive()) return true
      }
      const after = await sessionMessages(server, sessionID)
      track.lastAssistantID = after.findLast((message) => message.role === "assistant")?.id ?? track.lastAssistantID
      track.sawBusy = false
      note(reason)
      return true
    }

    // The continue prompt for the current iteration, resent after a failed turn.
    const retryContinue = () => {
      const current = active
      if (!current) return null
      return continuePromptText(current.goal, current.completionMarker, current.iteration, current.maxIterations)
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

    // What the last verdict asked for: the next verifier gets it as untrusted notes.
    let lastMissing: { criterion: string; need: string }[] = []
    // Verifications dropped uncounted in a row (a stale goal); capped at MAX_DROPS.
    let drops = 0

    // One verification (§11.9) when the worker says it is done. Returns the worker's
    // next prompt, or null when the loop ended. The feedback in it is built from the
    // host's records only; a stale goal (or a failed verification) drops the attempt
    // without counting it.
    const verification = async (server: GoalLoopServer, input: GoalLoopStartInput): Promise<string | null> => {
      const current = active
      const verify = input.verify
      if (!current || !verify) return null
      const token = deps.hostToken?.(server)
      if (!token) {
        finish("unverified", "no host token: this loop cannot verify its goal")
        return null
      }
      touch({ phase: "verifying" })
      // The check commands (§11.9, ruling 1): the trusted ones from user-level and managed
      // config on the server, plus proposals the user approved for this project. A
      // proposal without approval (the worker's, or one pre-filled from the last input)
      // is not run.
      const resolveChecks = async () => {
        const trusted = (await request(server, `/experimental/goal/checks?directory=${encodeURIComponent(directory)}`, {
          method: "GET",
        })) as { checks?: unknown } | null
        const checks = Array.isArray(trusted?.checks)
          ? trusted.checks.filter((item): item is string => typeof item === "string")
          : []
        const proposals = (verify.proposals ?? []).filter((command) => !checks.includes(command))
        const approved = proposals.filter((command) => deps.checkApproved?.(directory, command) === true)
        const waiting = proposals.length - approved.length
        // the commands awaiting approval, for the UI's prompt (PR 4)
        const pending = proposals.filter((command) => !approved.includes(command))
        const running = active
        if (running) setState({ ...running, pendingChecks: pending, updatedAt: now() })
        if (waiting > 0) note(`${waiting} proposed check${waiting === 1 ? " awaits" : "s await"} approval`)
        return [...checks, ...approved]
      }
      const outcome = await resolveChecks()
        .then((checks) =>
          verifyOnce(
            {
              request: (path, init) =>
                request(server, path, {
                  method: init.method,
                  ...(init.body !== undefined ? { body: init.body } : {}),
                  ...(init.host ? { host: true } : {}),
                }),
              sleep,
              now,
              alive,
            },
            {
              workerID: sessionID,
              directory,
              goal: current.goal,
              checks,
              missingBefore: lastMissing,
              pollMs: pollIntervalMs,
              timeoutMs: verifyTimeoutMs,
              checkTimeoutMs,
              onVerifier: (id) => {
                const running = active
                if (running) setState({ ...running, verifierSessionID: id, updatedAt: now() })
              },
            },
          ),
        )
        .catch((error: unknown) => ({
        // Only a 409 from the verify route (the goal moved on) is uncounted, and that
        // comes back as "stale". Any error is a counted failed attempt, so errors cannot
        // be used to escape the limit (PR 2 review, 1).
        kind: "fail" as const,
        verdict: null,
        feedback: `An independent verification could not complete (${error instanceof Error ? error.message : String(error)}).`,
      }))
      if (!alive()) return null
      const running = active
      if (!running) return null
      const verdict =
        "verdict" in outcome && outcome.verdict
          ? { verdict: outcome.verdict.verdict, at: outcome.verdict.at, unmet: outcome.verdict.unmet }
          : (running.lastVerdict ?? null)
      setState({ ...running, verifierSessionID: null, lastVerdict: verdict, updatedAt: now() })
      touch({ phase: "turn" })
      if (outcome.kind === "pass") {
        finish("completed", null)
        return null
      }
      if (outcome.kind === "unverified") {
        finish("unverified", outcome.reason)
        return null
      }
      if (outcome.kind === "stale") {
        // uncounted, but capped: a goal that keeps moving cannot keep the loop unverified-free
        drops += 1
        if (drops >= MAX_DROPS) {
          finish("unverified", `${drops} verifications dropped in a row: ${outcome.reason}`)
          return null
        }
        note(outcome.reason)
        return nextContinue()
      }
      drops = 0
      const count = (running.verifications ?? 0) + 1
      const max = verify.maxVerifications ?? DEFAULT_MAX_VERIFICATIONS
      const counted = setState({ ...(active ?? running), verifications: count, updatedAt: now() })
      emit({ loopID: counted.id, type: "iteration", state: counted })
      if (count >= max) {
        finish("unverified", `${count} verifications without a PASS`)
        return null
      }
      lastMissing = outcome.verdict?.missing ?? []
      const next = nextContinue()
      return next === null ? null : `${outcome.feedback}\n\n${next}`
    }

    while (alive()) {
      if (track.delay > 0) {
        await sleep(track.delay)
        track.delay = 0
        if (!alive()) return
      }
      try {
        const busy = await sessionBusy(server, sessionID)
        touch({ checkedAt: now(), phase: busy ? "turn" : "waiting" })
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
          // newest message stops changing for waitTimeoutMs counts as stalled
          // (a silent hung command included). A tool whose output keeps
          // changing is progress, but only up to maxToolRunMs, so a command
          // that prints forever cannot hold the loop forever.
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
            if (progress.tool?.id !== watch.tool?.id) {
              watch.tool = progress.tool && { ...progress.tool, since: now(), noted: 0 }
            }
            if (progress.fingerprint !== watch.fingerprint) {
              const gap = now() - watch.progressAt
              if (watch.fingerprint !== null && gap * 4 >= waitTimeoutMs) {
                note(`working (progress resumed after ${seconds(gap)}s)`)
              }
              watch.fingerprint = progress.fingerprint
              watch.progressAt = now()
              watch.noted = 0
            }
          }
          const quiet = now() - watch.progressAt
          const toolAge = watch.tool ? now() - watch.tool.since : 0
          if (quiet < waitTimeoutMs && toolAge < maxToolRunMs) {
            // Report a long quiet stretch or a long-running tool at each quarter
            // of its limit, not every poll.
            const quietMilestone = Math.floor((4 * quiet) / waitTimeoutMs)
            const toolMilestone = Math.floor((4 * toolAge) / maxToolRunMs)
            if (quietMilestone > watch.noted) {
              watch.noted = quietMilestone
              note(`working (last progress ${seconds(quiet)}s ago)`)
            }
            if (watch.tool && toolMilestone > watch.tool.noted) {
              watch.tool.noted = toolMilestone
              note(`working (${watch.tool.name} running for ${seconds(toolAge)}s)`)
            }
            continue
          }
          const stall =
            quiet >= waitTimeoutMs
              ? `${watch.tool?.name ?? "session"} made no progress for ${seconds(quiet)}s`
              : `${watch.tool?.name} has been running for ${seconds(toolAge)}s, past the ${seconds(maxToolRunMs)}s limit`
          // the next stall window starts now; a tool that hit the hard cap
          // gets a fresh window too, so it fails after maxConsecutiveErrors
          // windows instead of on every poll
          watch.progressAt = now()
          watch.noted = 0
          if (watch.tool && toolAge >= maxToolRunMs) {
            watch.tool.since = now()
            watch.tool.noted = 0
          }
          throw new Error(stall)
        }
        track.watch = null

        const messages = await sessionMessages(server, sessionID)
        const last = messages.at(-1)
        if (last?.role === "user" && !last.harness && last.id !== track.staleUserID) {
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
            await sendOwed(messages)
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
        const current = active
        if (!current) return
        if (completionReached(turnText(messages), current.completionMarker)) {
          if (!input.verify) {
            finish("completed", null)
            return
          }
          // accuracy E §11.9: done only on an independent verifier's PASS
          const next = await verification(server, input)
          if (next === null) return
          track.owed = next
          await sendOwed(messages)
          continue
        }
        if (latest?.aborted) {
          track.errors = 0
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
        if (latest?.error) {
          // A failed turn (provider error, 0 tokens) is not an iteration: resend
          // the same step. A non-retryable 400 on a large or unknown context is
          // most likely an overflowed window, so compact once before counting it.
          const context = contextOf(messages)
          const overflow =
            latest.error.statusCode === 400 &&
            !latest.error.retryable &&
            (context === null || context.tokens > compactAtTokens)
          track.owed ??= retryContinue()
          if (track.owed === null) return
          if (overflow && !track.overflowCompacted) {
            track.overflowCompacted = true
            const size = context === null ? "an unknown number of" : String(context.tokens)
            if (await compact(messages, `compacted the session at ${size} tokens after a failed turn`)) continue
          }
          track.errors += 1
          if (track.errors >= maxConsecutiveErrors) {
            await interruptQuietly(server, sessionID)
            finish("failed", `turn failed ${track.errors} times in a row: ${latest.error.message}`)
            return
          }
          note(`recovered from a failed turn (${track.errors} of ${maxConsecutiveErrors}): ${latest.error.message}`)
          track.delay = Math.min(retryBackoffMs * 2 ** (track.errors - 1), maxBackoffMs)
          continue
        }
        track.errors = 0
        track.overflowCompacted = false
        // a continue still owed from an earlier abort or failed send covers this turn too
        track.owed ??= nextContinue()
        if (track.owed === null) return
        await sendOwed(messages)
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
    if (input.verify !== undefined) validateVerify(input.verify)
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
      phase: "turn",
      checkedAt: null,
      promptedAt: null,
      ...(input.verify ? { verifications: 0, verifierSessionID: null, lastVerdict: null } : {}),
    })
    deps.persistLast?.(input)
    emit({ loopID: state.id, type: "started", state })
    const token = input.verify ? deps.hostToken?.(server) : undefined
    if (input.verify && token) {
      // §11.9: the goal starts in the same host step as the first prompt, so the task
      // is recorded from it and no client can edit the first message before that
      await request(server, `/experimental/session/${sessionID}/goal?directory=${encodeURIComponent(directory)}`, {
        method: "POST",
        host: true,
        body: JSON.stringify({
          text: goal,
          ...(input.verify.criteria?.length ? { criteria: input.verify.criteria } : {}),
          prompt: promptBody(firstPromptText(goal, marker), input),
        }),
      })
    } else await prompt(server, sessionID, firstPromptText(goal, marker), input)
    touch({ promptedAt: now() })
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
    // A verification in flight is dropped, never counted: its verifier session stays
    // as it is, and a later loop verifies afresh (§11.9).
    const verifying = record.phase === "verifying" || Boolean(record.verifierSessionID)
    const next = setState({
      ...record,
      status: "stopped",
      reason: verifying ? "app restarted; the verification in flight was dropped" : "app restarted",
      ...(verifying ? { verifierSessionID: null } : {}),
      updatedAt: now(),
    })
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
