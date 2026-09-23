import { describe, expect, test } from "bun:test"
import { OutputBudget } from "../../src/session/output-budget"

const settings = { stepBytes: 100_000, floorBytes: 4_000 }
const part = (callID: string, bytes: number, tool = "bash", archived = false) => ({ callID, tool, bytes, archived })
const sum = (parts: ReturnType<typeof part>[], decisions: OutputBudget.Decision[]) =>
  parts
    .filter(OutputBudget.eligible)
    .reduce((total, p) => total + (decisions.find((d) => d.callID === p.callID)?.maxBytes ?? p.bytes), 0)

describe("OutputBudget.plan", () => {
  test("under budget: no decisions", () => {
    expect(OutputBudget.plan([part("a", 40_000), part("b", 50_000)], settings)).toEqual([])
  })

  test("over budget: the largest part is lowered first and the step ends at or under the budget", () => {
    const parts = [part("a", 10_000), part("b", 50_000), part("c", 90_000)]
    const decisions = OutputBudget.plan(parts, settings)
    expect(decisions.map((d) => d.callID)).toEqual(["c", "b"])
    expect(decisions.every((d) => d.maxBytes === 45_000)).toBe(true)
    expect(sum(parts, decisions)).toBeLessThanOrEqual(settings.stepBytes)
  })

  test("only the largest is cut when that is enough", () => {
    const parts = [part("a", 20_000), part("b", 30_000), part("c", 70_000)]
    const decisions = OutputBudget.plan(parts, settings)
    expect(decisions).toEqual([{ callID: "c", tool: "bash", bytes: 70_000, maxBytes: 50_000 }])
    expect(sum(parts, decisions)).toBe(100_000)
  })

  test("no part goes below the floor, even if the step stays over budget", () => {
    const parts = Array.from({ length: 40 }, (_, i) => part(`p${i}`, 10_000))
    const decisions = OutputBudget.plan(parts, settings)
    expect(decisions).toHaveLength(40)
    expect(decisions.every((d) => d.maxBytes === 4_000)).toBe(true)
    expect(sum(parts, decisions)).toBeGreaterThan(settings.stepBytes)
  })

  test("a part at or under the floor is never lowered", () => {
    const parts = [...Array.from({ length: 30 }, (_, i) => part(`p${i}`, 10_000)), part("small", 3_000)]
    expect(OutputBudget.plan(parts, settings).some((d) => d.callID === "small")).toBe(false)
  })

  test("exempt tools are never in the result, and a step of only exempt outputs gets no decisions", () => {
    for (const tool of OutputBudget.EXEMPT_TOOLS) {
      const parts = [part("x", 300_000, tool), part("y", 200_000, tool)]
      expect(OutputBudget.plan(parts, settings)).toEqual([])
      const mixed = [part("x", 300_000, tool), part("b", 150_000)]
      expect(OutputBudget.plan(mixed, settings).map((d) => d.callID)).toEqual(["b"])
    }
  })

  test("exempt outputs do not count toward the budget", () => {
    expect(OutputBudget.plan([part("r", 500_000, "read"), part("b", 90_000)], settings)).toEqual([])
  })

  test("a part that already carries a receipt is never lowered again", () => {
    const parts = [part("cut", 60_000, "bash", true), part("b", 90_000), part("c", 80_000)]
    const decisions = OutputBudget.plan(parts, settings)
    expect(decisions.some((d) => d.callID === "cut")).toBe(false)
    expect(decisions.map((d) => d.callID)).toEqual(["b", "c"])
  })

  test("deterministic: same input, same decisions in the same order", () => {
    const parts = [part("b", 70_000), part("a", 70_000), part("c", 70_000)]
    const first = OutputBudget.plan(parts, settings)
    expect(first.map((d) => d.callID)).toEqual(["a", "b", "c"])
    expect(OutputBudget.plan(parts.toReversed(), settings)).toEqual(first)
  })
})

describe("OutputBudget.record", () => {
  test("holds sizes and ranges, never the output", () => {
    const secret = "sk-live-0123456789abcdef"
    const decision = OutputBudget.plan([part("s", 300_000)], settings)[0]
    const entry = OutputBudget.record(decision, { shown: "lines 1-40, 9961-10000", archived: true })
    expect(entry).toEqual({
      kind: "output_budget",
      tool: "bash",
      bytes: 300_000,
      shown: "lines 1-40, 9961-10000",
      archived: true,
    })
    expect(JSON.stringify(entry)).not.toContain(secret)
  })
})
