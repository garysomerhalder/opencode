import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionUsage } from "../../src/session/usage"

const HOUR = 3_600_000
const t0 = 1_790_000_000_000

const call = (input: {
  at: number
  done?: number
  in?: number
  out?: number
  read?: number
  write?: number
  cost?: number
  summary?: boolean
}): SessionV1.Info =>
  ({
    id: `msg_${input.at}`,
    role: "assistant",
    sessionID: "ses_usage",
    parentID: "msg_user",
    agent: "build",
    mode: "build",
    providerID: "meta",
    modelID: "muse-spark-1.3",
    path: { cwd: "/", root: "/" },
    cost: input.cost ?? 0,
    tokens: {
      input: input.in ?? 0,
      output: input.out ?? 0,
      reasoning: 0,
      cache: { read: input.read ?? 0, write: input.write ?? 0 },
    },
    time: { created: input.at, ...(input.done ? { completed: input.done } : {}) },
    ...(input.summary ? { summary: true } : {}),
  }) as unknown as SessionV1.Info

const userMsg = {
  id: "msg_user",
  role: "user",
  sessionID: "ses_usage",
  time: { created: t0 },
} as unknown as SessionV1.Info

describe("SessionUsage.summarize", () => {
  const messages = [
    userMsg,
    call({ at: t0, done: t0 + 1000, in: 40_000, read: 0, out: 500, cost: 0.05 }),
    call({ at: t0 + HOUR / 2, in: 2_000, read: 38_000, out: 300 }),
    // a call that is still streaming reports nothing yet: not a call
    call({ at: t0 + HOUR / 2 + 1 }),
    call({ at: t0 + HOUR, in: 150_000, out: 4_000, summary: true }),
  ]

  test("one row per model call, with the prompt the request sent", () => {
    const usage = SessionUsage.summarize({ sessionID: "ses_usage", messages, now: t0 + HOUR })
    expect(usage.calls.map((row) => row.prompt)).toEqual([40_000, 40_000, 150_000])
    expect(usage.calls[1]).toMatchObject({ input: 2_000, cacheRead: 38_000, output: 300, summary: false })
    expect(usage.calls[2].summary).toBe(true)
  })

  test("totals and the burn rate over the session", () => {
    const usage = SessionUsage.summarize({ sessionID: "ses_usage", messages, now: t0 + HOUR })
    expect(usage.totals).toEqual({
      calls: 3,
      input: 192_000,
      output: 4_800,
      reasoning: 0,
      cacheRead: 38_000,
      cacheWrite: 0,
      prompt: 230_000,
      cost: 0.05,
    })
    expect(usage.rate.hours).toBeCloseTo(1, 5)
    expect(usage.rate.callsPerHour).toBeCloseTo(3, 5)
    expect(usage.rate.promptPerHour).toBeCloseTo(230_000, 0)
    expect(usage.rate.uncachedPerHour).toBeCloseTo(192_000, 0)
  })

  test("the recent window counts only calls that ended inside it", () => {
    const usage = SessionUsage.summarize({ sessionID: "ses_usage", messages, now: t0 + HOUR, windowMinutes: 40 })
    expect(usage.window.minutes).toBe(40)
    expect(usage.window.totals.calls).toBe(2)
    expect(usage.window.rate.callsPerHour).toBeCloseTo(3, 5)
  })

  test("calls can be left out; an empty session is all zeros", () => {
    expect(SessionUsage.summarize({ sessionID: "s", messages, now: t0, omitCalls: true }).calls).toEqual([])
    const empty = SessionUsage.summarize({ sessionID: "s", messages: [], now: t0 })
    expect(empty.totals.calls).toBe(0)
    expect(empty.rate.callsPerHour).toBe(0)
  })
})
