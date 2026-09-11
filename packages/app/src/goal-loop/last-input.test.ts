import { describe, expect, test } from "bun:test"
import { describeLastInput, LAST_GOAL_SNIPPET_MAX, snippetGoal } from "./last-input"

describe("snippetGoal", () => {
  test("trims and collapses whitespace", () => {
    expect(snippetGoal("  fix   the\n\ttests  ")).toBe("fix the tests")
  })

  test("short goal is unchanged", () => {
    expect(snippetGoal("Ship it")).toBe("Ship it")
  })

  test("goal at exactly max is unchanged", () => {
    const goal = "x".repeat(LAST_GOAL_SNIPPET_MAX)
    expect(snippetGoal(goal)).toBe(goal)
  })

  test("long goal is truncated with an ellipsis", () => {
    const view = snippetGoal(`${"y".repeat(LAST_GOAL_SNIPPET_MAX)} extra words here`)
    expect(view.endsWith("…")).toBe(true)
    expect(view.length).toBeLessThanOrEqual(LAST_GOAL_SNIPPET_MAX)
    expect(view.at(-2)).not.toBe(" ")
  })

  test("custom max applies", () => {
    expect(snippetGoal("hello world", 8)).toBe("hello w…")
  })
})

describe("describeLastInput", () => {
  test("null and undefined map to null", () => {
    expect(describeLastInput(null)).toBeNull()
    expect(describeLastInput(undefined)).toBeNull()
  })

  test("blank goal without ticket maps to null", () => {
    expect(describeLastInput({ directory: "/repo", goal: "   " })).toBeNull()
  })

  test("directory alone without goal or ticket maps to null", () => {
    expect(describeLastInput({ directory: "/repo", goal: "" })).toBeNull()
  })

  test("ticket maps to identifier/title/detail", () => {
    expect(
      describeLastInput({
        directory: " /repo ",
        goal: "derived goal",
        ticket: { identifier: " ABC-123 ", title: " Fix login " },
      }),
    ).toEqual({ strong: "ABC-123", rest: "Fix login", detail: "/repo" })
  })

  test("ticket with blank title keeps the identifier", () => {
    expect(
      describeLastInput({ directory: "/repo", goal: "derived goal", ticket: { identifier: "ABC-1", title: " " } }),
    ).toEqual({ strong: "ABC-1", rest: "", detail: "/repo" })
  })

  test("goal without ticket maps to snippet/detail", () => {
    expect(describeLastInput({ directory: "/repo", goal: "  Make  it\nwork  " })).toEqual({
      strong: "",
      rest: "Make it work",
      detail: "/repo",
    })
  })

  test("empty directory is preserved as empty detail", () => {
    expect(describeLastInput({ directory: "", goal: "Do things" })).toEqual({
      strong: "",
      rest: "Do things",
      detail: "",
    })
  })
})
