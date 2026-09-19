import { describe, expect, test } from "bun:test"
import {
  completionReached,
  createGoalLoop,
  extractAssistantText,
  type GoalLoopEvent,
  type GoalLoopServer,
  type GoalLoopStartInput,
  type GoalTicket,
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
    await waitFor(() => loop.status() === null)
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
    await waitFor(() => loop.status() === null)
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
    await waitFor(() => loop.status() === null)
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
      // a rejected fetch reads as a server outage; with no tolerance it counts at once
      outageToleranceMs: 0,
      retryBackoffMs: 1,
    })
    await loop.start({ directory: "/repo", goal: "flaky" })
    await waitFor(() => loop.status() === null)
    expect(events.at(-1)?.type).toBe("failed")
  })

  test("fails when the session never starts executing", async () => {
    const events: GoalLoopEvent[] = []
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_8" }) },
        { method: "POST", path: "/session/ses_8/prompt_async", respond: () => ({}) },
        statusRoutes("ses_8", () => false, { n: 0 }),
        { method: "GET", path: "/session/ses_8/message", respond: () => [] },
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
    await waitFor(() => loop.status() === null)
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
    await waitFor(() => loop.status() === null)
    expect(loop.status()).toBe(null)
  })

  test("carries the ticket onto state and the started event", async () => {
    const polls = { n: 0 }
    const events: GoalLoopEvent[] = []
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_11" }) },
        { method: "POST", path: "/session/ses_11/prompt_async", respond: () => ({}) },
        statusRoutes("ses_11", (call) => call === 1, polls),
        {
          method: "GET",
          path: "/session/ses_11/message",
          respond: () => assistantMessages(["all done\nGOAL_COMPLETE"]),
        },
      ],
      [],
    )
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl, onEvent: (e) => events.push(e), pollIntervalMs: 5 })
    const ticket: GoalTicket = { identifier: "ABC-123", title: "Fix login" }
    const state = await loop.start({ directory: "/repo", goal: "ship it", ticket })
    expect(state.ticket).toEqual(ticket)
    const started = events.at(0)
    if (started?.type !== "started") throw new Error("expected started event")
    expect(started.state.ticket).toEqual(ticket)
    await waitFor(() => loop.status() === null)
    expect(loop.status()).toBe(null)
  })

  test("rejects a ticket missing its title", async () => {
    const persisted: GoalLoopStartInput[] = []
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: stubFetch([], []),
      persistLast: (input) => persisted.push(input),
    })
    const badTicket = { identifier: "ABC-123" } as unknown as GoalTicket
    await expect(loop.start({ directory: "/repo", goal: "ship it", ticket: badTicket })).rejects.toThrow(
      "ticket must have identifier and title",
    )
    expect(persisted).toEqual([])
  })

  test("defaults a missing ticket to null", async () => {
    const polls = { n: 0 }
    const events: GoalLoopEvent[] = []
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: "/session", respond: () => ({ id: "ses_12" }) },
        { method: "POST", path: "/session/ses_12/prompt_async", respond: () => ({}) },
        statusRoutes("ses_12", (call) => call === 1, polls),
        {
          method: "GET",
          path: "/session/ses_12/message",
          respond: () => assistantMessages(["all done\nGOAL_COMPLETE"]),
        },
      ],
      [],
    )
    const loop = createGoalLoop({ getServer: async () => server, fetchImpl, onEvent: (e) => events.push(e), pollIntervalMs: 5 })
    const state = await loop.start({ directory: "/repo", goal: "ship it" })
    expect(state.ticket).toBe(null)
    await waitFor(() => loop.status() === null)
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
    await waitFor(() => loop.status() === null)
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
      ticket: null,
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await Bun.sleep(2)
  }
}

type Reply = { text: string; aborted?: boolean }
type Turn = { startAfter: number; busyFor: number; reply: Reply; message?: { info: Record<string, unknown>; parts: unknown[] } }
type TurnPlan = { reply: Reply; busyFor?: number; startAfter?: number }

// A small stateful stand-in for the opencode server. Every admitted user
// message queues one turn; a queued turn reads as idle for `startAfter` status
// polls, then busy for `busyFor` polls. Like opencode, the assistant message
// is created when the turn starts and filled in when it ends, so a prompt
// posted mid-turn sorts after it.
// `violations` counts prompts the loop sent while a turn was still queued or
// running, i.e. a double-send into a busy session.
function fakeServer(sessionID: string, plan: (index: number) => TurnPlan) {
  const messages: unknown[] = []
  const queue: Turn[] = []
  const calls: string[] = []
  const hooks: Array<(poll: number) => void> = []
  const state = {
    current: null as Turn | null,
    ids: 0,
    loopTurns: 0,
    statusPolls: 0,
    violations: 0,
    outage: null as ((poll: number) => Response | "refuse" | null) | null,
  }

  function admit(text: string, turn: TurnPlan) {
    messages.push({ info: { id: `msg_${String(++state.ids).padStart(4, "0")}`, role: "user" }, parts: [{ type: "text", text }] })
    const entry = { startAfter: turn.startAfter ?? 0, busyFor: turn.busyFor ?? 1, reply: turn.reply }
    if (state.current) queue.push(entry)
    else state.current = entry
  }

  function begin(turn: Turn) {
    if (turn.message) return
    turn.message = { info: { id: `msg_${String(++state.ids).padStart(4, "0")}`, role: "assistant" }, parts: [] }
    messages.push(turn.message)
  }

  function complete(turn: Turn) {
    begin(turn)
    if (!turn.message) return
    if (turn.reply.aborted) turn.message.info["error"] = { name: "MessageAbortedError", data: { message: "Aborted" } }
    turn.message.parts.push({ type: "text", text: turn.reply.text })
  }

  function poll(): boolean {
    while (state.current) {
      if (state.current.startAfter > 0) {
        state.current.startAfter -= 1
        return false
      }
      if (state.current.busyFor > 0) {
        begin(state.current)
        state.current.busyFor -= 1
        return true
      }
      complete(state.current)
      state.current = queue.shift() ?? null
    }
    return false
  }

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname === "/session/status") {
      state.statusPolls += 1
      const failure = state.outage?.(state.statusPolls) ?? null
      if (failure === "refuse") throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:4096")
      if (failure) return failure
      hooks.forEach((hook) => hook(state.statusPolls))
      return json(poll() ? { [sessionID]: { type: "busy" } } : {})
    }
    if (url.pathname === "/session" && method === "POST") return json({ id: sessionID })
    if (url.pathname === `/session/${sessionID}/prompt_async` && method === "POST") {
      if (state.current) state.violations += 1
      const body = JSON.parse(String(init?.body)) as { parts: { text: string }[] }
      admit(body.parts[0]?.text ?? "", plan(state.loopTurns++))
      return json({})
    }
    if (url.pathname === `/session/${sessionID}/message` && method === "GET") return json(messages.slice(-20))
    if (url.pathname === `/session/${sessionID}/abort` && method === "POST") {
      state.current = null
      queue.length = 0
      return json({})
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`)
  }) as typeof fetch

  return {
    fetchImpl,
    prompts: () => calls.filter((c) => c === `POST /session/${sessionID}/prompt_async`).length,
    violations: () => state.violations,
    // true once the current turn is actually running (its assistant message exists)
    running: () => state.current?.message !== undefined,
    // the assistant message of the running turn, for tests that stream parts into it
    activeMessage: () => state.current?.message,
    onPoll: (hook: (poll: number) => void) => hooks.push(hook),
    setOutage: (fn: (poll: number) => Response | "refuse" | null) => {
      state.outage = fn
    },
    external: admit,
  }
}

describe("goal loop resilience", () => {
  test("an aborted turn is not an error: waits for idle, then continues", async () => {
    const events: GoalLoopEvent[] = []
    // Turn 0 is aborted so fast (a server config reload) that no status poll
    // ever sees it busy. Turn 1 aborts after running. Turn 2 finishes.
    const fake = fakeServer("ses_abort", (index) => {
      if (index === 0) return { reply: { text: "partial", aborted: true }, busyFor: 0 }
      if (index === 1) return { reply: { text: "partial again", aborted: true }, busyFor: 2 }
      return { reply: { text: "done\nGOAL_COMPLETE" } }
    })
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      startTimeoutMs: 40,
      abortBackoffMs: 5,
      maxConsecutiveErrors: 1,
    })
    await loop.start({ directory: "/repo", goal: "survive aborts" })
    await waitFor(() => events.at(-1)?.type === "completed")
    expect(events.map((e) => e.type)).not.toContain("failed")
    expect(events.some((e) => e.state.status === "running" && (e.state.reason ?? "").includes("abort"))).toBe(true)
    expect(fake.prompts()).toBe(3)
    expect(fake.violations()).toBe(0)
  })

  test("gives up after too many consecutive aborted turns", async () => {
    const events: GoalLoopEvent[] = []
    const fake = fakeServer("ses_abort_cap", () => ({ reply: { text: "", aborted: true }, busyFor: 1 }))
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      abortBackoffMs: 1,
      maxConsecutiveAborts: 3,
    })
    await loop.start({ directory: "/repo", goal: "keeps aborting" })
    await waitFor(() => events.at(-1)?.type === "failed")
    expect(events.at(-1)?.state.reason).toContain("aborted")
    // the first prompt plus one continue per tolerated abort
    expect(fake.prompts()).toBe(3)
  })

  test("tolerates an external user message mid-wait without double-sending while busy", async () => {
    const events: GoalLoopEvent[] = []
    const fake = fakeServer("ses_ext", (index) => ({
      reply: { text: index >= 2 ? "done\nGOAL_COMPLETE" : "working" },
      busyFor: 3,
    }))
    const injected = { done: false }
    fake.onPoll(() => {
      // while the loop's first continue runs, an architect posts a correction
      // that the server only starts a few polls after that turn ends
      if (injected.done || fake.prompts() !== 2 || !fake.running()) return
      injected.done = true
      fake.external("architect: use the other API", { reply: { text: "adjusted" }, startAfter: 3, busyFor: 2 })
    })
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      startTimeoutMs: 200,
      maxConsecutiveErrors: 1,
    })
    await loop.start({ directory: "/repo", goal: "handle corrections" })
    await waitFor(() => events.at(-1)?.type === "completed")
    expect(injected.done).toBe(true)
    expect(fake.violations()).toBe(0)
    // first prompt, a continue after turn 0, a continue after the external turn
    expect(fake.prompts()).toBe(3)
    expect(events.map((e) => e.type)).not.toContain("failed")
  })

  test("completes when the marker appears in an externally triggered turn", async () => {
    const events: GoalLoopEvent[] = []
    const fake = fakeServer("ses_ext_done", () => ({ reply: { text: "working" }, busyFor: 3 }))
    const injected = { done: false }
    fake.onPoll(() => {
      if (injected.done || fake.prompts() !== 2 || !fake.running()) return
      injected.done = true
      fake.external("architect: that is enough, wrap up", {
        reply: { text: "wrapped up\nGOAL_COMPLETE" },
        startAfter: 3,
        busyFor: 2,
      })
    })
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      startTimeoutMs: 200,
      maxConsecutiveErrors: 1,
    })
    await loop.start({ directory: "/repo", goal: "external finish" })
    await waitFor(() => events.at(-1)?.type === "completed")
    expect(injected.done).toBe(true)
    expect(fake.violations()).toBe(0)
    expect(fake.prompts()).toBe(2)
    expect(loop.status()).toBe(null)
  })

  test("rides out a brief server outage and keeps reporting running", async () => {
    const events: GoalLoopEvent[] = []
    const fake = fakeServer("ses_outage", (index) => ({
      reply: { text: index >= 1 ? "done\nGOAL_COMPLETE" : "working" },
      busyFor: 2,
    }))
    // status polls 3..12: the server restarts, first refusing connections, then answering 503
    fake.setOutage((poll) => {
      if (poll >= 3 && poll < 8) return "refuse"
      if (poll >= 8 && poll < 13) return new Response("starting", { status: 503 })
      return null
    })
    const seen: (string | null)[] = []
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      retryBackoffMs: 1,
      maxBackoffMs: 4,
      maxConsecutiveErrors: 3,
    })
    await loop.start({ directory: "/repo", goal: "survive restart" })
    await waitFor(() => {
      const state = loop.status()
      if (state) seen.push(state.status === "running" ? state.reason : `not running: ${state.status}`)
      return events.at(-1)?.type === "completed" || events.at(-1)?.type === "failed"
    })
    expect(events.at(-1)?.type).toBe("completed")
    expect(seen.some((r) => (r ?? "").includes("unreachable"))).toBe(true)
    expect(fake.violations()).toBe(0)
  })

  test("a sustained outage still fails the loop", async () => {
    const events: GoalLoopEvent[] = []
    const fake = fakeServer("ses_down", () => ({ reply: { text: "working" }, busyFor: 2 }))
    fake.setOutage(() => "refuse")
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      retryBackoffMs: 1,
      maxBackoffMs: 2,
      outageToleranceMs: 20,
      maxConsecutiveErrors: 2,
    })
    await loop.start({ directory: "/repo", goal: "server gone" })
    await waitFor(() => events.at(-1)?.type === "failed")
    expect(events.at(-1)?.state.reason).toContain("ECONNREFUSED")
  })

  test("a turn busy far past the wait timeout keeps running while it makes progress", async () => {
    const events: GoalLoopEvent[] = []
    const fake = fakeServer("ses_long", () => ({ reply: { text: "working" }, busyFor: 1_000_000 }))
    fake.onPoll(() => {
      // a tool call finishes on every poll, like a long build streaming steps
      const message = fake.activeMessage()
      if (!message) return
      message.parts.push({
        id: `prt_${message.parts.length}`,
        type: "tool",
        tool: "bash",
        state: { status: "completed", time: { start: 1, end: 2 } },
      })
    })
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      waitTimeoutMs: 200,
      progressCheckMs: 0,
      maxConsecutiveErrors: 1,
    })
    await loop.start({ directory: "/repo", goal: "long build" })
    const startedAt = Date.now()
    // five wait timeouts of continuous busy work
    await waitFor(() => Date.now() - startedAt > 1000 || loop.status() === null, 3000)
    expect(loop.status()?.status).toBe("running")
    expect(events.map((e) => e.type)).not.toContain("failed")
    expect(events.some((e) => (e.state.reason ?? "").includes("error"))).toBe(false)
    // no event per poll: steady progress is not news
    expect(events.filter((e) => e.type === "iteration").length).toBeLessThan(3)
    expect(fake.prompts()).toBe(1)
    await loop.stop()
  })

  test("a busy turn with no progress for the wait timeout counts as an error", async () => {
    const events: GoalLoopEvent[] = []
    const fake = fakeServer("ses_quiet", () => ({ reply: { text: "working" }, busyFor: 1_000_000 }))
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      waitTimeoutMs: 120,
      progressCheckMs: 0,
      maxConsecutiveErrors: 2,
    })
    const startedAt = Date.now()
    await loop.start({ directory: "/repo", goal: "wedged" })
    await waitFor(() => loop.status() === null, 3000)
    const reasons = events.map((e) => e.state.reason ?? "")
    // the first stall is recovered from, the second one ends the loop
    const recovered = reasons.filter((r) => r.startsWith("recovered from an error (1 of 2)"))
    expect(recovered.some((r) => r.includes("no progress"))).toBe(true)
    expect(reasons.some((r) => r.startsWith("working (last progress"))).toBe(true)
    const failed = events.at(-1)
    if (failed?.type !== "failed") throw new Error("expected failed event")
    expect(failed.state.reason).toContain("no progress")
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2 * 120)
    // quiet-time notes are milestones, not one per poll
    expect(events.filter((e) => e.type === "iteration").length).toBeLessThanOrEqual(8)
  })

  test("a tool stuck running past the wait timeout counts as a stall even while its output streams", async () => {
    const events: GoalLoopEvent[] = []
    const fake = fakeServer("ses_hung", () => ({ reply: { text: "working" }, busyFor: 1_000_000 }))
    const hung = { at: 0 }
    fake.onPoll(() => {
      const message = fake.activeMessage()
      if (!message) return
      const last = message.parts.at(-1) as { state?: { status: string; metadata: { output: string } } } | undefined
      if (last?.state?.status === "running") {
        // the command keeps printing but never exits
        last.state.metadata.output += "."
        return
      }
      if (message.parts.length < 5) {
        message.parts.push({
          id: `prt_${message.parts.length}`,
          type: "tool",
          tool: "bash",
          state: { status: "completed", time: { start: 1, end: 2 } },
        })
        return
      }
      hung.at = Date.now()
      message.parts.push({
        id: "prt_hung",
        type: "tool",
        tool: "bash",
        state: { status: "running", time: { start: 3 }, metadata: { output: "" } },
      })
    })
    const loop = createGoalLoop({
      getServer: async () => server,
      fetchImpl: fake.fetchImpl,
      onEvent: (e) => events.push(e),
      pollIntervalMs: 2,
      waitTimeoutMs: 120,
      progressCheckMs: 0,
      maxConsecutiveErrors: 1,
    })
    await loop.start({ directory: "/repo", goal: "hung command" })
    await waitFor(() => loop.status() === null, 3000)
    const failed = events.at(-1)
    if (failed?.type !== "failed") throw new Error("expected failed event")
    expect(failed.state.reason).toContain("bash")
    expect(hung.at).toBeGreaterThan(0)
    expect(Date.now() - hung.at).toBeGreaterThanOrEqual(120)
    // the loop interrupted the wedged session when it gave up
    expect(fake.running()).toBe(false)
  })
})
