// Token usage analysis for the session database (#47, Muse token efficiency).
//
// Pure: plain step records in, numbers out. The CLI (token-report.ts) reads
// the database and prints; everything that decides a number lives here so it
// is tested and ports as-is.
//
// A "step" is one model request: its step-finish part carries the token counts
// the provider reported. The prompt of a request is uncached input + cached
// read + cache write.

import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { OutputBudget } from "../src/session/output-budget"
import { overThreshold } from "../src/session/overflow"

/** Dollars per million tokens. */
export interface Price {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite?: number
}

export interface ToolOutput {
  readonly tool: string
  readonly callID: string
  /** Bytes of the output the model sees (after the per-call cap). */
  readonly bytes: number
  /** Already cut to a file by the per-call cap or the shell. */
  readonly cut: boolean
}

export interface Step {
  readonly session: string
  readonly message: string
  readonly agent: string
  readonly provider: string
  readonly model: string
  readonly time: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number
  /** The request that wrote a compaction summary. */
  readonly summary: boolean
  /** The turn was sent with `autonomous: true` (the desktop goal loop). */
  readonly autonomous: boolean
  /** Tool outputs produced in this step (they are in the prompt from the next step on). */
  readonly tools: ReadonlyArray<ToolOutput>
}

export const promptTokens = (step: Step) => step.input + step.cacheRead + step.cacheWrite

/** Below this a request is too small for a cache miss to matter. */
const MISS_FLOOR = 20_000

/** Most of a large prompt went uncached: the provider did not reuse its cache for this request. */
export function fullMiss(step: Step) {
  const prompt = promptTokens(step)
  return prompt >= MISS_FLOOR && step.input >= 0.5 * prompt
}

export function priced(
  tokens: { input: number; cacheRead: number; cacheWrite?: number; output: number; reasoning?: number },
  price: Price,
) {
  const input = (tokens.input * price.input) / 1e6
  const cacheRead = (tokens.cacheRead * price.cacheRead) / 1e6
  const cacheWrite = ((tokens.cacheWrite ?? 0) * (price.cacheWrite ?? price.input)) / 1e6
  const output = ((tokens.output + (tokens.reasoning ?? 0)) * price.output) / 1e6
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output }
}

export function quantile(values: ReadonlyArray<number>, q: number) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

export interface Totals {
  readonly requests: number
  readonly prompt: number
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
  readonly reportedCost: number
  readonly promptMean: number
  readonly promptP50: number
  readonly promptP90: number
  readonly promptMax: number
  readonly inputMean: number
  readonly fullMisses: number
  readonly fullMissInput: number
  readonly cost: ReturnType<typeof priced>
}

export function totals(steps: ReadonlyArray<Step>, price: Price): Totals {
  const prompts = steps.map(promptTokens)
  const sum = (pick: (step: Step) => number) => steps.reduce((total, step) => total + pick(step), 0)
  const misses = steps.filter(fullMiss)
  const tokens = {
    input: sum((s) => s.input),
    cacheRead: sum((s) => s.cacheRead),
    cacheWrite: sum((s) => s.cacheWrite),
    output: sum((s) => s.output),
    reasoning: sum((s) => s.reasoning),
  }
  const prompt = prompts.reduce((a, b) => a + b, 0)
  return {
    requests: steps.length,
    prompt,
    ...tokens,
    reportedCost: sum((s) => s.cost),
    promptMean: steps.length ? prompt / steps.length : 0,
    promptP50: quantile(prompts, 0.5),
    promptP90: quantile(prompts, 0.9),
    promptMax: prompts.length ? Math.max(...prompts) : 0,
    inputMean: steps.length ? tokens.input / steps.length : 0,
    fullMisses: misses.length,
    fullMissInput: misses.reduce((total, s) => total + s.input, 0),
    cost: priced(tokens, price),
  }
}

export function group<K>(steps: ReadonlyArray<Step>, key: (step: Step) => K) {
  const groups = new Map<K, Step[]>()
  for (const step of steps) {
    const k = key(step)
    const list = groups.get(k)
    if (list) list.push(step)
    else groups.set(k, [step])
  }
  return groups
}

/** Steps per prompt-size bucket; `edges` are the upper bounds, ascending. */
export function histogram(steps: ReadonlyArray<Step>, edges: ReadonlyArray<number>) {
  const counts = edges.map(() => 0)
  let over = 0
  for (const step of steps) {
    const prompt = promptTokens(step)
    const index = edges.findIndex((edge) => prompt < edge)
    if (index === -1) over++
    else counts[index]++
  }
  return { edges, counts, over }
}

/** Steps in time order within each session. */
export function sessions(steps: ReadonlyArray<Step>) {
  const bySession = group(steps, (step) => step.session)
  for (const list of bySession.values()) list.sort((a, b) => a.time - b.time)
  return bySession
}

/**
 * Tokens per byte of tool output, from consecutive steps of one turn: the next
 * prompt grows by the previous step's output tokens plus its tool outputs.
 * Only pairs where tool output dominates the growth are used.
 */
export function calibrate(steps: ReadonlyArray<Step>) {
  let tokens = 0
  let bytes = 0
  const ratios: number[] = []
  for (const all of sessions(steps).values()) {
    const list = all.filter((step) => promptTokens(step) > 0)
    for (let i = 1; i < list.length; i++) {
      const previous = list[i - 1]
      const current = list[i]
      if (previous.summary || current.summary) continue
      const added = previous.tools.reduce((total, tool) => total + tool.bytes, 0)
      if (added < 8_000) continue
      const growth = promptTokens(current) - promptTokens(previous) - previous.output
      if (growth <= 0) continue
      tokens += growth
      bytes += added
      ratios.push(growth / added)
    }
  }
  return { tokensPerByte: bytes ? tokens / bytes : 0.25, pairs: ratios.length, median: quantile(ratios, 0.5) }
}

/** No request is smaller than this: the base system prompt and built-in tools. */
const MIN_PROMPT = 10_000

export interface Lever {
  /** `compaction.threshold`: every turn compacts once the last request reached this many tokens. */
  readonly compactAt?: number
  /** `experimental.accuracy.autonomous_compact_at`: the same, for autonomous turns only. */
  readonly autonomousCompactAt?: number
  /** The per-step tool-output budget. */
  readonly budget?: OutputBudget.Settings
  /** Tokens taken off every request (system prompt, skill list). */
  readonly perRequestCut?: number
}

export interface ProjectOptions {
  readonly tokensPerByte: number
  /** Prompt size right after a compaction (system prompt + summary + kept tail). */
  readonly afterCompaction: number
  /** Output tokens of a summary request. */
  readonly summaryOutput: number
}

export interface Projection {
  readonly requests: number
  readonly compactions: number
  readonly prompt: number
  readonly promptMax: number
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
}

/**
 * Replays one session's requests with a lever applied.
 *
 * The simulated prompt follows the actual prompt's growth from step to step,
 * minus what the lever removes; where the actual prompt shrank (a compaction
 * that really happened) the simulated one shrinks to at most the actual size.
 * Uncached input keeps its actual size for an ordinary step (the new tokens of
 * that step); for a full cache miss it is the whole simulated prompt, scaled by
 * the actual miss ratio; cache writes keep their actual size where they fit.
 * Compaction follows the product: before each request, overThreshold (the
 * product's function) looks at the last finished request's tokens.total (prompt,
 * output and reasoning), with the re-compaction floor reset by every summary, real or simulated.
 * A simulated compaction costs one summary request with the history sent
 * uncached (as observed: summary requests read no cache; the whole simulated
 * prompt is charged, which overstates it, since observed summaries send about
 * half) and makes the next request a full miss. With no lever it reproduces the
 * actual tokens exactly, cache writes and reasoning included.
 */
export function project(steps: ReadonlyArray<Step>, lever: Lever, options: ProjectOptions): Projection {
  const cut = lever.perRequestCut ?? 0
  const total = {
    requests: 0,
    compactions: 0,
    prompt: 0,
    promptMax: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  }
  let simulated = 0
  let previousActual = 0
  let carried = 0
  let missNext = false
  // What the product looks at before each request: the last finished request's
  // tokens (prompt + output + reasoning), and the floor its re-compaction guard uses, the
  // first request after the latest summary (real or simulated).
  let last: { tokens: SessionV1.Assistant["tokens"]; summary: boolean } | undefined
  let floor: number | undefined
  let floorPending = false

  const send = (request: {
    size: number
    uncached: number
    write: number
    output: number
    reasoning: number
    summary: boolean
  }) => {
    const read = request.size - request.uncached - request.write
    total.requests++
    total.prompt += request.size
    total.promptMax = Math.max(total.promptMax, request.size)
    total.input += request.uncached
    total.cacheRead += read
    total.cacheWrite += request.write
    total.output += request.output
    total.reasoning += request.reasoning
    // the product counts tokens.total (the provider's totalTokens: prompt, output
    // and reasoning), both for the threshold and for the guard's floor
    const count = request.size + request.output + request.reasoning
    const tokens = {
      total: count,
      input: request.uncached,
      output: request.output,
      reasoning: request.reasoning,
      cache: { read, write: request.write },
    }
    if (floorPending && !request.summary) {
      floor = count
      floorPending = false
    }
    last = { tokens, summary: request.summary }
  }
  // compaction.threshold applies to every turn; the autonomous default only to autonomous ones
  const thresholdFor = (step: Step) => lever.compactAt ?? (step.autonomous ? lever.autonomousCompactAt : undefined)

  // A request that failed reports no tokens: it cost nothing and says nothing
  // about the prompt, so it is not replayed.
  steps
    .filter((step) => promptTokens(step) > 0)
    .forEach((step, index) => {
      const actual = promptTokens(step)
      if (index === 0) simulated = actual
      else {
        const growth = actual - previousActual
        simulated = growth >= 0 ? simulated + growth - carried : Math.min(simulated, actual)
      }
      carried = 0
      previousActual = actual

      // prompt.ts: before the next request, the last finished one (not a summary)
      // is checked with overThreshold, the same function the product calls
      const threshold = thresholdFor(step)
      if (
        threshold !== undefined &&
        !step.summary &&
        last &&
        !last.summary &&
        overThreshold({ tokens: last.tokens, threshold, floor })
      ) {
        total.compactions++
        const history = Math.max(MIN_PROMPT, simulated - cut)
        send({ size: history, uncached: history, write: 0, output: options.summaryOutput, reasoning: 0, summary: true })
        // the observed prompt after a compaction includes whatever the cut removes
        simulated = Math.min(simulated, options.afterCompaction)
        missNext = true
        floorPending = true
      }

      const size = Math.max(MIN_PROMPT, simulated - cut)
      const uncached = missNext
        ? size
        : fullMiss(step)
          ? Math.min(size, Math.round((step.input / actual) * size))
          : Math.min(size, step.input)
      const write = missNext ? 0 : Math.min(step.cacheWrite, size - uncached)
      missNext = false
      send({ size, uncached, write, output: step.output, reasoning: step.reasoning, summary: step.summary })
      // a summary that really happened resets the guard's floor, as in the product
      if (step.summary) floorPending = true

      if (lever.budget) {
        const decisions = OutputBudget.plan(
          step.tools.map((tool) => ({ callID: tool.callID, tool: tool.tool, bytes: tool.bytes, archived: tool.cut })),
          lever.budget,
        )
        const removed = decisions.reduce((sum, d) => sum + d.bytes - d.maxBytes, 0)
        carried = Math.round(removed * options.tokensPerByte)
      }
    })

  return total
}

/**
 * Reads every request (step-finish part) of a session database, with the tool
 * outputs produced in that step and the flags of its message and turn. Read-only:
 * SELECTs only. Parts are taken in id order within a message; a step's tools are
 * the tool parts since the previous step-finish of the same message.
 */
export function readSteps(db: { query: (sql: string) => { all: () => unknown[] } }): Step[] {
  const users = new Map(
    (
      db
        .query(
          `select id, json_extract(data,'$.autonomous') autonomous from message where json_extract(data,'$.role') = 'user'`,
        )
        .all() as { id: string; autonomous: unknown }[]
    ).map((row) => [row.id, row.autonomous === 1 || row.autonomous === true]),
  )
  const messages = new Map(
    (
      db
        .query(
          `select id, time_created t, json_extract(data,'$.agent') agent, json_extract(data,'$.providerID') provider,
             json_extract(data,'$.modelID') model, json_extract(data,'$.summary') summary,
             json_extract(data,'$.parentID') parent
           from message where json_extract(data,'$.role') = 'assistant'`,
        )
        .all() as {
        id: string
        t: number
        agent: string | null
        provider: string | null
        model: string | null
        summary: unknown
        parent: string | null
      }[]
    ).map((row) => [row.id, row]),
  )
  const rows = db
    .query(
      `select id, message_id, session_id, json_extract(data,'$.type') type,
         case when json_extract(data,'$.type') = 'step-finish' then data end data,
         case when json_extract(data,'$.type') = 'tool'
           then length(cast(coalesce(json_extract(data,'$.state.output'),'') as blob)) end bytes,
         case when json_extract(data,'$.type') = 'tool' then json_extract(data,'$.tool') end tool,
         case when json_extract(data,'$.type') = 'tool' then json_extract(data,'$.callID') end call,
         case when json_extract(data,'$.type') = 'tool' then
           (json_extract(data,'$.state.metadata.outputPath') is not null
            or json_extract(data,'$.state.metadata.archive') is not null) end cut
       from part
       where json_extract(data,'$.type') in ('step-finish','tool')
       order by message_id, id`,
    )
    .all() as {
    id: string
    message_id: string
    session_id: string
    type: string
    data: string | null
    bytes: number | null
    tool: string | null
    call: string | null
    cut: number | null
  }[]

  const steps: Step[] = []
  let pending: ToolOutput[] = []
  let current = ""
  let index = 0
  for (const row of rows) {
    if (row.message_id !== current) {
      current = row.message_id
      pending = []
      index = 0
    }
    if (row.type === "tool") {
      pending.push({ tool: row.tool ?? "?", callID: row.call ?? row.id, bytes: row.bytes ?? 0, cut: row.cut === 1 })
      continue
    }
    const message = messages.get(row.message_id)
    if (!message) continue
    const data = JSON.parse(row.data ?? "{}") as {
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      cost?: number
    }
    steps.push({
      session: row.session_id,
      message: row.message_id,
      agent: message.agent ?? "?",
      provider: message.provider ?? "?",
      model: message.model ?? "?",
      // steps of one message share its time; their order within it is kept
      time: message.t + index++ / 1000,
      input: data.tokens?.input ?? 0,
      output: data.tokens?.output ?? 0,
      reasoning: data.tokens?.reasoning ?? 0,
      cacheRead: data.tokens?.cache?.read ?? 0,
      cacheWrite: data.tokens?.cache?.write ?? 0,
      cost: data.cost ?? 0,
      summary: message.summary === 1 || message.summary === true,
      autonomous: users.get(message.parent ?? "") ?? false,
      tools: pending,
    })
    pending = []
  }
  return steps
}

export * as TokenUsage from "./token-usage"
