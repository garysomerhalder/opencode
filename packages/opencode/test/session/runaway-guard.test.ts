import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { RunawayGuard } from "../../src/session/runaway-guard"

function tool(input: {
  tool: string
  args: unknown
  output?: string
  error?: string
  rejected?: boolean
  providerExecuted?: boolean
}): SessionV1.ToolPart {
  const base = {
    id: "prt_" + Math.random().toString(36).slice(2),
    messageID: "msg_1",
    sessionID: "ses_1",
    type: "tool" as const,
    callID: "call_" + Math.random().toString(36).slice(2),
    tool: input.tool,
    ...(input.providerExecuted ? { metadata: { providerExecuted: true } } : {}),
  }
  if (input.error !== undefined)
    return {
      ...base,
      state: {
        status: "error",
        input: input.args,
        error: input.error,
        ...(input.rejected ? { metadata: { rejected: true } } : {}),
        time: { start: 1, end: 2 },
      },
    } as SessionV1.ToolPart
  return {
    ...base,
    state: {
      status: "completed",
      input: input.args,
      output: input.output ?? "done",
      title: input.tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  } as SessionV1.ToolPart
}

function observe(state: RunawayGuard.State, parts: SessionV1.ToolPart[]) {
  return RunawayGuard.observe(state, parts)
}

describe("runaway guard", () => {
  test("three identical actions in consecutive steps produce one reminder", () => {
    const state = RunawayGuard.create({ threshold: 3 })
    const step = () => [tool({ tool: "bash", args: { command: "bun test" }, output: `run ${Math.random()}` })]
    expect(observe(state, step())).toBeUndefined()
    expect(observe(state, step())).toBeUndefined()
    const reminder = observe(state, step())
    expect(reminder).toBeDefined()
    expect(reminder!.kind).toBe("action")
    expect(reminder!.text).toContain("bash")
    // at most one reminder per turn
    expect(observe(state, step())).toBeUndefined()
  })

  test("a repeat interrupted by a different action does not trigger", () => {
    const state = RunawayGuard.create({ threshold: 3 })
    const same = () => [tool({ tool: "read", args: { filePath: "/a" }, output: `a${Math.random()}` })]
    expect(observe(state, same())).toBeUndefined()
    expect(observe(state, [tool({ tool: "read", args: { filePath: "/b" }, output: "b" })])).toBeUndefined()
    expect(observe(state, same())).toBeUndefined()
    expect(observe(state, same())).toBeUndefined()
  })

  test("the same error family across different inputs triggers", () => {
    const state = RunawayGuard.create({ threshold: 3 })
    const fail = (path: string) => [tool({ tool: "read", args: { filePath: path }, error: `ENOENT: not found ${path}` })]
    expect(observe(state, fail("/a"))).toBeUndefined()
    expect(observe(state, fail("/b"))).toBeUndefined()
    const reminder = observe(state, fail("/c"))
    expect(reminder?.kind).toBe("error")
    expect(reminder?.text).toContain("not_found")
  })

  test("identical results with different inputs trigger", () => {
    const state = RunawayGuard.create({ threshold: 3 })
    const same = (n: number) => [tool({ tool: "grep", args: { pattern: `p${n}` }, output: "No matches found" })]
    expect(observe(state, same(1))).toBeUndefined()
    expect(observe(state, same(2))).toBeUndefined()
    expect(observe(state, same(3))?.kind).toBe("result")
  })

  test("permission-rejected and provider-executed calls are ignored", () => {
    const state = RunawayGuard.create({ threshold: 3 })
    const step = () => [
      tool({ tool: "bash", args: { command: "rm -rf /" }, error: "The user rejected permission", rejected: true }),
      tool({ tool: "websearch", args: { query: "x" }, output: "nope", providerExecuted: true }),
    ]
    expect(observe(state, step())).toBeUndefined()
    expect(observe(state, step())).toBeUndefined()
    expect(observe(state, step())).toBeUndefined()
    expect(observe(state, step())).toBeUndefined()
  })

  test("the threshold is configurable", () => {
    const state = RunawayGuard.create({ threshold: 2 })
    const step = () => [tool({ tool: "glob", args: { pattern: "**/*.ts" }, output: `x${Math.random()}` })]
    expect(observe(state, step())).toBeUndefined()
    expect(observe(state, step())).toBeDefined()
  })

  test("the reminder text never contains raw tool output", () => {
    const state = RunawayGuard.create({ threshold: 2 })
    const secret = "sk-live-SUPERSECRET-TOKEN"
    const step = () => [tool({ tool: "bash", args: { command: `echo ${secret}` }, output: secret })]
    observe(state, step())
    const reminder = observe(state, step())
    expect(reminder).toBeDefined()
    expect(reminder!.text).not.toContain(secret)
    expect(reminder!.log.fingerprint).not.toContain(secret)
    expect(JSON.stringify(reminder!.log)).not.toContain(secret)
  })

  test("a step with no tool calls clears the streak", () => {
    const state = RunawayGuard.create({ threshold: 3 })
    const step = () => [tool({ tool: "bash", args: { command: "ls" }, output: `x${Math.random()}` })]
    observe(state, step())
    observe(state, step())
    observe(state, [])
    expect(observe(state, step())).toBeUndefined()
  })
})
