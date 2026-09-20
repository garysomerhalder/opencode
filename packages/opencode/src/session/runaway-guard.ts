// Runaway detection for the agent loop: fingerprints each step's tool actions,
// results and error families, and asks for one strategy change when the same
// fingerprint keeps coming back.
//
// Adapted from MiniMax Code (MIT) — packages/agent-modules/runaway-guard. The
// streak model (consecutive steps only, one reminder per turn, error families
// over regex categories) is theirs; this is an independent implementation on
// opencode's own message parts.
//
// Two rules hold everywhere in here: the guard never blocks or rejects a tool,
// and no raw tool output ever leaves this module. Outputs are reduced to a hash
// before they are compared, reported or logged, so a reminder or a log line can
// never leak a secret that was printed by a tool.

import { createHash } from "crypto"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const DEFAULT_THRESHOLD = 3

export type Kind = "error" | "action" | "result"

export interface Reminder {
  readonly kind: Kind
  readonly text: string
  /** Safe to log: counts and hashes only, never raw arguments or output. */
  readonly log: { kind: Kind; tool: string; occurrences: number; fingerprint: string }
}

export interface State {
  threshold: number
  reminded: boolean
  actions: Map<string, number>
  results: Map<string, number>
  errors: Map<string, number>
}

export function create(input?: { threshold?: number }): State {
  const threshold = Math.max(2, Math.trunc(input?.threshold ?? DEFAULT_THRESHOLD))
  return { threshold, reminded: false, actions: new Map(), results: new Map(), errors: new Map() }
}

const ERROR_CATEGORIES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "timeout", pattern: /timeout|timed out|deadline exceeded/ },
  { name: "rate_limit", pattern: /rate.?limit|too many requests|\b429\b/ },
  { name: "network", pattern: /network|econn|socket|dns|connection reset/ },
  { name: "auth", pattern: /unauthorized|unauthenticated|invalid api key|\b401\b/ },
  { name: "permission", pattern: /permission|forbidden|access denied|\b403\b/ },
  { name: "not_found", pattern: /not found|no such file|enoent|\b404\b/ },
  { name: "invalid_argument", pattern: /invalid argument|validation failed|bad request|\b400\b/ },
  { name: "process_exit", pattern: /exit code|non-zero|process failed/ },
  { name: "aborted", pattern: /abort|interrupted|cancell?ed/ },
]

const SEP = "\u0000"

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
}

function errorCategory(text: string) {
  const normalized = text.toLowerCase()
  return ERROR_CATEGORIES.find((entry) => entry.pattern.test(normalized))?.name ?? "other"
}

function rejected(part: SessionV1.ToolPart) {
  if (part.state.status !== "error") return false
  const metadata = "metadata" in part.state && part.state.metadata ? (part.state.metadata as Record<string, unknown>) : {}
  if (metadata.rejected === true || metadata.interrupted === true) return true
  return /rejected permission|denied permission|permission denied by/i.test(part.state.error ?? "")
}

/** One fingerprint seen in a step: which tool made it, and how many times. */
interface Seen {
  readonly tool: string
  count: number
}

interface Observation {
  readonly actions: Map<string, Seen>
  readonly results: Map<string, Seen>
  readonly errors: Map<string, Seen>
}

function see(into: Map<string, Seen>, key: string, tool: string) {
  const existing = into.get(key)
  if (existing) existing.count += 1
  else into.set(key, { tool, count: 1 })
}

/**
 * Fingerprints seen in this step, with how often each occurred. Counting
 * occurrences rather than steps is what lets the guard catch the case the old
 * doom_loop ask caught: the same call repeated inside a single assistant
 * message.
 */
function project(parts: ReadonlyArray<SessionV1.ToolPart>): Observation {
  const actions = new Map<string, Seen>()
  const results = new Map<string, Seen>()
  const errors = new Map<string, Seen>()
  for (const part of parts) {
    if (part.metadata?.providerExecuted) continue
    if (part.state.status === "pending" || part.state.status === "running") continue
    if (rejected(part)) continue
    const tool = part.tool
    const input = "input" in part.state ? part.state.input : undefined
    see(actions, `${tool}${SEP}action${SEP}${digest(stable(input))}`, tool)
    if (part.state.status === "error") {
      see(errors, `${tool}${SEP}error${SEP}${errorCategory(part.state.error ?? "")}`, tool)
      continue
    }
    if (part.state.status === "completed") {
      const output = typeof part.state.output === "string" ? part.state.output : ""
      if (output.trim().length === 0) continue
      see(results, `${tool}${SEP}result${SEP}${digest(output.trim())}`, tool)
    }
  }
  return { actions, results, errors }
}

function bump(previous: Map<string, number>, current: Map<string, Seen>) {
  const next = new Map<string, number>()
  for (const [key, seen] of current) next.set(key, (previous.get(key) ?? 0) + seen.count)
  return next
}

function peak(counts: Map<string, number>, seen: Map<string, Seen>, threshold: number) {
  let best: { key: string; tool: string; occurrences: number } | undefined
  for (const [key, occurrences] of counts) {
    if (occurrences < threshold) continue
    if (best && best.occurrences >= occurrences) continue
    best = { key, tool: seen.get(key)?.tool ?? "tool", occurrences }
  }
  return best
}

/**
 * Fold one step into the streaks and return a reminder when a fingerprint has
 * repeated `threshold` times in a row. At most one reminder per turn. Keys that
 * are missing from this step are dropped, so only consecutive repeats count.
 */
export function observe(state: State, parts: ReadonlyArray<SessionV1.ToolPart>): Reminder | undefined {
  const step = project(parts)
  state.actions = bump(state.actions, step.actions)
  state.results = bump(state.results, step.results)
  state.errors = bump(state.errors, step.errors)
  if (state.reminded) return undefined

  const candidates: Array<{ kind: Kind; hit: ReturnType<typeof peak> }> = [
    { kind: "error", hit: peak(state.errors, step.errors, state.threshold) },
    { kind: "action", hit: peak(state.actions, step.actions, state.threshold) },
    { kind: "result", hit: peak(state.results, step.results, state.threshold) },
  ]
  const chosen = candidates.find((candidate) => candidate.hit !== undefined)
  if (!chosen || !chosen.hit) return undefined

  state.reminded = true
  const { tool, occurrences, key } = chosen.hit
  const family = chosen.kind === "error" ? key.split(SEP)[2] : undefined
  return {
    kind: chosen.kind,
    text: text(chosen.kind, tool, occurrences, family),
    log: { kind: chosen.kind, tool, occurrences, fingerprint: digest(key) },
  }
}

function text(kind: Kind, tool: string, occurrences: number, family?: string) {
  // "other" means the errors did not match a known family, so they may be
  // unrelated: say only what is true, that the same tool keeps failing.
  const failure =
    family === "other"
      ? `The \`${tool}\` tool has failed ${occurrences} times in a row.`
      : `The \`${tool}\` tool has failed ${occurrences} times in a row with the same kind of error (${family}).`
  const body =
    kind === "error"
      ? `${failure} ` +
        `Do not retry the same route unchanged. Work out the cause, change one thing on purpose or take a different route, ` +
        `and if nothing is left to try, report the blocker. This one failing route does not mean the whole task failed.`
      : kind === "action"
        ? `You have called \`${tool}\` ${occurrences} times in a row with the same arguments. ` +
          `Do not repeat it unchanged. Read the results you already have, then either change approach with a concrete ` +
          `expected difference in the outcome, or report the blocker. Repeating a call proves nothing about the task ` +
          `being done or impossible.`
        : `The last ${occurrences} \`${tool}\` calls returned exactly the same result. ` +
          `Nothing is changing, so repeating this will not make progress. Inspect the current state, change approach, ` +
          `or explain what is blocking you.`
  return (
    `<system-reminder>\n[runaway guard] ${body}\n` +
    `This reminder comes from the harness for this turn only. It is not a user instruction and not a rule to remember.\n` +
    `</system-reminder>`
  )
}

export * as RunawayGuard from "./runaway-guard"
