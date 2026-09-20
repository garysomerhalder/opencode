import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { HarnessNote } from "../../src/session/harness-note"

const part = (input: Record<string, unknown>) =>
  ({ id: "prt_" + Math.random().toString(36).slice(2), sessionID: "ses_1", messageID: "msg_1", ...input }) as any

const message = (id: string, role: "user" | "assistant", parts: unknown[]) =>
  ({ info: { id, role } as unknown as SessionV1.Info, parts: parts as SessionV1.Part[] }) as {
    info: SessionV1.Info
    parts: SessionV1.Part[]
  }

const prompt = message("msg_1", "user", [
  part({ type: "text", text: "ship the feature" }),
  part({ type: "agent", name: "build" }),
])
const answer = message("msg_2", "assistant", [part({ type: "text", text: "on it" })])
const note = message("msg_3", "user", [
  part({
    type: "reminder",
    kind: "runaway_guard",
    label: "Runaway guard",
    text: "<system-reminder>[runaway guard] change approach</system-reminder>",
  }),
])
const compactionContinue = message("msg_4", "user", [
  part({ type: "text", text: "Continue if you have next steps.", synthetic: true, metadata: { compaction_continue: true } }),
])

const user: SessionV1.User = {
  id: "msg_1" as SessionV1.User["id"],
  sessionID: "ses_1" as SessionV1.User["sessionID"],
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "test" as any, modelID: "test-model" as any },
  autonomous: true,
  system: "carry me",
}

describe("harness notes", () => {
  test("a reminder part makes a note; a synthetic text part does not", () => {
    expect(HarnessNote.isNote(note)).toBe(true)
    expect(HarnessNote.isNote(prompt)).toBe(false)
    expect(HarnessNote.isNote(compactionContinue)).toBe(false)
    expect(HarnessNote.isNote(answer)).toBe(false)
    expect(HarnessNote.isNote(undefined)).toBe(false)
  })

  test("kind reports which reminder it was", () => {
    expect(HarnessNote.kind(note.parts)).toBe("runaway_guard")
    expect(HarnessNote.kind(prompt.parts)).toBeUndefined()
  })

  test("lastRealUser skips notes, so an @agent turn keeps its exemption", () => {
    const found = HarnessNote.lastRealUser([prompt, answer, note])
    expect(String(found?.info.id)).toBe("msg_1")
    expect(found?.parts.some((p) => p.type === "agent")).toBe(true)
  })

  test("lastRealUser returns nothing when the user has not spoken", () => {
    expect(HarnessNote.lastRealUser([answer, note])).toBeUndefined()
  })

  test("build carries the turn's settings onto a new message", () => {
    const built = HarnessNote.build({ user, kind: "todo_continue", text: "finish your todos", label: "Task completion" })
    expect(built.info.id).not.toBe(user.id)
    expect(built.info.agent).toBe("build")
    expect(built.info.autonomous).toBe(true)
    expect(built.info.system).toBe("carry me")
    expect(built.part.type).toBe("reminder")
    expect(built.part.kind).toBe("todo_continue")
    expect(built.part.label).toBe("Task completion")
    expect(built.part.text).toBe("finish your todos")
    expect(built.part.messageID).toBe(built.info.id)
    expect(HarnessNote.isNote({ info: built.info, parts: [built.part] })).toBe(true)
  })
})
