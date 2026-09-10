import { describe, expect, test } from "bun:test"
import { createQueueRunner, type QueueItem, type QueueLoopEvent, type QueueProgress } from "./queue"
import type { TicketIssue } from "./ticket"

function ticket(identifier: string): TicketIssue {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title ${identifier}`,
    description: `Description ${identifier}`,
  }
}

function item(identifier: string, instructions = ""): QueueItem {
  return { ticket: ticket(identifier), directory: "/repo", instructions }
}

function mockDeps() {
  const starts: Array<{ directory: string; goal: string }> = []
  const progresses: QueueProgress[] = []
  let emit: ((event: QueueLoopEvent) => void) | null = null
  let count = 0
  const deps = {
    start: async (input: { directory: string; goal: string }) => {
      starts.push(input)
      count += 1
      return { id: `loop-${count}` }
    },
    subscribe: (cb: (event: QueueLoopEvent) => void) => {
      emit = cb
      return () => {
        emit = null
      }
    },
  }
  const fire = (loopID: string, type: string, reason: string | null = null) => {
    emit?.({ loopID, type, state: { status: type, reason } })
  }
  return { starts, progresses, deps, fire }
}

function track(runner: ReturnType<typeof createQueueRunner>, progresses: QueueProgress[]) {
  return runner.onProgress((progress) => {
    progresses.push(progress)
  })
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("goal queue runner", () => {
  test("advances sequentially on completed", async () => {
    const mock = mockDeps()
    const runner = createQueueRunner(mock.deps)
    track(runner, mock.progresses)

    runner.start([item("ABC-1"), item("ABC-2")])
    await tick()
    expect(mock.starts).toHaveLength(1)

    mock.fire("loop-1", "completed")
    await tick()
    expect(mock.starts).toHaveLength(2)

    mock.fire("loop-2", "completed")
    await tick()
    expect(mock.starts).toHaveLength(2)

    const phases = mock.progresses.map((progress) => `${progress.ticketIdentifier}:${progress.phase}`)
    expect(phases).toEqual(["ABC-1:started", "ABC-1:completed", "ABC-2:started", "ABC-2:completed"])
    const last = mock.progresses.at(-1)
    expect(last?.done).toBe(true)
    expect(last?.ok).toBe(true)
    expect(mock.progresses[1]?.done).toBe(false)
  })

  test("halts on failed with reason", async () => {
    const mock = mockDeps()
    const runner = createQueueRunner(mock.deps)
    track(runner, mock.progresses)

    runner.start([item("ABC-1"), item("ABC-2")])
    await tick()
    expect(mock.starts).toHaveLength(1)

    mock.fire("loop-1", "failed", "boom")
    await tick()
    expect(mock.starts).toHaveLength(1)

    const last = mock.progresses.at(-1)
    expect(last?.phase).toBe("halted")
    expect(last?.done).toBe(true)
    expect(last?.ok).toBe(false)
    expect(last?.reason).toBe("boom")
  })

  test("stop halts the queue with no further starts", async () => {
    const mock = mockDeps()
    const runner = createQueueRunner(mock.deps)
    track(runner, mock.progresses)

    runner.start([item("ABC-1"), item("ABC-2")])
    await tick()
    expect(mock.starts).toHaveLength(1)

    runner.stop()
    mock.fire("loop-1", "completed")
    await tick()
    expect(mock.starts).toHaveLength(1)

    const last = mock.progresses.at(-1)
    expect(last?.phase).toBe("halted")
    expect(last?.done).toBe(true)
    expect(last?.ok).toBe(false)
  })

  test("ignores events for unknown loop ids", async () => {
    const mock = mockDeps()
    const runner = createQueueRunner(mock.deps)
    track(runner, mock.progresses)

    runner.start([item("ABC-1")])
    await tick()
    expect(mock.starts).toHaveLength(1)

    mock.fire("loop-999", "completed")
    await tick()
    expect(mock.starts).toHaveLength(1)
    expect(mock.progresses.some((progress) => progress.phase === "completed")).toBe(false)

    mock.fire("loop-1", "completed")
    await tick()
    expect(mock.progresses.at(-1)?.phase).toBe("completed")
  })

  test("appends instructions only when non-blank", async () => {
    const mock = mockDeps()
    const runner = createQueueRunner(mock.deps)
    track(runner, mock.progresses)

    runner.start([item("ABC-1", "Follow the checklist"), item("ABC-2", ""), item("ABC-3", "   ")])
    await tick()
    mock.fire("loop-1", "completed")
    await tick()
    mock.fire("loop-2", "completed")
    await tick()
    expect(mock.starts).toHaveLength(3)
    expect(mock.starts[0]?.goal).toContain("Run instructions: Follow the checklist")
    expect(mock.starts[1]?.goal).not.toContain("Run instructions:")
    expect(mock.starts[2]?.goal).not.toContain("Run instructions:")
  })
})
