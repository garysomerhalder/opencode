#!/usr/bin/env bun
// Token usage report for a session database (#47, Muse token efficiency).
//
//   bun script/token-report.ts --db <copy of opencode-dev.db> [--models ~/.cache/opencode/models.json]
//     [--since 2026-09-09] [--until 2026-09-24] [--provider opencode-go] [--model muse-spark-1.3-contributor]
//     [--compact-at 150000,250000] [--budget 65536:4096,131072:4096] [--cut 47000,68000]
//     [--after-compaction 75000] [--json]
//
// Levers are projected one at a time, then combined ("all of the above" takes
// the first value of each). --compact-at models compaction.threshold (every
// turn); --autonomous-compact-at models experimental.accuracy.autonomous_compact_at
// (turns sent with autonomous: true only). --cut is a fixed number of tokens taken off every
// request, e.g. the tool schemas or instructions a config change removes
// (measure those with script/prompt-probe.ts).
//
// Opens the database read-only; run it against a copy (VACUUM INTO) rather than
// the live file. Measures tokens per request by session and agent, the prompt
// floor (system prompt + tools), cache misses, compaction, and tool output, and
// projects each lever (compaction threshold, step budget, a fixed per-request
// cut) with the model's prices. The analysis is in token-usage.ts.

import { Database } from "bun:sqlite"
import { parseArgs } from "node:util"
import { TokenUsage } from "./token-usage"

const { values: args } = parseArgs({
  options: {
    db: { type: "string" },
    models: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "compact-at": { type: "string" },
    "autonomous-compact-at": { type: "string" },
    budget: { type: "string" },
    cut: { type: "string" },
    "after-compaction": { type: "string" },
    json: { type: "boolean" },
  },
})
if (!args.db) throw new Error("--db <path to a copy of the session database> is required")

const db = new Database(args.db, { readonly: true })
const since = args.since ? new Date(`${args.since}T00:00:00`).getTime() : 0
const until = args.until ? new Date(`${args.until}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER

// --- read ---------------------------------------------------------------

const steps = TokenUsage.readSteps(db)

const selected = steps.filter(
  (step) =>
    step.time >= since &&
    step.time < until &&
    (!args.provider || step.provider === args.provider) &&
    (!args.model || step.model === args.model),
)

// --- prices -------------------------------------------------------------

const catalog = args.models ? ((await Bun.file(args.models).json()) as Record<string, any>) : {}
const priceOf = (provider: string, model: string): TokenUsage.Price => {
  const cost = catalog[provider]?.models?.[model]?.cost
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cache_read ?? 0,
    cacheWrite: cost?.cache_write,
  }
}
const dominant = (list: ReadonlyArray<TokenUsage.Step>) => {
  const counts = TokenUsage.group(list, (step) => `${step.provider}\u0000${step.model}`)
  const [key] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [`\u0000`]
  const [provider, model] = key.split("\u0000")
  return priceOf(provider, model)
}

// --- measure ------------------------------------------------------------

const k = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : `${Math.round(n)}`
const usd = (n: number) => `$${n.toFixed(2)}`
const date = (t: number) => new Date(t).toLocaleDateString("sv-SE")

const report: Record<string, unknown> = {}
const out: string[] = []
const table = (header: string[], body: (string | number)[][]) => {
  out.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`)
  for (const row of body) out.push(`| ${row.join(" | ")} |`)
  out.push("")
}

out.push(`# Token usage: ${args.db}`, "")
out.push(
  `Filter: ${args.provider ?? "any provider"} / ${args.model ?? "any model"}, ${args.since ?? "start"} .. ${args.until ?? "end"}; ${selected.length} of ${steps.length} requests.`,
  "",
)

// 1. by provider and model
out.push("## 1. Requests by provider and model", "")
const byModel = [...TokenUsage.group(selected, (s) => `${s.provider}/${s.model}`).entries()].sort(
  (a, b) => b[1].length - a[1].length,
)
table(
  [
    "provider/model",
    "requests",
    "prompt/request (mean, p50, p90, max)",
    "uncached/request",
    "uncached",
    "cached read",
    "output",
    "cost (priced)",
    "cost (reported)",
    "uncached share of cost",
  ],
  byModel.map(([key, list]) => {
    const [provider, ...rest] = key.split("/")
    const t = TokenUsage.totals(list, priceOf(provider, rest.join("/")))
    return [
      key,
      t.requests,
      `${k(t.promptMean)}, ${k(t.promptP50)}, ${k(t.promptP90)}, ${k(t.promptMax)}`,
      k(t.inputMean),
      k(t.input),
      k(t.cacheRead),
      k(t.output + t.reasoning),
      usd(t.cost.total),
      usd(t.reportedCost),
      t.cost.total ? `${Math.round((100 * t.cost.input) / t.cost.total)}%` : "-",
    ]
  }),
)
report.byModel = Object.fromEntries(byModel.map(([key, list]) => [key, TokenUsage.totals(list, dominant(list))]))

// 2. by session and agent
out.push("## 2. By session and agent", "")
const titles = new Map(
  (db.query(`select id, title from session`).all() as any[]).map((row) => [row.id, row.title as string]),
)
const bySession = [...TokenUsage.group(selected, (s) => `${s.session}\u0000${s.agent}`).entries()].sort(
  (a, b) => b[1].length - a[1].length,
)
table(
  [
    "session",
    "agent",
    "days",
    "requests",
    "prompt/request mean",
    "p90",
    "uncached/request",
    "full misses (uncached)",
    "cost",
  ],
  bySession.map(([key, list]) => {
    const [session, agent] = key.split("\u0000")
    const t = TokenUsage.totals(list, dominant(list))
    const days = new Set(list.map((s) => date(s.time))).size
    return [
      (titles.get(session) ?? session).slice(0, 48),
      agent,
      days,
      t.requests,
      k(t.promptMean),
      k(t.promptP90),
      k(t.inputMean),
      `${t.fullMisses} (${k(t.fullMissInput)})`,
      usd(t.cost.total),
    ]
  }),
)

// 3. by day
out.push("## 3. By day", "")
const byDay = [...TokenUsage.group(selected, (s) => date(s.time)).entries()].sort()
table(
  ["day", "requests", "prompt/request", "uncached", "cached read", "output", "full misses", "cost"],
  byDay.map(([day, list]) => {
    const t = TokenUsage.totals(list, dominant(list))
    return [day, t.requests, k(t.promptMean), k(t.input), k(t.cacheRead), k(t.output), t.fullMisses, usd(t.cost.total)]
  }),
)

// 4. prompt size
out.push("## 4. Prompt size per request", "")
const edges = [25_000, 50_000, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 800_000]
const hist = TokenUsage.histogram(selected, edges)
table(
  ["prompt tokens", "requests", "share"],
  [
    ...edges.map((edge, i) => [
      `< ${k(edge)}`,
      hist.counts[i],
      `${((100 * hist.counts[i]) / Math.max(1, selected.length)).toFixed(1)}%`,
    ]),
    [`>= ${k(edges.at(-1)!)}`, hist.over, `${((100 * hist.over) / Math.max(1, selected.length)).toFixed(1)}%`],
  ],
)

// 5. floor: first request of a session and first request after a compaction
out.push("## 5. Prompt floor (system prompt + tools + first message)", "")
const ordered = TokenUsage.sessions(selected)
const firsts: number[] = []
const afterCompaction: number[] = []
const summaryOutputs: number[] = []
const compactionRows: (string | number)[][] = []
for (const [session, list] of ordered) {
  const first = list.find((s) => !s.summary)
  if (first) firsts.push(TokenUsage.promptTokens(first))
  list.forEach((step, i) => {
    if (!step.summary) return
    summaryOutputs.push(step.output + step.reasoning)
    const next = list.slice(i + 1).find((s) => !s.summary)
    const before = list
      .slice(0, i)
      .reverse()
      .find((s) => !s.summary)
    if (next) afterCompaction.push(TokenUsage.promptTokens(next))
    compactionRows.push([
      (titles.get(session) ?? session).slice(0, 40),
      date(step.time),
      before ? k(TokenUsage.promptTokens(before)) : "-",
      k(TokenUsage.promptTokens(step)),
      `${k(step.input)} / ${k(step.cacheRead)}`,
      next ? k(TokenUsage.promptTokens(next)) : "-",
    ])
  })
}
table(
  ["measure", "min", "p50", "max", "n"],
  [
    [
      "first request of a session",
      firsts.length ? k(Math.min(...firsts)) : "-",
      firsts.length ? k(TokenUsage.quantile(firsts, 0.5)) : "-",
      firsts.length ? k(Math.max(...firsts)) : "-",
      firsts.length,
    ],
    [
      "first request after a compaction",
      afterCompaction.length ? k(Math.min(...afterCompaction)) : "-",
      afterCompaction.length ? k(TokenUsage.quantile(afterCompaction, 0.5)) : "-",
      afterCompaction.length ? k(Math.max(...afterCompaction)) : "-",
      afterCompaction.length,
    ],
  ],
)

// 6. compaction
out.push("## 6. Compaction", "")
out.push(`Summary requests: ${compactionRows.length} in ${selected.length} requests.`, "")
if (compactionRows.length)
  table(
    ["session", "day", "prompt before", "summary prompt", "summary uncached / cached", "prompt after"],
    compactionRows,
  )

// 7. tool output
out.push("## 7. Tool output", "")
const calibration = TokenUsage.calibrate(selected)
const growth = [...ordered.values()].reduce((total, all) => {
  const list = all.filter((step) => TokenUsage.promptTokens(step) > 0)
  for (let i = 1; i < list.length; i++) {
    const delta = TokenUsage.promptTokens(list[i]) - TokenUsage.promptTokens(list[i - 1])
    if (delta > 0 && !list[i].summary && !list[i - 1].summary) total += delta
  }
  return total
}, 0)
const allTools = selected.flatMap((s) => s.tools)
const toolBytes = allTools.reduce((total, t) => total + t.bytes, 0)
out.push(
  `Tokens per byte of tool output (from ${calibration.pairs} step pairs): ${calibration.tokensPerByte.toFixed(3)} (median ${calibration.median.toFixed(3)}).`,
  `Tool output: ${allTools.length} results, ${k(toolBytes)} bytes, ~${k(toolBytes * calibration.tokensPerByte)} tokens; ` +
    `${Math.round((100 * toolBytes * calibration.tokensPerByte) / Math.max(1, growth))}% of all prompt growth (${k(growth)} tokens).`,
  "",
)
const toolGroups = new Map<string, TokenUsage.ToolOutput[]>()
for (const output of allTools) toolGroups.set(output.tool, [...(toolGroups.get(output.tool) ?? []), output])
const byTool = [...toolGroups.entries()]
  .map(([tool, list]) => ({
    tool,
    count: list.length,
    bytes: list.reduce((total, t) => total + t.bytes, 0),
    max: Math.max(...list.map((t) => t.bytes)),
    cut: list.filter((t) => t.cut).length,
  }))
  .sort((a, b) => b.bytes - a.bytes)
table(
  ["tool", "results", "bytes", "share", "mean", "max", "cut to file"],
  byTool
    .slice(0, 15)
    .map((t) => [
      t.tool,
      t.count,
      k(t.bytes),
      `${((100 * t.bytes) / Math.max(1, toolBytes)).toFixed(1)}%`,
      k(t.bytes / t.count),
      k(t.max),
      t.cut,
    ]),
)
const stepBytes = selected.map((s) => s.tools.reduce((total, t) => total + t.bytes, 0))
table(
  ["tool output in one step", "steps"],
  [16_384, 32_768, 65_536, 131_072].map((limit) => [`> ${k(limit)} bytes`, stepBytes.filter((b) => b > limit).length]),
)

// 8. levers
out.push("## 8. Levers (projected, same requests replayed)", "")
// The prompt right after a compaction, from every compaction in the database
// (a filtered slice may contain none, and its first requests may carry
// contexts that were already large).
const observedAfter = [...TokenUsage.sessions(steps).values()].flatMap((all) => {
  const list = all.filter((step) => TokenUsage.promptTokens(step) > 0)
  return list.flatMap((step, i) => {
    if (!step.summary) return []
    const next = list.slice(i + 1).find((s) => !s.summary)
    return next ? [TokenUsage.promptTokens(next)] : []
  })
})
const options: TokenUsage.ProjectOptions = {
  tokensPerByte: calibration.tokensPerByte,
  afterCompaction: args["after-compaction"]
    ? Number(args["after-compaction"])
    : TokenUsage.quantile(observedAfter.length ? observedAfter : firsts, 0.5),
  summaryOutput: TokenUsage.quantile(summaryOutputs.length ? summaryOutputs : [2_500], 0.5),
}
out.push(
  `Assumptions: ${options.tokensPerByte.toFixed(3)} tokens per byte; prompt after a compaction ${k(options.afterCompaction)}; summary output ${k(options.summaryOutput)} tokens; summary requests read no cache (as observed).`,
  "",
)
const levers: { name: string; lever: TokenUsage.Lever }[] = [{ name: "actual (no lever)", lever: {} }]
for (const value of (args["compact-at"] ?? "").split(",").filter(Boolean))
  levers.push({ name: `compaction.threshold ${k(Number(value))} (all turns)`, lever: { compactAt: Number(value) } })
for (const value of (args["autonomous-compact-at"] ?? "").split(",").filter(Boolean))
  levers.push({
    name: `autonomous_compact_at ${k(Number(value))} (autonomous turns only)`,
    lever: { autonomousCompactAt: Number(value) },
  })
for (const value of (args.budget ?? "").split(",").filter(Boolean)) {
  const [stepBytes, floorBytes] = value.split(":").map(Number)
  levers.push({
    name: `step budget ${k(stepBytes)} / floor ${k(floorBytes)}`,
    lever: { budget: { stepBytes, floorBytes } },
  })
}
for (const value of (args.cut ?? "").split(",").filter(Boolean))
  levers.push({ name: `${k(Number(value))} fewer tokens per request`, lever: { perRequestCut: Number(value) } })
if (levers.length > 2)
  levers.push({
    name: "all of the above (first of each)",
    lever: Object.assign(
      {},
      ...levers
        .slice(1)
        .map((l) => l.lever)
        .reverse(),
    ),
  })

const projections = levers.map(({ name, lever }) => {
  let total = {
    requests: 0,
    compactions: 0,
    prompt: 0,
    promptMax: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
  }
  for (const list of ordered.values()) {
    const p = TokenUsage.project(list, lever, options)
    // priced exactly as totals() prices the actual requests: writes at their price, reasoning as output
    const cost = TokenUsage.priced(p, dominant(list)).total
    total = {
      requests: total.requests + p.requests,
      compactions: total.compactions + p.compactions,
      prompt: total.prompt + p.prompt,
      promptMax: Math.max(total.promptMax, p.promptMax),
      input: total.input + p.input,
      cacheRead: total.cacheRead + p.cacheRead,
      cacheWrite: total.cacheWrite + p.cacheWrite,
      output: total.output + p.output,
      reasoning: total.reasoning + p.reasoning,
      cost: total.cost + cost,
    }
  }
  return { name, lever, ...total }
})
const baseline = projections[0]
table(
  [
    "lever",
    "requests",
    "compactions",
    "prompt/request",
    "max prompt",
    "uncached",
    "cached read",
    "cost",
    "per request",
    "vs actual",
  ],
  projections.map((p) => [
    p.name,
    p.requests,
    p.compactions,
    k(p.prompt / p.requests),
    k(p.promptMax),
    k(p.input),
    k(p.cacheRead),
    usd(p.cost),
    `$${((1000 * p.cost) / p.requests).toFixed(3)}/1k`,
    `${p.cost >= baseline.cost ? "+" : ""}${Math.round((100 * (p.cost - baseline.cost)) / Math.max(1e-9, baseline.cost))}%`,
  ]),
)
report.projections = projections
report.calibration = calibration
report.options = options

if (args.json) console.log(JSON.stringify(report, null, 2))
else console.log(out.join("\n"))
