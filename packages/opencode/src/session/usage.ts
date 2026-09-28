/**
 * Per-session token accounting: one row per model call, totals, and the burn
 * rate, so a watchdog can report how fast each session spends its quota.
 *
 * A call is an assistant message the provider reported usage for. Its prompt
 * is uncached input + cache read + cache write: what the request sent.
 */
import { Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const Call = Schema.Struct({
  messageID: Schema.String,
  time: Schema.Number.annotate({ description: "When the call started (ms since epoch)" }),
  completed: Schema.optional(Schema.Number),
  agent: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  input: Schema.Number.annotate({ description: "Uncached input tokens" }),
  output: Schema.Number,
  reasoning: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  prompt: Schema.Number.annotate({ description: "input + cacheRead + cacheWrite: the tokens the request sent" }),
  cost: Schema.Number,
  summary: Schema.Boolean.annotate({ description: "A compaction summary call" }),
})
export type Call = typeof Call.Type

export const Totals = Schema.Struct({
  calls: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  prompt: Schema.Number,
  cost: Schema.Number,
})
export type Totals = typeof Totals.Type

export const Rate = Schema.Struct({
  first: Schema.optional(Schema.Number),
  last: Schema.optional(Schema.Number),
  hours: Schema.Number.annotate({ description: "From the first call to the last (or to now, for `window`)" }),
  callsPerHour: Schema.Number,
  promptPerHour: Schema.Number,
  uncachedPerHour: Schema.Number.annotate({ description: "Uncached input + cache write tokens per hour" }),
  outputPerHour: Schema.Number,
  costPerHour: Schema.Number,
})
export type Rate = typeof Rate.Type

export const Info = Schema.Struct({
  sessionID: Schema.String,
  totals: Totals,
  rate: Rate,
  window: Schema.Struct({
    minutes: Schema.Number,
    totals: Totals,
    rate: Rate,
  }).annotate({ description: "The same over the last `window` minutes, ending now" }),
  calls: Schema.Array(Call),
})
export type Info = typeof Info.Type

export const DEFAULT_WINDOW_MINUTES = 60

export function calls(messages: ReadonlyArray<SessionV1.Info>): Call[] {
  return messages.flatMap((info): Call[] => {
    if (info.role !== "assistant") return []
    const t = info.tokens
    const prompt = t.input + t.cache.read + t.cache.write
    if (prompt === 0 && t.output === 0) return []
    return [
      {
        messageID: info.id,
        time: info.time.created,
        ...(info.time.completed === undefined ? {} : { completed: info.time.completed }),
        agent: info.agent,
        providerID: info.providerID,
        modelID: info.modelID,
        input: t.input,
        output: t.output,
        reasoning: t.reasoning,
        cacheRead: t.cache.read,
        cacheWrite: t.cache.write,
        prompt,
        cost: info.cost,
        summary: info.summary === true,
      },
    ]
  })
}

export function totals(rows: ReadonlyArray<Call>): Totals {
  return rows.reduce<Totals>(
    (sum, row) => ({
      calls: sum.calls + 1,
      input: sum.input + row.input,
      output: sum.output + row.output,
      reasoning: sum.reasoning + row.reasoning,
      cacheRead: sum.cacheRead + row.cacheRead,
      cacheWrite: sum.cacheWrite + row.cacheWrite,
      prompt: sum.prompt + row.prompt,
      cost: sum.cost + row.cost,
    }),
    { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, prompt: 0, cost: 0 },
  )
}

function rate(sum: Totals, first: number | undefined, last: number | undefined, spanMs: number): Rate {
  const hours = Math.max(0, spanMs) / 3_600_000
  const per = (value: number) => (hours > 0 ? value / hours : 0)
  return {
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
    hours,
    callsPerHour: per(sum.calls),
    promptPerHour: per(sum.prompt),
    uncachedPerHour: per(sum.input + sum.cacheWrite),
    outputPerHour: per(sum.output + sum.reasoning),
    costPerHour: per(sum.cost),
  }
}

const end = (row: Call) => row.completed ?? row.time

export function summarize(input: {
  sessionID: string
  messages: ReadonlyArray<SessionV1.Info>
  now: number
  windowMinutes?: number
  /** Leave out the per-call rows (totals and rates only). */
  omitCalls?: boolean
}): Info {
  const rows = calls(input.messages)
  const all = totals(rows)
  const first = rows.at(0)?.time
  const last = rows.length > 0 ? Math.max(...rows.map(end)) : undefined
  const minutes = input.windowMinutes ?? DEFAULT_WINDOW_MINUTES
  const since = input.now - minutes * 60_000
  const recent = rows.filter((row) => end(row) >= since)
  const windowTotals = totals(recent)
  return {
    sessionID: input.sessionID,
    totals: all,
    rate: rate(all, first, last, first === undefined || last === undefined ? 0 : last - first),
    window: {
      minutes,
      totals: windowTotals,
      rate: rate(
        windowTotals,
        recent.at(0)?.time,
        recent.length > 0 ? Math.max(...recent.map(end)) : undefined,
        minutes * 60_000,
      ),
    },
    calls: input.omitCalls ? [] : rows,
  }
}

export * as SessionUsage from "./usage"
