import { describe, expect, test } from "bun:test"
import { buildTicketGoal, type TicketIssue } from "./ticket"

const WORK_LINE =
  "Work this Linear ticket to done in /repo. Follow the repository's own workflow (tests before/after, verify your work). When the ticket's acceptance criteria are fully met, reply with GOAL_COMPLETE on its own line and stop."

function fullIssue(): TicketIssue {
  return {
    id: "iss_123",
    identifier: "ABC-123",
    title: "Fix login redirect",
    description: "Users are redirected to the wrong page after login.",
    priority: 1,
    estimate: 3,
    state: { name: "In Progress", type: "started" },
    labels: ["bug", "frontend"],
    team: { key: "ABC" },
  }
}

describe("buildTicketGoal", () => {
  test("full ticket", () => {
    const result = buildTicketGoal(fullIssue(), "/repo")
    expect(result).toBe(
      `ABC-123: Fix login redirect (P1, In Progress)\nbug, frontend\n\nUsers are redirected to the wrong page after login.\n---\n${WORK_LINE}\n`,
    )
  })

  test("missing description", () => {
    const result = buildTicketGoal({ ...fullIssue(), description: null }, "/repo")
    expect(result).toBe(`ABC-123: Fix login redirect (P1, In Progress)\nbug, frontend\n---\n${WORK_LINE}\n`)
  })

  test("missing labels", () => {
    const result = buildTicketGoal({ ...fullIssue(), labels: [] }, "/repo")
    expect(result).toBe(
      `ABC-123: Fix login redirect (P1, In Progress)\n\nUsers are redirected to the wrong page after login.\n---\n${WORK_LINE}\n`,
    )
  })

  test("missing priority and state", () => {
    const result = buildTicketGoal(
      { ...fullIssue(), priority: null, state: null, labels: [], description: "Do it." },
      "/repo",
    )
    expect(result).toBe(`ABC-123: Fix login redirect (P?, unknown)\n\nDo it.\n---\n${WORK_LINE}\n`)
  })

  test("truncates description to 2000 chars", () => {
    const longDescription = "a".repeat(2500)
    const result = buildTicketGoal({ ...fullIssue(), description: longDescription }, "/repo")
    expect(result).toContain(`${"a".repeat(2000)}\n---\n`)
    expect(result).not.toContain("a".repeat(2001))
  })

  test("no trailing whitespace and exactly one trailing newline", () => {
    const cases = [
      buildTicketGoal(fullIssue(), "/repo"),
      buildTicketGoal({ ...fullIssue(), description: "   " }, "/repo"),
      buildTicketGoal({ ...fullIssue(), labels: undefined }, "/repo"),
      buildTicketGoal({ ...fullIssue(), priority: undefined, state: undefined }, "/repo"),
      buildTicketGoal({ ...fullIssue(), description: `${"x".repeat(2500)}   ` }, "/repo"),
    ]
    for (const output of cases) {
      expect(output.endsWith("\n")).toBe(true)
      expect(output.endsWith("\n\n")).toBe(false)
      expect(output).not.toContain("\r")
      for (const line of output.split("\n")) {
        expect(line).toBe(line.trimEnd())
      }
    }
  })
})
