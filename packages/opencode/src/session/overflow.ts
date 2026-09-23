import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  return count(input.tokens) >= usable(input)
}

// isOverflow() judges the last finished turn, but the next request also carries
// the new prompt and asks for max_tokens on top. A turn that lands just under
// the usable limit can therefore make the next request exceed the window, and
// some gateways report that as a generic 400 instead of a context-length error.
// Within this margin, such a 400 is treated as an overflow.
export function isNearOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  return count(input.tokens) >= usable(input) * NEAR_OVERFLOW_RATIO
}

const NEAR_OVERFLOW_RATIO = 0.9

function count(tokens: SessionV1.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

/**
 * Autonomous turns compact once the prompt reaches this many tokens (#47).
 * Every request resends the whole prompt, so a long autonomous turn that only
 * compacts at a 1M window pays for ~500k tokens a request on average (measured
 * over the Muses' 7.9k requests); a cache miss resends all of it uncached.
 * Replaying those requests with compaction at 150k projected about -71% cost
 * (the lowest of 100k-400k).
 */
export const AUTONOMOUS_COMPACT_AT = 150_000

/**
 * Prompt size at which to compact before the model's limit, or undefined to
 * compact only at the limit. `compaction.threshold` applies to every turn;
 * otherwise autonomous turns use `experimental.accuracy.autonomous_compact_at`
 * (default AUTONOMOUS_COMPACT_AT). 0 turns either off; so does
 * `compaction.auto: false`. This is separate from `usable()`, which stays the
 * model's real limit: the near-overflow reading of an opaque 400 and the
 * preserved-tail budget depend on it.
 */
export function compactionThreshold(input: { cfg: ConfigV1.Info; autonomous?: boolean }): number | undefined {
  if (input.cfg.compaction?.auto === false) return undefined
  const configured = input.cfg.compaction?.threshold
  if (configured !== undefined) return configured > 0 ? configured : undefined
  if (input.autonomous !== true) return undefined
  const autonomous = input.cfg.experimental?.accuracy?.autonomous_compact_at ?? AUTONOMOUS_COMPACT_AT
  return autonomous > 0 ? autonomous : undefined
}

/**
 * The prompt of the last finished request is at the threshold. After a
 * compaction, `floor` is the prompt of the first request that followed it (the
 * system prompt, the summary and the kept tail); the prompt must then also have
 * grown by half a threshold over it, so a heavy system prompt cannot make every
 * request compact again.
 */
export function overThreshold(input: {
  tokens: SessionV1.Assistant["tokens"]
  threshold: number | undefined
  floor?: number
}) {
  if (input.threshold === undefined) return false
  const limit =
    input.floor === undefined
      ? input.threshold
      : Math.max(input.threshold, input.floor + Math.floor(input.threshold / 2))
  return count(input.tokens) >= limit
}

/**
 * The prompt size of the first finished request after the latest compaction
 * summary, or undefined when the session has not compacted (or nothing has
 * finished since). Works on any message order.
 */
export function floorAfterCompaction(messages: ReadonlyArray<SessionV1.WithParts>) {
  const assistants = messages
    .map((message) => message.info)
    .filter((info): info is SessionV1.Assistant => info.role === "assistant")
  const summary = assistants
    .filter((info) => info.summary === true)
    .reduce<
      SessionV1.Assistant | undefined
    >((latest, info) => (!latest || info.time.created > latest.time.created ? info : latest), undefined)
  if (!summary) return undefined
  const first = assistants
    .filter((info) => info.summary !== true && info.finish && info.time.created > summary.time.created)
    .filter((info) => count(info.tokens) > 0)
    .reduce<SessionV1.Assistant | undefined>(
      (earliest, info) => (!earliest || info.time.created < earliest.time.created ? info : earliest),
      undefined,
    )
  return first ? count(first.tokens) : undefined
}
