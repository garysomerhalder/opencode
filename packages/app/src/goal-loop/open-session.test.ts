import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import { type SessionTab } from "@/context/tabs"
import { legacySessionHref } from "@/utils/session-route"
import { loopServerKey, openLoopSession } from "./open-session"
import type { GoalLoopState } from "./types"

function loopState(overrides: Partial<GoalLoopState> = {}): GoalLoopState {
  return {
    id: "loop-1",
    status: "running",
    directory: "/repo/project",
    goal: "Ship it",
    ticket: null,
    sessionID: "ses_abc123",
    serverURL: "http://127.0.0.1:4096",
    iteration: 3,
    maxIterations: 10,
    completionMarker: "GOAL_COMPLETE",
    reason: null,
    updatedAt: 0,
    ...overrides,
  }
}

function harness(impl?: { addSessionTab?: (input: Omit<SessionTab, "type">) => SessionTab }) {
  const added: Array<Omit<SessionTab, "type">> = []
  const selected: unknown[] = []
  const navigated: string[] = []
  const tabs = {
    addSessionTab: (input: Omit<SessionTab, "type">) => {
      added.push(input)
      if (impl?.addSessionTab) return impl.addSessionTab(input)
      return { type: "session" as const, ...input }
    },
    select: (tab: unknown) => {
      selected.push(tab)
    },
  }
  const navigate = (href: string) => {
    navigated.push(href)
  }
  return { tabs, navigate, added, selected, navigated }
}

describe("loopServerKey", () => {
  test("maps IPv4 loopback to the sidecar key", () => {
    expect(loopServerKey("http://127.0.0.1:4096")).toBe(ServerConnection.Key.make("sidecar"))
  })

  test("maps localhost and IPv6 loopback to the sidecar key", () => {
    expect(loopServerKey("http://localhost:4096")).toBe(ServerConnection.Key.make("sidecar"))
    expect(loopServerKey("http://[::1]:4096")).toBe(ServerConnection.Key.make("sidecar"))
  })

  test("maps a remote URL with Key.make", () => {
    expect(loopServerKey("https://example.com:4096")).toBe(
      ServerConnection.Key.make("https://example.com:4096"),
    )
  })

  test("falls back to sidecar for missing or invalid URLs", () => {
    expect(loopServerKey(null)).toBe(ServerConnection.Key.make("sidecar"))
    expect(loopServerKey("")).toBe(ServerConnection.Key.make("sidecar"))
    expect(loopServerKey("not-a-url")).toBe(ServerConnection.Key.make("sidecar"))
  })
})

describe("openLoopSession", () => {
  test("opens a sidecar tab for a loopback server URL", () => {
    const h = harness()
    openLoopSession({ tabs: h.tabs, navigate: h.navigate, state: loopState() })

    expect(h.added).toEqual([{ server: ServerConnection.Key.make("sidecar"), sessionId: "ses_abc123" }])
    expect(h.selected).toEqual([{ type: "session", ...h.added[0]! }])
    expect(h.navigated).toEqual([])
  })

  test("opens a remote tab with Key.make for a non-loopback server URL", () => {
    const h = harness()
    openLoopSession({
      tabs: h.tabs,
      navigate: h.navigate,
      state: loopState({ serverURL: "https://example.com:4096" }),
    })

    expect(h.added).toEqual([
      { server: ServerConnection.Key.make("https://example.com:4096"), sessionId: "ses_abc123" },
    ])
    expect(h.selected).toEqual([{ type: "session", ...h.added[0]! }])
    expect(h.navigated).toEqual([])
  })

  test("accepts a partial state with only session fields", () => {
    const h = harness()
    openLoopSession({
      tabs: h.tabs,
      navigate: h.navigate,
      state: { sessionID: "ses_abc123", serverURL: "https://example.com:4096", directory: "/repo/project" },
    })

    expect(h.added).toEqual([
      { server: ServerConnection.Key.make("https://example.com:4096"), sessionId: "ses_abc123" },
    ])
    expect(h.selected).toEqual([{ type: "session", ...h.added[0]! }])
    expect(h.navigated).toEqual([])
  })

  test("navigates to the legacy href when adding the tab throws", () => {
    const h = harness({
      addSessionTab: () => {
        throw new Error("tabs unavailable")
      },
    })
    const state = loopState({ directory: "/repo/project", sessionID: "ses_abc123" })

    expect(() => openLoopSession({ tabs: h.tabs, navigate: h.navigate, state })).not.toThrow()
    expect(h.selected).toEqual([])
    expect(h.navigated).toEqual([legacySessionHref("/repo/project", "ses_abc123")])
  })

  test("does nothing when sessionID is null", () => {
    const h = harness()
    expect(() =>
      openLoopSession({ tabs: h.tabs, navigate: h.navigate, state: loopState({ sessionID: null }) }),
    ).not.toThrow()
    expect(h.added).toEqual([])
    expect(h.selected).toEqual([])
    expect(h.navigated).toEqual([])
  })
})
