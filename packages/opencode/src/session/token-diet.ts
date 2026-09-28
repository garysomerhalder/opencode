/**
 * Token diet: the per-request levers measured on the Muses' sessions
 * (four autonomous sessions, 1,635 requests over 8.9 hours, 2026-09-27/28).
 *
 * What a request carried, on average (about 93k prompt tokens):
 * - the system prompt and tool definitions: about 37k (the first request of
 *   each session);
 * - tool output from earlier steps of the SAME turn: the bulk of the rest.
 *   An autonomous turn never ends, and `prune` only ever looked at turns
 *   before the last two user messages, so none of it was ever pruned.
 * - one request in three missed the provider's prompt cache past the first
 *   ~8.8k tokens: the instructions were re-read from disk on every step, and a
 *   global instruction file regenerated with a timestamp by another tool
 *   changed the prompt prefix mid-turn.
 *
 * So:
 * - `staleToolParts` picks the tool outputs of the current turn that are old
 *   enough to collapse to a one-line receipt (the full output stays on disk).
 *   It only picks once enough has piled up, so the prompt prefix (and with it
 *   the provider's cache) changes once per batch rather than on every step.
 * - `SystemPin` keeps a turn's system prompt fixed until the user sends a new
 *   message or the session compacts.
 */
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { HarnessNote } from "./harness-note"

/** Tool outputs never collapsed: a loaded skill is the instructions the agent follows. */
export const PROTECTED_TOOLS = new Set(["skill"])
/** The most recent tool outputs of a turn that stay in full. */
export const DEFAULT_KEEP = 8
/** Collapse only once the stale outputs add up to this many (estimated) tokens. */
export const DEFAULT_MIN_TOKENS = 20_000
/** An output smaller than this is left alone: its receipt would save almost nothing. */
export const MIN_PART_TOKENS = 200

export type Settings = {
  pinSystem: boolean
  prune: boolean
  keep: number
  minTokens: number
}

export function settings(cfg: ConfigV1.Info | undefined): Settings {
  const diet = cfg?.experimental?.token_diet
  return {
    pinSystem: diet?.pin_system_prompt ?? true,
    prune: cfg?.compaction?.auto === false ? false : (diet?.prune_tool_outputs ?? true),
    keep: diet?.prune_keep ?? DEFAULT_KEEP,
    minTokens: diet?.prune_min_tokens ?? DEFAULT_MIN_TOKENS,
  }
}

/**
 * Completed tool parts, newest first, that are in the prompt (not already
 * collapsed), stopping at the latest compaction summary: what came before it
 * is not sent.
 */
function liveToolParts(messages: ReadonlyArray<SessionV1.WithParts>) {
  const out: SessionV1.ToolPart[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role === "assistant" && msg.info.summary) break
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j]
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (part.state.time.compacted) continue
      if (PROTECTED_TOOLS.has(part.tool)) continue
      out.push(part)
    }
  }
  return out
}

/**
 * The tool outputs to collapse now: every one older than the `keep` most
 * recent, if together they reach `minTokens`; otherwise none, so the prompt
 * is not rewritten (and its cache lost) for a small saving.
 */
export function staleToolParts(input: {
  messages: ReadonlyArray<SessionV1.WithParts>
  keep: number
  minTokens: number
  estimate: (text: string) => number
}): SessionV1.ToolPart[] {
  const live = liveToolParts(input.messages)
  const candidates = live
    .slice(Math.max(0, input.keep))
    .filter((part) => part.state.status === "completed" && input.estimate(part.state.output) >= MIN_PART_TOKENS)
  const total = candidates.reduce(
    (sum, part) => sum + (part.state.status === "completed" ? input.estimate(part.state.output) : 0),
    0,
  )
  return total >= input.minTokens ? candidates : []
}

/**
 * What a pinned system prompt is keyed on: the real user message being
 * answered (harness notes do not count) and the latest compaction summary.
 * Either changing is a point where the prompt cache is lost anyway.
 */
export function pinKey(messages: ReadonlyArray<SessionV1.WithParts>) {
  const user = HarnessNote.lastRealUser([...messages])
  const summary = messages.findLast((msg) => msg.info.role === "assistant" && msg.info.summary)
  return `${user?.info.id ?? "-"}|${summary?.info.id ?? "-"}`
}

/** Keeps one value per session for as long as its key is unchanged. */
export class SystemPin<A> {
  private readonly pins = new Map<string, { key: string; value: A }>()

  get<E, R>(session: string, key: string, load: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    const pinned = this.pins.get(session)
    if (pinned && pinned.key === key) return Effect.succeed(pinned.value)
    return load.pipe(Effect.tap((value) => Effect.sync(() => this.pins.set(session, { key, value }))))
  }

  drop(session: string) {
    this.pins.delete(session)
  }

  get size() {
    return this.pins.size
  }
}

export * as TokenDiet from "./token-diet"
