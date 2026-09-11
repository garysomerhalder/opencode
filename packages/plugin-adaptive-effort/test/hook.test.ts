import { describe, expect, test } from "bun:test"
import pluginModule from "../src/index"

const { server } = pluginModule

type MessageOutput = {
  message: { model: { providerID: string; modelID: string; variant?: string } }
  parts: Array<{ type: string; text?: string; [k: string]: unknown }>
}

function mockClient(config: { small_model?: string } = {}) {
  return {
    config: { get: async () => ({ data: config }) },
    session: {
      create: async () => ({ data: { id: undefined } }),
      prompt: async () => ({ data: { parts: [] } }),
      delete: async () => ({}),
    },
  } as any
}

async function run(text: string, options: any = {}) {
  const hooks = await server({ client: mockClient({ small_model: "openai/gpt-5-nano" }) } as any, options)
  const hook = hooks["chat.message"]!
  const output: MessageOutput = {
    message: { model: { providerID: "main", modelID: "big" } },
    parts: [{ type: "text", text }],
  }
  await hook({ sessionID: "ses_test", agent: "build", variant: undefined }, output as any)
  return output.message.model
}

describe("chat.message hook", () => {
  test("routes grunt work to the small model", async () => {
    const model = await run("Summarize what this file does")
    expect(model.providerID).toBe("openai")
    expect(model.modelID).toBe("gpt-5-nano")
    expect(model.variant).toBeUndefined()
  })

  test("sets low effort for trivial prompts on the main model", async () => {
    const model = await run("hi")
    expect(model.providerID).toBe("main")
    expect(model.variant).toBe("low")
  })

  test("sets high effort for hard prompts", async () => {
    const model = await run("Debug the race condition in this concurrency code")
    expect(model.providerID).toBe("main")
    expect(model.variant).toBe("high")
  })

  test("leaves medium prompts at the default variant", async () => {
    const model = await run(
      "Extend the workspace settings page with a new section for notification preferences.",
    )
    expect(model.providerID).toBe("main")
    expect(model.variant).toBeUndefined()
  })

  test("respects an explicitly selected variant", async () => {
    const hooks = await server({ client: mockClient({ small_model: "openai/gpt-5-nano" }) } as any, {})
    const output: MessageOutput = {
      message: { model: { providerID: "main", modelID: "big", variant: "max" } },
      parts: [{ type: "text", text: "Debug the race condition" }],
    }
    await hooks["chat.message"]!({ sessionID: "ses_test", agent: "build", variant: "max" }, output as any)
    expect(output.message.model.variant).toBe("max")
  })
})
