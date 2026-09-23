import { describe, expect, test } from "bun:test"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import {
  AUTONOMOUS_COMPACT_AT,
  compactionThreshold,
  floorAfterCompaction,
  overThreshold,
} from "../../src/session/overflow"

const tokens = (total: number): SessionV1.Assistant["tokens"] => ({
  input: 1_000,
  output: 100,
  reasoning: 0,
  cache: { read: total - 1_100, write: 0 },
})

describe("compactionThreshold", () => {
  const cfg = (input: Partial<ConfigV1.Info> = {}) => input as ConfigV1.Info

  test("interactive turns keep compacting only at the model limit by default", () => {
    expect(compactionThreshold({ cfg: cfg() })).toBeUndefined()
    expect(compactionThreshold({ cfg: cfg(), autonomous: false })).toBeUndefined()
  })

  test("autonomous turns compact at the default threshold", () => {
    expect(compactionThreshold({ cfg: cfg(), autonomous: true })).toBe(AUTONOMOUS_COMPACT_AT)
    expect(AUTONOMOUS_COMPACT_AT).toBe(150_000)
  })

  test("the autonomous default is configurable, and 0 turns it off", () => {
    const accuracy = (value: number) => cfg({ experimental: { accuracy: { autonomous_compact_at: value } } })
    expect(compactionThreshold({ cfg: accuracy(150_000), autonomous: true })).toBe(150_000)
    expect(compactionThreshold({ cfg: accuracy(0), autonomous: true })).toBeUndefined()
  })

  test("compaction.threshold applies to every turn and wins over the autonomous default", () => {
    const threshold = cfg({ compaction: { threshold: 120_000 } })
    expect(compactionThreshold({ cfg: threshold })).toBe(120_000)
    expect(compactionThreshold({ cfg: threshold, autonomous: true })).toBe(120_000)
    expect(compactionThreshold({ cfg: cfg({ compaction: { threshold: 0 } }), autonomous: true })).toBeUndefined()
  })

  test("auto compaction off means no threshold either", () => {
    expect(
      compactionThreshold({ cfg: cfg({ compaction: { auto: false, threshold: 120_000 } }), autonomous: true }),
    ).toBeUndefined()
  })
})

describe("overThreshold", () => {
  test("no threshold, never", () => {
    expect(overThreshold({ tokens: tokens(900_000), threshold: undefined })).toBe(false)
  })

  test("at or over the threshold", () => {
    expect(overThreshold({ tokens: tokens(199_999), threshold: 200_000 })).toBe(false)
    expect(overThreshold({ tokens: tokens(200_000), threshold: 200_000 })).toBe(true)
  })

  test("after a compaction, it needs half a threshold of new work over the first prompt after it", () => {
    // a heavy system prompt leaves 180k right after compacting: do not compact again at 200k
    expect(overThreshold({ tokens: tokens(210_000), threshold: 200_000, floor: 180_000 })).toBe(false)
    expect(overThreshold({ tokens: tokens(280_000), threshold: 200_000, floor: 180_000 })).toBe(true)
    // a light one does not move the threshold
    expect(overThreshold({ tokens: tokens(200_000), threshold: 200_000, floor: 60_000 })).toBe(true)
  })
})

describe("floorAfterCompaction", () => {
  const message = (
    id: string,
    created: number,
    info: Partial<SessionV1.Assistant> & { role?: "assistant" | "user" },
  ): SessionV1.WithParts =>
    ({
      info: { id, role: "assistant", time: { created }, finish: "stop", tokens: tokens(50_000), ...info },
      parts: [],
    }) as unknown as SessionV1.WithParts

  test("no compaction, no floor", () => {
    expect(floorAfterCompaction([message("a", 1, {}), message("b", 2, {})])).toBeUndefined()
  })

  test("the prompt of the first finished request after the latest summary", () => {
    const messages = [
      message("old", 1, { tokens: tokens(900_000) }),
      message("sum1", 2, { summary: true }),
      message("x", 3, { tokens: tokens(70_000) }),
      message("sum2", 4, { summary: true }),
      message("failed", 5, { finish: undefined, tokens: tokens(0) }),
      message("first", 6, { tokens: tokens(80_000) }),
      message("later", 7, { tokens: tokens(120_000) }),
    ]
    // filterCompacted reorders messages: the answer does not depend on array order
    expect(floorAfterCompaction(messages.toReversed())).toBe(80_000)
  })
})
