import { describe, expect, test } from "bun:test"
import { ago, applyEvent, goalPanelView, runningSessions } from "./panel-view"
import type { GoalLoopState } from "./types"

const state = (sessionID: string, patch: Partial<GoalLoopState> = {}): GoalLoopState => ({
  id: `loop_${sessionID}`,
  status: "running",
  directory: `C:/work/${sessionID}`,
  goal: `goal of ${sessionID}`,
  ticket: null,
  sessionID,
  serverURL: null,
  iteration: 3,
  maxIterations: 20,
  completionMarker: "GOAL_COMPLETE",
  reason: null,
  updatedAt: 1_000,
  phase: "turn",
  checkedAt: 9_000,
  promptedAt: 4_000,
  ...patch,
})

describe("goal panel view", () => {
  test("a loop on another session is never shown on this session's page", () => {
    // The reported bug: Muse #1's goal on the Muse #2 tab.
    const view = goalPanelView({ states: [state("ses_muse1")], sessionID: "ses_muse2", now: 10_000 })
    expect(view.kind).toBe("idle")
  })

  test("the page's own loop is shown, with its goal in full", () => {
    const goal = "x".repeat(600)
    const view = goalPanelView({ states: [state("ses_a", { goal })], sessionID: "ses_a", now: 10_000 })
    expect(view.kind).toBe("loop")
    if (view.kind !== "loop") return
    expect(view.goal).toBe(goal)
    expect(view.goal.length).toBe(600)
  })

  test("no session (a new-session page) shows nothing", () => {
    expect(goalPanelView({ states: [state("ses_a")], sessionID: undefined, now: 0 }).kind).toBe("idle")
  })

  test("each status and phase maps to one label and tone", () => {
    const cases: Array<[Partial<GoalLoopState>, string, string]> = [
      [{ status: "running", phase: "turn" }, "goalPanel.state.turn", "info"],
      [{ status: "running", phase: "waiting" }, "goalPanel.state.waiting", "info"],
      [{ status: "running", phase: undefined }, "goalPanel.state.turn", "info"],
      [{ status: "completed" }, "goalPanel.state.completed", "success"],
      [{ status: "failed" }, "goalPanel.state.failed", "error"],
      [{ status: "capped" }, "goalPanel.state.capped", "neutral"],
      [{ status: "stopped" }, "goalPanel.state.stopped", "neutral"],
      [{ status: "running", phase: "verifying" }, "goalPanel.state.verifying", "info"],
      [{ status: "unverified" }, "goalPanel.state.unverified", "error"],
    ]
    for (const [patch, label, tone] of cases) {
      const view = goalPanelView({ states: [state("ses_a", patch)], sessionID: "ses_a", now: 10_000 })
      if (view.kind !== "loop") throw new Error("expected a loop")
      expect([view.label, view.tone]).toEqual([label, tone])
    }
  })

  // accuracy E Phase 4 PR 4: the verdict and the checks awaiting approval
  test("the last verdict is shown with its tone, and the unmet criteria", () => {
    const pass = goalPanelView({
      states: [state("ses_a", { status: "completed", verifications: 1, lastVerdict: { verdict: "PASS", at: 9_000, unmet: [] } })],
      sessionID: "ses_a",
      now: 10_000,
    })
    if (pass.kind !== "loop") throw new Error("expected a loop")
    expect(pass.verdict).toEqual({ label: "goalPanel.verdict.pass", tone: "success", unmet: [], ago: 1_000 })
    expect(pass.verifications).toBe(1)

    const fail = goalPanelView({
      states: [
        state("ses_a", { status: "unverified", lastVerdict: { verdict: "FAIL", at: 5_000, unmet: ["capped at 4 KB"] } }),
      ],
      sessionID: "ses_a",
      now: 10_000,
    })
    if (fail.kind !== "loop") throw new Error("expected a loop")
    expect(fail.verdict).toEqual({ label: "goalPanel.verdict.fail", tone: "error", unmet: ["capped at 4 KB"], ago: 5_000 })

    const partial = goalPanelView({
      states: [state("ses_a", { lastVerdict: { verdict: "PARTIAL", at: 10_000, unmet: [] } })],
      sessionID: "ses_a",
      now: 10_000,
    })
    if (partial.kind !== "loop") throw new Error("expected a loop")
    expect(partial.verdict?.tone).toBe("warning")

    const none = goalPanelView({ states: [state("ses_a")], sessionID: "ses_a", now: 10_000 })
    if (none.kind !== "loop") throw new Error("expected a loop")
    expect(none.verdict).toBeNull()
  })

  test("checks awaiting approval are listed for the approval prompt", () => {
    const view = goalPanelView({
      states: [state("ses_a", { pendingChecks: ["bun run lint"] })],
      sessionID: "ses_a",
      now: 10_000,
    })
    if (view.kind !== "loop") throw new Error("expected a loop")
    expect(view.pendingChecks).toEqual(["bun run lint"])
  })

  // accuracy E Phase 4 (PR 2 review): a goal the verifier did not accept is never shown as done
  test("an unverified loop never renders as success", () => {
    const view = goalPanelView({ states: [state("ses_a", { status: "unverified" })], sessionID: "ses_a", now: 10_000 })
    if (view.kind !== "loop") throw new Error("expected a loop")
    expect(view.tone).not.toBe("success")
    expect(view.label).not.toBe("goalPanel.state.completed")
  })

  test("running exposes the last check, the last nudge and the iteration", () => {
    const view = goalPanelView({ states: [state("ses_a")], sessionID: "ses_a", now: 10_000 })
    if (view.kind !== "loop") throw new Error("expected a loop")
    expect(view.running).toBe(true)
    expect(view.checkedAgo).toBe(1_000)
    expect(view.promptedAgo).toBe(6_000)
    expect(view.iteration).toEqual({ current: 3, max: 20 })
  })

  test("a record without the live fields still renders", () => {
    const view = goalPanelView({
      states: [state("ses_a", { phase: undefined, checkedAt: undefined, promptedAt: undefined })],
      sessionID: "ses_a",
      now: 10_000,
    })
    if (view.kind !== "loop") throw new Error("expected a loop")
    expect(view.checkedAgo).toBeNull()
    expect(view.promptedAgo).toBeNull()
  })

  test("an ended loop keeps its reason and can be dismissed", () => {
    const view = goalPanelView({
      states: [state("ses_a", { status: "failed", reason: "turn failed 3 times" })],
      sessionID: "ses_a",
      now: 10_000,
    })
    if (view.kind !== "loop") throw new Error("expected a loop")
    expect(view.running).toBe(false)
    expect(view.reason).toBe("turn failed 3 times")
  })
})

describe("goal loop records", () => {
  test("events upsert by session, so two sessions keep separate loops", () => {
    let map = new Map<string, GoalLoopState>()
    map = applyEvent(map, { loopID: "l1", type: "started", state: state("ses_a") })
    map = applyEvent(map, { loopID: "l2", type: "started", state: state("ses_b") })
    map = applyEvent(map, { loopID: "l1", type: "progress", state: state("ses_a", { phase: "waiting" }) })
    expect(map.get("ses_a")?.phase).toBe("waiting")
    expect(map.get("ses_b")?.phase).toBe("turn")
  })

  test("a late event from an older loop does not replace a newer loop of the same session", () => {
    let map = new Map<string, GoalLoopState>()
    map = applyEvent(map, { loopID: "new", type: "started", state: state("ses_a", { id: "new", updatedAt: 5 }) })
    map = applyEvent(map, {
      loopID: "old",
      type: "stopped",
      state: state("ses_a", { id: "old", status: "stopped", updatedAt: 1 }),
    })
    expect(map.get("ses_a")?.id).toBe("new")
  })

  test("running sessions are the ones with a running loop", () => {
    const set = runningSessions([state("ses_a"), state("ses_b", { status: "completed" })])
    expect([...set]).toEqual(["ses_a"])
  })
})

describe("relative time", () => {
  test("formats seconds, minutes, hours and days", () => {
    expect(ago(null)).toBeNull()
    expect(ago(400)).toBe("0s")
    expect(ago(3_000)).toBe("3s")
    expect(ago(125_000)).toBe("2m")
    expect(ago(2 * 3_600_000)).toBe("2h")
    expect(ago(3 * 86_400_000)).toBe("3d")
  })
})
