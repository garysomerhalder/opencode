import { describe, expect, test } from "bun:test"
import { lastLine, shouldPublish, wakeState } from "../../src/tool/shell/task-view"

describe("background task view", () => {
  test("lastLine is the last non-empty line, cut to the limit", () => {
    expect(lastLine("")).toBeUndefined()
    expect(lastLine("\n\n")).toBeUndefined()
    expect(lastLine("one\ntwo\n")).toBe("two")
    expect(lastLine("one\r\ntwo\r\n\r\n")).toBe("two")
    expect(lastLine("x".repeat(500))!.length).toBe(200)
    // progress bars redraw with carriage returns: show the newest frame
    expect(lastLine("50%\r75%\r100%")).toBe("100%")
  })

  test("wake state for each way a task can end", () => {
    const base = { hasWake: true, status: "running" as const, observedTerminal: false, woke: false }
    expect(wakeState({ ...base, hasWake: false })).toBe("none")
    expect(wakeState(base)).toBe("pending")
    expect(wakeState({ ...base, status: "exited" })).toBe("pending")
    expect(wakeState({ ...base, status: "exited", woke: true })).toBe("delivered")
    expect(wakeState({ ...base, status: "exited", observedTerminal: true })).toBe("read")
    expect(wakeState({ ...base, status: "timed_out", reason: "lifetime" })).toBe("pending")
    expect(wakeState({ ...base, status: "timed_out", reason: "deadline", woke: true })).toBe("delivered")
    expect(wakeState({ ...base, status: "timed_out", reason: "idle" })).toBe("suppressed")
    expect(wakeState({ ...base, status: "stopped", reason: "stopped" })).toBe("suppressed")
    expect(wakeState({ ...base, status: "cancelled", reason: "session" })).toBe("suppressed")
  })

  test("updates are published on a status change, otherwise at most once per interval", () => {
    expect(shouldPublish({ force: true, lastAt: 1_000, now: 1_001, everyMs: 1_000 })).toBe(true)
    expect(shouldPublish({ force: false, lastAt: undefined, now: 5, everyMs: 1_000 })).toBe(true)
    expect(shouldPublish({ force: false, lastAt: 1_000, now: 1_500, everyMs: 1_000 })).toBe(false)
    expect(shouldPublish({ force: false, lastAt: 1_000, now: 2_000, everyMs: 1_000 })).toBe(true)
  })
})
