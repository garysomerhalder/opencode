import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { TokenUsage } from "../../script/token-usage"

const price = { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0.125 }

let clock = 0
const step = (input: Partial<TokenUsage.Step> & { prompt?: number } = {}): TokenUsage.Step => {
  const prompt = input.prompt ?? 100_000
  const uncached = input.input ?? 2_000
  const write = input.cacheWrite ?? 0
  return {
    session: "s1",
    message: `m${clock}`,
    agent: "build",
    provider: "opencode-go",
    model: "muse",
    time: clock++,
    output: 500,
    reasoning: 0,
    cost: 0,
    summary: false,
    autonomous: false,
    tools: [],
    ...input,
    input: uncached,
    cacheWrite: write,
    cacheRead: input.cacheRead ?? prompt - uncached - write,
  }
}

describe("TokenUsage basics", () => {
  test("prompt tokens are uncached + cached read + cache write", () => {
    expect(TokenUsage.promptTokens(step({ prompt: 50_000, input: 1_000, cacheWrite: 4_000 }))).toBe(50_000)
  })

  test("a full cache miss is most of a large prompt sent uncached", () => {
    expect(TokenUsage.fullMiss(step({ prompt: 500_000, input: 480_000 }))).toBe(true)
    expect(TokenUsage.fullMiss(step({ prompt: 500_000, input: 20_000 }))).toBe(false)
    // a small request is not a meaningful miss
    expect(TokenUsage.fullMiss(step({ prompt: 5_000, input: 5_000 }))).toBe(false)
  })

  test("priced splits the cost per million tokens; reasoning is billed as output, writes at their price", () => {
    const cost = TokenUsage.priced(
      { input: 100_000, cacheRead: 890_000, cacheWrite: 10_000, output: 10_000, reasoning: 5_000 },
      price,
    )
    expect(cost.input).toBeCloseTo(0.01)
    expect(cost.cacheRead).toBeCloseTo(0.00178)
    expect(cost.cacheWrite).toBeCloseTo(0.00125)
    expect(cost.output).toBeCloseTo(0.003)
    expect(cost.total).toBeCloseTo(0.01603)
    // no write price: writes cost what uncached input costs
    expect(
      TokenUsage.priced({ input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0 }, { ...price, cacheWrite: undefined })
        .total,
    ).toBeCloseTo(0.1)
  })

  test("quantile is nearest-rank", () => {
    expect(TokenUsage.quantile([5, 1, 4, 2, 3], 0.5)).toBe(3)
    expect(TokenUsage.quantile([5, 1, 4, 2, 3], 1)).toBe(5)
    expect(TokenUsage.quantile([], 0.5)).toBe(0)
  })

  test("totals add up and give per-request means and percentiles", () => {
    const steps = [step({ prompt: 100_000 }), step({ prompt: 300_000 }), step({ prompt: 200_000 })]
    const t = TokenUsage.totals(steps, price)
    expect(t.requests).toBe(3)
    expect(t.prompt).toBe(600_000)
    expect(t.promptMean).toBe(200_000)
    expect(t.promptP50).toBe(200_000)
    expect(t.promptMax).toBe(300_000)
    expect(t.input).toBe(6_000)
    expect(t.output).toBe(1_500)
    const sum = steps.reduce((total, s) => total + TokenUsage.priced(s, price).total, 0)
    expect(t.cost.total).toBeCloseTo(sum)
  })

  test("histogram counts requests per prompt-size bucket, with an overflow bucket", () => {
    const steps = [10_000, 49_999, 50_000, 120_000, 900_000].map((prompt) => step({ prompt, input: 1_000 }))
    expect(TokenUsage.histogram(steps, [50_000, 100_000, 500_000])).toEqual({
      edges: [50_000, 100_000, 500_000],
      counts: [2, 1, 1],
      over: 1,
    })
    expect(TokenUsage.histogram([], [50_000])).toEqual({ edges: [50_000], counts: [0], over: 0 })
  })
})

describe("TokenUsage.calibrate", () => {
  test("tokens per byte of tool output, from the growth between consecutive steps", () => {
    // each step adds 40_000 bytes of tool output and 500 output tokens; the next prompt grows by 10_500
    const steps = [
      step({ prompt: 100_000, tools: [{ tool: "bash", callID: "a", bytes: 40_000, cut: false }] }),
      step({ prompt: 110_500, tools: [{ tool: "bash", callID: "b", bytes: 40_000, cut: false }] }),
      step({ prompt: 121_000 }),
    ]
    expect(TokenUsage.calibrate(steps).tokensPerByte).toBeCloseTo(0.25)
  })
})

describe("TokenUsage.project", () => {
  const session = () => {
    clock = 0
    return Array.from({ length: 20 }, (_, i) =>
      step({
        prompt: 50_000 + i * 50_000,
        input: i === 10 ? 50_000 + i * 50_000 - 3_000 : 3_000,
        cacheWrite: i === 10 ? 3_000 : 1_000,
        reasoning: 200,
        tools: [{ tool: "bash", callID: `c${i}`, bytes: 120_000, cut: false }],
      }),
    )
  }
  const options = { tokensPerByte: 0.25, afterCompaction: 60_000, summaryOutput: 2_500 }

  test("with no lever the projection reproduces the actual tokens exactly, cache writes and reasoning included", () => {
    const steps = session()
    const actual = TokenUsage.totals(steps, price)
    const projected = TokenUsage.project(steps, {}, options)
    expect(projected.input).toBe(actual.input)
    expect(projected.cacheRead).toBe(actual.cacheRead)
    expect(projected.cacheWrite).toBe(actual.cacheWrite)
    expect(projected.output).toBe(actual.output)
    expect(projected.reasoning).toBe(actual.reasoning)
    expect(projected.cacheWrite).toBeGreaterThan(0)
    expect(projected.reasoning).toBeGreaterThan(0)
    expect(TokenUsage.priced(projected, price).total).toBeCloseTo(actual.cost.total)
    expect(projected.compactions).toBe(0)
  })

  test("compacting at a threshold caps the prompt and adds one uncached summary request per compaction", () => {
    const steps = session()
    const projected = TokenUsage.project(steps, { compactAt: 300_000 }, options)
    expect(projected.compactions).toBeGreaterThan(0)
    expect(projected.requests).toBe(steps.length + projected.compactions)
    expect(projected.cacheRead).toBeLessThan(TokenUsage.totals(steps, price).cacheRead)
  })

  test("like the product, it compacts when the last finished request (prompt + output) reached the threshold", () => {
    clock = 0
    // the last finished request counts 99_500 prompt + 500 output = 100_000: the next one compacts first
    const steps = [step({ prompt: 99_500 }), step({ prompt: 99_600 }), step({ prompt: 99_700 })]
    expect(TokenUsage.project(steps, { compactAt: 100_000 }, options).compactions).toBe(1)
    // one token under counts nothing
    clock = 0
    const under = [step({ prompt: 99_499 }), step({ prompt: 99_600 })]
    expect(TokenUsage.project(under, { compactAt: 100_000 }, options).compactions).toBe(0)
  })

  test("the product's guard: after a compaction the next one needs half a threshold over the first request after it", () => {
    clock = 0
    // 40 steps growing 10k each from 100k; the kept prompt (120k) is itself over the threshold
    const steps = Array.from({ length: 40 }, (_, i) => step({ prompt: 100_000 + i * 10_000 }))
    const heavy = TokenUsage.project(steps, { compactAt: 100_000 }, { ...options, afterCompaction: 120_000 })
    // compacts before steps 1, 7, 13, 19, 25, 31 and 37: every 6 steps once the floor is 120.5k
    expect(heavy.compactions).toBe(7)
  })

  test("a summary that really happened resets the floor, as the product's does", () => {
    clock = 0
    const steps = [
      ...Array.from({ length: 5 }, (_, i) => step({ prompt: 100_000 + i * 10_000 })),
      step({ prompt: 140_000, input: 140_000, summary: true }),
      // after the real compaction the prompt is 130k, over the 100k threshold: the guard holds it until 130.5k + 50k
      ...Array.from({ length: 6 }, (_, i) => step({ prompt: 130_000 + i * 10_000 })),
    ]
    const projected = TokenUsage.project(steps, { compactAt: 400_000 }, options)
    expect(projected.compactions).toBe(0)
    const tight = TokenUsage.project(steps, { compactAt: 100_000 }, { ...options, afterCompaction: 1_000_000 })
    // before step 1 (the last request counted 100.5k). The real summary then sets the
    // floor to 130.5k, so the next needs a last request of 180.5k; the last one is 180k.
    // Without the reset the floor would stay 110.5k and it would compact again at 160.5k.
    expect(tight.compactions).toBe(1)
  })

  test("the autonomous default applies to autonomous turns only; compaction.threshold to all", () => {
    const steps = session()
    const interactive = TokenUsage.project(steps, { autonomousCompactAt: 300_000 }, options)
    expect(interactive.compactions).toBe(0)
    const autonomous = TokenUsage.project(
      steps.map((s) => ({ ...s, autonomous: true })),
      { autonomousCompactAt: 300_000 },
      options,
    )
    expect(autonomous.compactions).toBe(TokenUsage.project(steps, { compactAt: 300_000 }, options).compactions)
  })

  test("a full cache miss costs the simulated prompt, not the actual one", () => {
    const steps = session()
    const base = TokenUsage.project(steps, {}, options)
    // the budget shrinks the prompt without compacting: ordinary steps keep their
    // uncached size, so the whole difference in uncached input is the miss at step 10
    const budgeted = TokenUsage.project(steps, { budget: { stepBytes: 32_768, floorBytes: 4_096 } }, options)
    const perStep = Math.round((120_000 - 32_768) * options.tokensPerByte)
    const actualMiss = steps[10].input / TokenUsage.promptTokens(steps[10])
    expect(base.input - budgeted.input).toBe(Math.round(actualMiss * 10 * perStep))
  })

  test("compacting trades cached reads for uncached summary requests and the miss after each", () => {
    const steps = session()
    const base = TokenUsage.project(steps, {}, options)
    const capped = TokenUsage.project(steps, { compactAt: 300_000 }, options)
    expect(capped.cacheRead).toBeLessThan(base.cacheRead)
    expect(capped.input).toBeGreaterThan(base.input)
  })

  test("the step budget removes cut bytes from every later request", () => {
    const steps = session()
    const base = TokenUsage.project(steps, {}, options)
    const budgeted = TokenUsage.project(steps, { budget: { stepBytes: 32_768, floorBytes: 4_096 } }, options)
    // 120_000 bytes cut to 32_768 per step: ~21.8k tokens saved per step, carried forward
    expect(budgeted.prompt).toBeLessThan(base.prompt)
    expect(budgeted.promptMax).toBeLessThan(base.promptMax - 19 * 20_000)
  })

  test("a failed request with no tokens is not replayed and does not read as a jump", () => {
    const steps = session()
    const withFailure = [
      ...steps.slice(0, 5),
      step({ prompt: 0, input: 0, cacheWrite: 0, output: 0, time: 4.5 }),
      ...steps.slice(5),
    ]
    const base = TokenUsage.project(steps, {}, options)
    const failed = TokenUsage.project(withFailure, { compactAt: 2_000_000 }, options)
    expect(failed.promptMax).toBe(base.promptMax)
    expect(failed.requests).toBe(base.requests)
    expect(failed.input).toBe(base.input)
  })

  test("a per-request cut also comes off the prompt after a compaction, never below a minimum", () => {
    const steps = session()
    const compacted = TokenUsage.project(steps, { compactAt: 300_000 }, options)
    const both = TokenUsage.project(steps, { compactAt: 300_000, perRequestCut: 40_000 }, options)
    // smaller after each compaction too, but it also compacts later: the saving is
    // less than 40k a request once the compaction timing shifts
    expect(both.compactions).toBeLessThanOrEqual(compacted.compactions)
    expect(both.prompt).toBeLessThan(compacted.prompt)
    const huge = TokenUsage.project(steps, { compactAt: 300_000, perRequestCut: 500_000 }, options)
    expect(huge.prompt).toBeGreaterThanOrEqual(10_000 * huge.requests)
  })

  test("a fixed per-request cut (system prompt, skills) comes off every request", () => {
    const steps = session()
    const base = TokenUsage.project(steps, {}, options)
    const cut = TokenUsage.project(steps, { perRequestCut: 10_000 }, options)
    expect(base.prompt - cut.prompt).toBe(10_000 * steps.length)
  })
})

describe("TokenUsage.readSteps", () => {
  test("one step per step-finish, with the tool outputs before it, from a session database", () => {
    const db = new Database(":memory:")
    db.run(
      `create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)`,
    )
    db.run(
      `create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)`,
    )
    const message = (id: string, time: number, data: object) =>
      db.run(`insert into message values (?, 'ses_1', ?, ?, ?)`, [id, time, time, JSON.stringify(data)])
    const part = (id: string, messageID: string, data: object) =>
      db.run(`insert into part values (?, ?, 'ses_1', 0, 0, ?)`, [id, messageID, JSON.stringify(data)])
    const finish = (input: number, read: number, write = 0) => ({
      type: "step-finish",
      tokens: { input, output: 30, reasoning: 7, cache: { read, write } },
      cost: 0.01,
    })
    const tool = (callID: string, output: string, metadata: object = {}) => ({
      type: "tool",
      tool: "bash",
      callID,
      state: { status: "completed", input: {}, output, metadata, title: "", time: { start: 0, end: 0 } },
    })

    message("msg_u1", 1000, { role: "user", autonomous: true })
    message("msg_a1", 2000, {
      role: "assistant",
      parentID: "msg_u1",
      agent: "build",
      providerID: "meta",
      modelID: "muse",
    })
    part("prt_01", "msg_a1", { type: "step-start" })
    part("prt_02", "msg_a1", tool("c1", "héllo")) // 6 bytes in UTF-8
    part("prt_03", "msg_a1", tool("c2", "x".repeat(10), { outputPath: "/tmp/tool_1" }))
    part("prt_04", "msg_a1", finish(100, 900, 50))
    part("prt_05", "msg_a1", { type: "step-start" })
    part("prt_06", "msg_a1", tool("c3", "y".repeat(3), { archive: { path: "/tmp/tool_2" } }))
    part("prt_07", "msg_a1", finish(10, 1100))
    message("msg_u2", 3000, { role: "user" })
    message("msg_a2", 4000, {
      role: "assistant",
      parentID: "msg_u2",
      agent: "compaction",
      providerID: "meta",
      modelID: "muse",
      summary: true,
    })
    part("prt_08", "msg_a2", finish(5000, 0))

    const steps = TokenUsage.readSteps(db)
    expect(steps).toHaveLength(3)
    expect(steps.map((s) => s.tools.map((t) => [t.callID, t.bytes, t.cut]))).toEqual([
      [
        ["c1", 6, false],
        ["c2", 10, true],
      ],
      [["c3", 3, true]],
      [],
    ])
    expect(steps[0]).toMatchObject({
      session: "ses_1",
      agent: "build",
      provider: "meta",
      model: "muse",
      input: 100,
      cacheRead: 900,
      cacheWrite: 50,
      output: 30,
      reasoning: 7,
      cost: 0.01,
      summary: false,
      autonomous: true,
    })
    expect(steps[0].time).toBeLessThan(steps[1].time)
    expect(steps[2]).toMatchObject({ agent: "compaction", summary: true, autonomous: false })
  })
})
