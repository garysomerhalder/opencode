import { describe, expect, test } from "bun:test"
import { TodoReminder } from "../../src/session/todo-reminder"

const todo = (status: string, content = "work") => ({ content, status, priority: "medium" }) as any

describe("todo reminder", () => {
  test("summarizes statuses", () => {
    const summary = TodoReminder.summarize([
      todo("pending"),
      todo("in_progress"),
      todo("completed"),
      todo("cancelled"),
    ])
    expect(summary).toEqual({ total: 4, active: 2, completed: 1, cancelled: 1 })
  })

  test("no reminder when every item is terminal", () => {
    const state = TodoReminder.create({ interval: 5 })
    const summary = TodoReminder.summarize([todo("completed"), todo("cancelled")])
    expect(TodoReminder.periodic(state, summary, 5)).toBeUndefined()
    expect(TodoReminder.onStop(state, summary)).toBeUndefined()
  })

  test("periodic reminder fires on the interval and not between", () => {
    const state = TodoReminder.create({ interval: 5 })
    const summary = TodoReminder.summarize([todo("in_progress"), todo("pending")])
    for (const step of [1, 2, 3, 4]) expect(TodoReminder.periodic(state, summary, step)).toBeUndefined()
    const first = TodoReminder.periodic(state, summary, 5)
    expect(first?.text).toContain("2")
    for (const step of [6, 7, 8, 9]) expect(TodoReminder.periodic(state, summary, step)).toBeUndefined()
    expect(TodoReminder.periodic(state, summary, 10)).toBeDefined()
  })

  test("stop reminder is handed out once per turn", () => {
    const state = TodoReminder.create({ interval: 5 })
    const summary = TodoReminder.summarize([todo("pending")])
    expect(TodoReminder.onStop(state, summary)).toBeDefined()
    expect(TodoReminder.onStop(state, summary)).toBeUndefined()
  })

  test("reminder text does not claim the work is done", () => {
    const state = TodoReminder.create({ interval: 5 })
    const text = TodoReminder.onStop(state, TodoReminder.summarize([todo("pending", "ship it")]))!.text
    expect(text.toLowerCase()).toContain("todo")
    expect(text).toContain("1")
  })
})
