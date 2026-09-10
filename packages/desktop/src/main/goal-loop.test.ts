import { describe, expect, test } from "bun:test"
import {
  completionReached,
  createGoalLoop,
  extractAssistantText,
  type GoalLoopEvent,
  type GoalLoopServer,
  type GoalLoopStartInput,
} from "./goal-loop"

const server: GoalLoopServer = { url: "http://127.0.0.1:4096", username: "opencode", password: "secret" }

type Route = {
  method: string
  path: string
  respond: () => unknown
}

function stubFetch(routes: Route[], calls: string[]) {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${url.pathname}${url.search}`)
    const route = routes.find((r) => r.method === method && url.pathname === r.path)
    if (!route) throw new Error(`unexpected request: ${method} ${url.pathname}`)
    const body = route.respond()
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

function assistantMessages(texts: string[]) {
  return texts.map((text, index) => ({
    info: { id: `m${index}`, role: "assistant" },
    parts: [{ type: "text", text }],
  }))
}

function statusRoutes(sessionID: string, busyOn: (call: number) => boolean, calls: { n: number }) {
  return {
    method: "GET",
    path: "/session/status",
    respond: () => {
      calls.n += 1
      return busyOn(calls.n) ? { [sessionID]: { type: "busy" } } : {}
    },
  }
}

describe("goal loop predicate", () => {
  test("extracts assistant text and ignores other roles", () => {
    const payload = {
      messages: [
        { role: "user", parts: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "first" },
            { type: "tool", text: "ignored?" },
          ],
        },
        { role: "assistant", parts: [{ type: "text", text: "second" }] },
      ],
    }
    expect(extractAssistantText(payload)).toBe("first\nsecond")
  })

  test("reads the v2 data envelope", () => {
    const payload = {
      data: [{ type: "assistant", content: [{ type: "text", text: "enveloped" }] }],
    }
    expect(extractAssistantText(payload)).toBe("enveloped")
  })

  test("reads the v1 info/parts shape", () => {
    const payload = [
      { info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "v-one" }] },
      { info: { id: "m2", role: "user" }, parts: [{ type: "text", text: "skip me" }] },
    ]
    expect(extractAssistantText(payload)).toBe("v-one")
  })

  test("ignores user text so our own marker instructions never complete the loop", () => {
    const payload = {
      data: [
        { type: "user", text: "reply with GOAL_COMPLETE on its own line" },
        { type: "assistant", content: [{ type: "reasoning", text: "" }] },
      ],
    }
    expect(extractAssistantText(payload)).toBe("")
    expect(completionReached(extractAssistantText(payload), "GOAL_COMPLETE")).toBe(false)
  })

  test("completion marker must stand on its own line", () => {
    expect(completionReached("done\nGOAL_COMPLETE\nbye", "GOAL_COMPLETE")).toBe(true)
    expect(completionReached("almost GOAL_COMPLETE-ish", "GOAL_COMPLETE")).toBe(false)
    expect(completionReached("", "GOAL_COMPLETE")).toBe(false)
  })
})

describe("goal loop driver", () => {
  test("completes when the marker appears after the first turn", async () => {
    const calls: string[] = []
    const polls = { n: 0 }
    const events: GoalLoopEvent[] = []
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_1" }) },
        { method: "POST", path: "/session/ses_1/prompt_async", respond: () => ({}) },
        statusRoutes("ses_1", (call) => call === 1, polls),
        {
          method: "GET",
          path: "/session/ses_1/message",
          respond: () => assistantMessages(["all done\nGOAL_COMPLETE"]),
        },
      ],
      calls,
    )
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl, onEvent: (e) => events.push(e), pollIntervalMs: 5 })
    const state = await loop.start({ directory: "/repo", goal: "ship it" })
    expect(state.status).toBe("running")
    expect(state.sessionID).toBe("ses_1")
    await Bun.sleep(50)
    expect(loop.status()).toBe(null)
    expect(events.map((e) => e.type)).toEqual(["started", "completed"])
    expect(calls.some((c) => c.startsWith("POST /session?"))).toBe(true)
  })

  test("continues prompting until the iteration cap, then reports capped", async () => {
    const calls: string[] = []
    const polls = { n: 0 }
    const events: GoalLoopEvent[] = []
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_2" }) },
        { method: "POST", path: "/session/ses_2/prompt_async", respond: () => ({}) },
        statusRoutes("ses_2", (call) => call % 2 === 1, polls),
        { method: "GET", path: "/session/ses_2/message", respond: () => assistantMessages(["still working"]) },
      ],
      calls,
    )
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl, onEvent: (e) => events.push(e), pollIntervalMs: 5 })
    await loop.start({ directory: "/repo", goal: "ship it", maxIterations: 2 })
    await Bun.sleep(50)
    expect(events.map((e) => e.type)).toEqual(["started", "iteration", "capped"])
    const capped = events.at(-1)
    if (capped?.type !== "capped") throw new Error("expected capped event")
    expect(capped.state.reason).toContain("2 iterations")
    const prompts = calls.filter((c) => c.startsWith("POST /session/ses_2/prompt_async"))
    expect(prompts).toHaveLength(2)
  })

  test("creates the session in the requested directory (v1 surface the UI reads)", async () => {
    const events: GoalLoopEvent[] = []
    const polls = { n: 0 }
    let createURL = ""
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = (init?.method ?? "GET").toUpperCase()
      if (url.pathname === "/session" && method === "POST") {
        createURL = url.search
        return json({ id: "ses_7" })
      }
      if (url.pathname.endsWith("/prompt_async") && method === "POST") return json({})
      if (url.pathname === "/session/status") {
        polls.n += 1
        return json(polls.n === 1 ? { ses_7: { type: "busy" } } : {})
      }
      if (url.pathname.endsWith("/message")) return json(assistantMessages(["done\nGOAL_COMPLETE"]))
      throw new Error(`unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl, onEvent: (e) => events.push(e), pollIntervalMs: 5 })
    const state = await loop.start({ directory: "C:/work/proj", goal: "v1 shape" })
    expect(createURL).toContain(`directory=${encodeURIComponent("C:/work/proj")}`)
    expect(state.sessionID).toBe("ses_7")
    await Bun.sleep(50)
    expect(events.at(-1)?.type).toBe("completed")
  })

  test("rejects a second loop while one is running", async () => {
    const polls = { n: 0 }
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_3" }) },
        { method: "POST", path: "/session/ses_3/prompt_async", respond: () => ({}) },
        statusRoutes("ses_3", () => true, polls),
        { method: "GET", path: "/session/ses_3/message", respond: () => assistantMessages(["working"]) },
        { method: "POST", path: "/session/ses_3/abort", respond: () => ({}) },
      ],
      [],
    )
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl, pollIntervalMs: 5 })
    await loop.start({ directory: "/repo", goal: "first" })
    await expect(loop.start({ directory: "/repo", goal: "second" })).rejects.toThrow("already running")
    await loop.stop()
  })

  test("stop interrupts the session and reports stopped", async () => {
    const calls: string[] = []
    const polls = { n: 0 }
    const events: GoalLoopEvent[] = []
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_4" }) },
        { method: "POST", path: "/session/ses_4/prompt_async", respond: () => ({}) },
        statusRoutes("ses_4", () => true, polls),
        { method: "POST", path: "/session/ses_4/abort", respond: () => ({}) },
      ],
      calls,
    )
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl, onEvent: (e) => events.push(e), pollIntervalMs: 5 })
    await loop.start({ directory: "/repo", goal: "long job" })
    await Bun.sleep(20)
    const stopped = await loop.stop()
    expect(stopped?.status).toBe("stopped")
    expect(calls.some((c) => c.startsWith("POST /session/ses_4/abort"))).toBe(true)
    expect(events.at(-1)?.type).toBe("stopped")
  })

  test("fails after repeated request errors", async () => {
    const events: GoalLoopEvent[] = []
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === "/session" && (init?.method ?? "GET").toUpperCase() === "POST") {
        return json({ id: "ses_5" })
      }
      if (url.pathname.endsWith("/prompt_async")) return json({})
      throw new Error("boom")
    }) as typeof fetch
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl,
      onEvent: (e) => events.push(e),
      maxConsecutiveErrors: 2,
    })
    await loop.start({ directory: "/repo", goal: "flaky" })
    await Bun.sleep(50)
    expect(events.at(-1)?.type).toBe("failed")
  })

  test("fails when the session never starts executing", async () => {
    const events: GoalLoopEvent[] = []
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_8" }) },
        { method: "POST", path: "/session/ses_8/prompt_async", respond: () => ({}) },
        statusRoutes("ses_8", () => false, { n: 0 }),
        { method: "POST", path: "/session/ses_8/abort", respond: () => ({}) },
      ],
      [],
    )
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 5,
      startTimeoutMs: 30,
      maxConsecutiveErrors: 1,
    })
    await loop.start({ directory: "/repo", goal: "never starts" })
    await Bun.sleep(50)
    const failed = events.at(-1)
    if (failed?.type !== "failed") throw new Error("expected failed event")
    expect(failed.state.reason).toContain("did not start executing")
  })

  test("validates its inputs", async () => {
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl: stubFetch([], []) })
    await expect(loop.start({ directory: "/repo", goal: "   " })).rejects.toThrow("must not be empty")
    await expect(loop.start({ directory: "/repo", goal: "x", maxIterations: 0 })).rejects.toThrow("maxIterations")
    await expect(loop.start({ directory: "/repo", goal: "x", maxIterations: 1.5 })).rejects.toThrow("maxIterations")
  })

  test("rejects an empty directory without persisting", async () => {
    const persisted: GoalLoopStartInput[] = []
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: stubFetch([], []),
      persistLast: (input) => persisted.push(input),
    })
    await expect(loop.start({ directory: "   ", goal: "ship it" })).rejects.toThrow("directory must not be empty")
    await expect(loop.start({ directory: "", goal: "ship it" })).rejects.toThrow("directory must not be empty")
    expect(persisted).toEqual([])
  })

  test("persists the last input after a successful start", async () => {
    const persisted: GoalLoopStartInput[] = []
    const polls = { n: 0 }
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_10" }) },
        { method: "POST", path: "/session/ses_10/prompt_async", respond: () => ({}) },
        statusRoutes("ses_10", (call) => call === 1, polls),
        {
          method: "GET",
          path: "/session/ses_10/message",
          respond: () => assistantMessages(["all done\nGOAL_COMPLETE"]),
        },
      ],
      [],
    )
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl,
      pollIntervalMs: 5,
      persistLast: (input) => persisted.push(input),
    })
    const input = { directory: "/repo", goal: "ship it", maxIterations: 2 }
    await loop.start(input)
    expect(persisted).toEqual([input])
    await Bun.sleep(50)
    expect(loop.status()).toBe(null)
  })

  test("runs unbounded without a cap until the marker appears", async () => {
    const events: GoalLoopEvent[] = []
    const polls = { n: 0 }
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_6" }) },
        { method: "POST", path: "/session/ses_6/prompt_async", respond: () => ({}) },
        statusRoutes("ses_6", (call) => call % 2 === 1, polls),
        {
          method: "GET",
          path: "/session/ses_6/message",
          respond: () => assistantMessages(polls.n >= 12 ? ["finished\nGOAL_COMPLETE"] : ["working"]),
        },
      ],
      [],
    )
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl, onEvent: (e) => events.push(e), pollIntervalMs: 5 })
    const state = await loop.start({ directory: "/repo", goal: "long job" })
    expect(state.maxIterations).toBe(null)
    await Bun.sleep(100)
    expect(polls.n).toBeGreaterThan(10)
    expect(events.at(-1)?.type).toBe("completed")
    expect(events.map((e) => e.type)).not.toContain("capped")
  })

  test("adopts an orphaned running loop as stopped", async () => {
    const events: GoalLoopEvent[] = []
    const loop = createGoalLoop({ getServer: async () => server, onEvent: (e) => events.push(e) })
    const orphan = {
      id: "loop_1",
      status: "running" as const,
      directory: "/repo",
      goal: "unfinished",
      sessionID: "ses_9",
      serverURL: "http://127.0.0.1:4096",
      iteration: 3,
      maxIterations: null,
      completionMarker: "GOAL_COMPLETE",
      reason: null,
      updatedAt: 0,
    }
    expect(loop.adoptOrphan(orphan)).toBe(null)
    expect(loop.status()).toBe(null)
    expect(events.map((e) => e.type)).toEqual(["stopped"])
    const stopped = events.at(0)
    if (stopped?.type !== "stopped") throw new Error("expected stopped event")
    expect(stopped.state.reason).toBe("app restarted")
    expect(loop.adoptOrphan(null)).toBe(null)
  })
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}
