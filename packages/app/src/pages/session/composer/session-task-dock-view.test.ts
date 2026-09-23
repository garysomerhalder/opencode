import { describe, expect, test } from "bun:test"
import type { ShellTask } from "@opencode-ai/sdk/v2/client"
import { duration, taskRowView, upsertTask, visibleTasks, RECENT_MS } from "./session-task-dock-view"

const task = (patch: Partial<ShellTask> = {}): ShellTask => ({
  id: "shl_1",
  sessionID: "ses_1",
  command: "bun test",
  cwd: "C:/work",
  status: "running",
  exitCode: null as unknown as number,
  startedAt: 1_000,
  bytes: 10,
  ...patch,
})

describe("background task dock", () => {
  test("events upsert by task id and keep start order", () => {
    let list: ShellTask[] = []
    list = upsertTask(list, task({ id: "shl_2", startedAt: 2_000 }))
    list = upsertTask(list, task({ id: "shl_1", startedAt: 1_000 }))
    list = upsertTask(list, task({ id: "shl_2", startedAt: 2_000, status: "exited" }))
    expect(list.map((item) => `${item.id}:${item.status}`)).toEqual(["shl_1:running", "shl_2:exited"])
  })

  test("shows running tasks, and ended ones only for a while", () => {
    const now = 1_000_000
    const list = [
      task({ id: "run" }),
      task({ id: "fresh", status: "exited", endedAt: now - 1_000 }),
      task({ id: "old", status: "exited", endedAt: now - RECENT_MS - 1 }),
    ]
    expect(visibleTasks(list, now).map((item) => item.id)).toEqual(["run", "fresh"])
  })

  test("a running row ticks its elapsed time and says the agent will be woken", () => {
    const row = taskRowView(task({ tail: "ok 12 tests", wake: "pending" }), 61_000)
    expect(row.running).toBe(true)
    expect(row.elapsedMs).toBe(60_000)
    expect(row.tail).toBe("ok 12 tests")
    expect(row.wake).toBe("taskDock.wake.pending")
    expect(row.status).toBe("taskDock.status.running")
    expect(row.canStop).toBe(true)
  })

  test("each way a task ends has its own wording", () => {
    const cases: Array<[Partial<ShellTask>, string, string]> = [
      [{ status: "exited", exitCode: 0, wake: "delivered" }, "taskDock.status.exited", "taskDock.wake.delivered"],
      [{ status: "exited", exitCode: 1, wake: "read" }, "taskDock.status.failed", "taskDock.wake.read"],
      [
        { status: "stopped", reason: "stopped", wake: "suppressed" },
        "taskDock.status.stopped",
        "taskDock.wake.stopped",
      ],
      [{ status: "timed_out", reason: "idle", wake: "suppressed" }, "taskDock.status.reaped", "taskDock.wake.reaped"],
      [
        { status: "timed_out", reason: "lifetime", wake: "delivered" },
        "taskDock.status.timedOut",
        "taskDock.wake.delivered",
      ],
      [
        { status: "cancelled", reason: "session", wake: "suppressed" },
        "taskDock.status.cancelled",
        "taskDock.wake.stopped",
      ],
    ]
    for (const [patch, status, wake] of cases) {
      const row = taskRowView(task({ endedAt: 5_000, ...patch }), 10_000)
      expect([row.status, row.wake, row.canStop, row.elapsedMs]).toEqual([status, wake, false, 4_000])
    }
  })

  test("a task with no wake says nothing about waking", () => {
    expect(taskRowView(task({ wake: "none" }), 2_000).wake).toBeUndefined()
    expect(taskRowView(task({}), 2_000).wake).toBeUndefined()
  })
})

describe("elapsed time", () => {
  test("formats seconds, minutes and hours", () => {
    expect(duration(45_000)).toBe("45s")
    expect(duration(370_000)).toBe("6m 10s")
    expect(duration(7_500_000)).toBe("2h 5m")
  })
})
