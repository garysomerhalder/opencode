import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { HarnessNote } from "../src/routes/session/harness-note"

const part = (input: Partial<Part> & { type: string }) =>
  ({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", ...input }) as Part

const prompt = [part({ type: "text", text: "add the feature" })]
const note = [
  part({
    type: "reminder",
    kind: "runaway_guard",
    label: "Runaway guard",
    text: "<system-reminder>[runaway guard] change approach</system-reminder>",
  }),
]
const compactionContinue = [part({ type: "text", text: "Continue if you have next steps.", synthetic: true })]

const messages = [
  { id: "msg_1", role: "user" },
  { id: "msg_2", role: "assistant" },
  { id: "msg_3", role: "user" },
  { id: "msg_4", role: "assistant" },
]
const parts = (id: string) => (id === "msg_3" ? note : id === "msg_1" ? prompt : undefined)

describe("harness notes", () => {
  test("a reminder part marks a note; a synthetic text part does not", () => {
    expect(HarnessNote.isNote(note)).toBe(true)
    expect(HarnessNote.isNote(prompt)).toBe(false)
    expect(HarnessNote.isNote(compactionContinue)).toBe(false)
    expect(HarnessNote.isNote(undefined)).toBe(false)
  })

  test("undo steps back to the user's own message, not the reminder", () => {
    expect(HarnessNote.lastUser(messages, parts)?.id).toBe("msg_1")
  })

  test("redo steps forward to the user's own message, not the reminder", () => {
    const withLater = [...messages, { id: "msg_5", role: "user" }]
    const withLaterParts = (id: string) => (id === "msg_5" ? prompt : parts(id))
    expect(HarnessNote.nextUser(withLater, "msg_1", withLaterParts)?.id).toBe("msg_5")
    expect(HarnessNote.nextUser(messages, "msg_1", parts)).toBeUndefined()
  })
})
