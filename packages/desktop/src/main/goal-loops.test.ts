import { describe, expect, test } from "bun:test"
import type { GoalLoop, GoalLoopDeps, GoalLoopEvent, GoalLoopStartInput, GoalLoopState } from "./goal-loop"
import { createGoalLoops } from "./goal-loops"

// A stand-in for createGoalLoop: it reports through the same hooks the real one
// uses (persist, onEvent, onProgress), so the manager is tested on its own.
type Fake = {
  hooks: Pick<GoalLoopDeps, "persist" | "onEvent" | "onProgress">
  state: GoalLoopState | null
  finish(status: "completed" | "failed" | "stopped", reason?: string): void
  progress(patch: Partial<GoalLoopState>): void
}

function harness() {
  const fakes: Fake[] = []
  let seq = 0
  const create = (hooks: Fake["hooks"]): GoalLoop => {
    const fake: Fake = {
      hooks,
      state: null,
      finish(status, reason) {
        if (!fake.state) return
        fake.state = { ...fake.state, status, reason: reason ?? null }
        hooks.persist?.(fake.state)
        hooks.onEvent?.({ loopID: fake.state.id, type: status, state: fake.state })
        hooks.persist?.(null)
      },
      progress(patch) {
        if (!fake.state) return
        fake.state = { ...fake.state, ...patch }
        hooks.onProgress?.(fake.state)
      },
    }
    fakes.push(fake)
    return {
      async start(input: GoalLoopStartInput) {
        seq += 1
        fake.state = {
          id: `loop${seq}`,
          status: "running",
          directory: input.directory,
          goal: input.goal,
          ticket: input.ticket ?? null,
          sessionID: input.sessionID ?? `ses_new${seq}`,
          serverURL: "http://127.0.0.1:4096",
          iteration: 1,
          maxIterations: input.maxIterations ?? null,
          completionMarker: "GOAL_COMPLETE",
          reason: null,
          updatedAt: seq,
          phase: "turn",
          checkedAt: null,
          promptedAt: null,
        }
        hooks.persist?.(fake.state)
        hooks.onEvent?.({ loopID: fake.state.id, type: "started", state: fake.state })
        return fake.state
      },
      async stop() {
        fake.finish("stopped", "stopped by user")
        return fake.state
      },
      status: () => (fake.state?.status === "running" ? fake.state : null),
      markInterrupted(reason: string) {
        fake.finish("stopped", reason)
        return fake.state
      },
      adoptOrphan(record: GoalLoopState | null | undefined) {
        if (!record) return null
        fake.state = { ...record }
        fake.finish("stopped", "app restarted")
        return null
      },
    }
  }
  const persisted = new Map<string, GoalLoopState>()
  const lasts = new Map<string, GoalLoopStartInput>()
  const events: GoalLoopEvent[] = []
  const loops = createGoalLoops({
    create,
    persist: (sessionID, state) => {
      if (state) persisted.set(sessionID, state)
      else persisted.delete(sessionID)
    },
    persistLast: (sessionID, input) => lasts.set(sessionID, input),
    onEvent: (event) => events.push(event),
    maxRunning: 3,
  })
  return { loops, fakes, persisted, lasts, events }
}

const input = (sessionID?: string, goal = "ship it"): GoalLoopStartInput => ({
  directory: "C:/work",
  goal,
  ...(sessionID ? { sessionID } : {}),
})

describe("goal loops, one per session", () => {
  test("two sessions can each run a loop", async () => {
    const { loops } = harness()
    await loops.start(input("ses_a", "goal A"))
    await loops.start(input("ses_b", "goal B"))
    expect(loops.status("ses_a")?.goal).toBe("goal A")
    expect(loops.status("ses_b")?.goal).toBe("goal B")
    expect(loops.list().filter((state) => state.status === "running")).toHaveLength(2)
  })

  test("a second loop on the same session is refused", async () => {
    const { loops } = harness()
    await loops.start(input("ses_a"))
    await expect(loops.start(input("ses_a"))).rejects.toThrow("already running in this session")
  })

  test("the running cap is enforced", async () => {
    const { loops } = harness()
    await loops.start(input("ses_a"))
    await loops.start(input("ses_b"))
    await loops.start(input("ses_c"))
    await expect(loops.start(input("ses_d"))).rejects.toThrow("3 goal loops are already running")
  })

  test("stopping one session's loop leaves the other running", async () => {
    const { loops } = harness()
    await loops.start(input("ses_a"))
    await loops.start(input("ses_b"))
    const stopped = await loops.stop("ses_a")
    expect(stopped?.status).toBe("stopped")
    expect(loops.status("ses_b")?.status).toBe("running")
  })

  test("stop without a session stops the only loop, and refuses when several run", async () => {
    const one = harness()
    await one.loops.start(input("ses_a"))
    expect((await one.loops.stop())?.status).toBe("stopped")

    const two = harness()
    await two.loops.start(input("ses_a"))
    await two.loops.start(input("ses_b"))
    await expect(two.loops.stop()).rejects.toThrow("several goal loops are running")
  })

  test("a loop that creates its session is tracked under that session", async () => {
    const { loops } = harness()
    const state = await loops.start(input())
    expect(state.sessionID).toBe("ses_new1")
    expect(loops.status("ses_new1")?.status).toBe("running")
  })

  test("an ended loop stays visible to its session until dismissed", async () => {
    const { loops, fakes } = harness()
    await loops.start(input("ses_a"))
    fakes[0]!.finish("failed", "turn failed 3 times")
    expect(loops.status("ses_a")?.status).toBe("failed")
    expect(loops.status("ses_a")?.reason).toBe("turn failed 3 times")
    loops.dismiss("ses_a")
    expect(loops.status("ses_a")).toBeNull()
    // a new loop can start on it
    await loops.start(input("ses_a"))
    expect(loops.status("ses_a")?.status).toBe("running")
  })

  test("status without a session is the newest running loop, never an ended one", async () => {
    const { loops, fakes } = harness()
    await loops.start(input("ses_a"))
    await loops.start(input("ses_b"))
    expect(loops.status()?.sessionID).toBe("ses_b")
    fakes[1]!.finish("completed")
    expect(loops.status()?.sessionID).toBe("ses_a")
  })

  test("persistence is per session", async () => {
    const { loops, fakes, persisted } = harness()
    await loops.start(input("ses_a"))
    await loops.start(input("ses_b"))
    expect([...persisted.keys()].sort()).toEqual(["ses_a", "ses_b"])
    fakes[0]!.finish("completed")
    expect([...persisted.keys()]).toEqual(["ses_b"])
  })

  test("the last input is remembered per session, with the resolved session id", async () => {
    const { loops, lasts } = harness()
    await loops.start(input("ses_a", "goal A"))
    await loops.start(input(undefined, "goal new"))
    expect(lasts.get("ses_a")?.goal).toBe("goal A")
    expect(lasts.get("ses_new2")).toMatchObject({ goal: "goal new", sessionID: "ses_new2" })
  })

  test("progress is forwarded as a progress event and updates status", async () => {
    const { loops, fakes, events } = harness()
    await loops.start(input("ses_a"))
    fakes[0]!.progress({ phase: "waiting", checkedAt: 123 })
    expect(events.at(-1)?.type).toBe("progress")
    expect(loops.status("ses_a")).toMatchObject({ phase: "waiting", checkedAt: 123 })
  })

  test("orphans from the last run are stopped per session", async () => {
    const { loops, events } = harness()
    const orphan = (sessionID: string): GoalLoopState => ({
      id: `old_${sessionID}`,
      status: "running",
      directory: "C:/work",
      goal: "old",
      ticket: null,
      sessionID,
      serverURL: null,
      iteration: 3,
      maxIterations: null,
      completionMarker: "GOAL_COMPLETE",
      reason: null,
      updatedAt: 1,
    })
    loops.adoptOrphans([orphan("ses_a"), orphan("ses_b")])
    expect(events.filter((event) => event.type === "stopped")).toHaveLength(2)
    expect(loops.status("ses_a")?.reason).toBe("app restarted")
    expect(loops.list().some((state) => state.status === "running")).toBe(false)
  })

  test("markInterrupted stops every running loop", async () => {
    const { loops } = harness()
    await loops.start(input("ses_a"))
    await loops.start(input("ses_b"))
    loops.markInterrupted("server stopped")
    expect(loops.list().every((state) => state.status === "stopped")).toBe(true)
  })
})
