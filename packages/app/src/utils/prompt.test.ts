import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { extractPromptFromParts, isHarnessNote } from "./prompt"

describe("extractPromptFromParts", () => {
  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      {
        type: "image",
        filename: "a.png",
        mime: "image/png",
        blob: expect.objectContaining({ id: expect.any(String) }),
      },
      {
        type: "image",
        filename: "b.pdf",
        mime: "application/pdf",
        blob: expect.objectContaining({ id: expect.any(String) }),
      },
    ])
  })
})

describe("isHarnessNote", () => {
  const base = { id: "prt_1", sessionID: "ses_1", messageID: "msg_1" }

  test("recognises a reminder the harness injected", () => {
    const parts = [
      {
        ...base,
        type: "reminder",
        kind: "todo_continue",
        label: "Task completion",
        text: "<system-reminder>[task completion] finish your todos</system-reminder>",
      },
    ] as unknown as Part[]
    expect(isHarnessNote(parts)).toBe(true)
    // A note carries no text part, so undo would restore an empty prompt box
    // from it — which is why undo must skip the message entirely.
    expect(extractPromptFromParts(parts)).toMatchObject([{ type: "text", content: "" }])
  })

  test("leaves the user's own messages and other synthetic parts alone", () => {
    expect(isHarnessNote([{ ...base, type: "text", text: "add the feature" }] as Part[])).toBe(false)
    expect(
      isHarnessNote([{ ...base, type: "text", text: "Continue if you have next steps.", synthetic: true }] as Part[]),
    ).toBe(false)
    expect(isHarnessNote(undefined)).toBe(false)
  })
})
