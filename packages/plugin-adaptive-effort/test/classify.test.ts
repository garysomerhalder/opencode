import { describe, expect, test } from "bun:test"
import { analyze, decide } from "../src/classify"

describe("analyze", () => {
  test("classifies debug tasks as hard", () => {
    const result = analyze({ text: "Debug why this crash is happening", fileCount: 0, wordCount: 6 })
    expect(result.difficulty).toBe("hard")
    expect(result.grunt).toBe(false)
  })

  test("classifies summarize tasks as grunt", () => {
    const result = analyze({ text: "Summarize what this file does", fileCount: 0, wordCount: 6 })
    expect(result.grunt).toBe(true)
    expect(result.difficulty).toBe("easy")
  })

  test("classifies many attached files as grunt", () => {
    const result = analyze({ text: "Review these", fileCount: 5, wordCount: 2 })
    expect(result.grunt).toBe(true)
  })

  test("classifies short rename prompts as grunt", () => {
    const result = analyze({ text: "rename foo to bar", fileCount: 0, wordCount: 4 })
    expect(result.difficulty).toBe("easy")
    expect(result.grunt).toBe(true)
  })

  test("classifies ordinary prompts as medium", () => {
    const text =
      "Extend the workspace settings page with a new section for notification preferences, including per-channel toggles and a save button that persists to the existing settings store."
    const result = analyze({ text, fileCount: 0, wordCount: text.split(/\s+/).length })
    expect(result.difficulty).toBe("medium")
    expect(result.grunt).toBe(false)
  })
})

describe("decide", () => {
  test("routes grunt work to small model", () => {
    const decision = decide({ text: "Summarize this file", fileCount: 0, wordCount: 3 }, {})
    expect(decision.route).toBe("small")
  })

  test("routes hard work to main model with high effort", () => {
    const decision = decide({ text: "Debug the deadlock in this concurrency code", fileCount: 0, wordCount: 7 }, {})
    expect(decision.route).toBe("main")
    expect(decision.effort).toBe("high")
  })

  test("honors custom effort overrides", () => {
    const decision = decide(
      { text: "Debug the deadlock", fileCount: 0, wordCount: 3 },
      { hard: "max", easy: null },
    )
    expect(decision.effort).toBe("max")
  })

  test("easy grunt leaves effort null when overridden", () => {
    const decision = decide({ text: "Summarize this file", fileCount: 0, wordCount: 3 }, { easy: null })
    expect(decision.effort).toBe(null)
  })
})
