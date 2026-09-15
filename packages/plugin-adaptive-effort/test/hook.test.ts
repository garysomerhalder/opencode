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
      create: async () => ({ data: { id: "ses_delegate" } }),
      prompt: async () => ({ data: { parts: [{ type: "text", text: "SUMMARY" }] } }),
      delete: async () => ({}),
      messages: async () => ({ data: [] }),
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

  test("strips image/file parts when routing to the small model", async () => {
    const hooks = await server({ client: mockClient({ small_model: "openai/gpt-5-nano" }) } as any, {})
    const output: MessageOutput = {
      message: { model: { providerID: "main", modelID: "big" } },
      parts: [
        { type: "text", text: "Summarize what this file does" },
        { type: "file", id: "p1", mime: "image/png", url: "data:image/png;base64,AAAA" },
        { type: "file", id: "p2", mime: "text/plain", url: "file:///tmp/a.txt" },
      ],
    }
    await hooks["chat.message"]!({ sessionID: "ses_test", agent: "build", variant: undefined }, output as any)
    expect(output.message.model.providerID).toBe("openai")
    expect(output.message.model.modelID).toBe("gpt-5-nano")
    expect(output.parts).toHaveLength(3)
    expect(output.parts[0].text).toBe("Summarize what this file does")
    for (const part of output.parts.slice(1)) {
      expect(part.type).toBe("text")
      expect(part.text).toContain("omitted")
    }
    expect(output.parts[1].text).toContain("image")
  })

  test("routes text-only grunt work without adding placeholders", async () => {
    const hooks = await server({ client: mockClient({ small_model: "openai/gpt-5-nano" }) } as any, {})
    const output: MessageOutput = {
      message: { model: { providerID: "main", modelID: "big" } },
      parts: [{ type: "text", text: "Summarize what this file does" }],
    }
    await hooks["chat.message"]!({ sessionID: "ses_test", agent: "build", variant: undefined }, output as any)
    expect(output.parts).toHaveLength(1)
    expect(output.parts[0].text).toBe("Summarize what this file does")
  })
})

describe("tool.execute.after read summarization", () => {
  function largeContent(lines = 400): string {
    return `<path>/repo/src/big.ts</path>\n<type>file</type>\n<content>\n` +
      Array.from({ length: lines }, (_, i) => `${i + 1}: line ${i + 1}`).join("\n") +
      `\n</content>`
  }

  async function runRead(args: any, content: string, options: any = {}) {
    const hooks = await server({ client: mockClient({ small_model: "openai/gpt-5-nano" }) } as any, options)
    const output = { title: "big.ts", output: content, metadata: {} }
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "ses_test", callID: "call_1", args },
      output as any,
    )
    return output
  }

  test("replaces large file content with a summary", async () => {
    const output = await runRead({ filePath: "/repo/src/big.ts" }, largeContent())
    expect(output.output).toContain("SUMMARY")
    expect(output.output).toContain("summarized")
    expect(output.output).not.toContain("line 200")
    expect(output.title).toContain("(summarized)")
  })

  test("leaves small reads untouched", async () => {
    const content = largeContent(50)
    const output = await runRead({ filePath: "/repo/src/small.ts" }, content)
    expect(output.output).toBe(content)
  })

  test("leaves targeted reads with an explicit limit untouched", async () => {
    const content = largeContent()
    const output = await runRead({ filePath: "/repo/src/big.ts", limit: 50 }, content)
    expect(output.output).toBe(content)
  })

  test("leaves targeted reads with an offset untouched", async () => {
    const content = largeContent()
    const output = await runRead({ filePath: "/repo/src/big.ts", offset: 400 }, content)
    expect(output.output).toBe(content)
  })

  test("does nothing for non-read tools", async () => {
    const hooks = await server({ client: mockClient({ small_model: "openai/gpt-5-nano" }) } as any, {})
    const output = { title: "x", output: "hello", metadata: {} }
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "ses_test", callID: "call_1", args: {} },
      output as any,
    )
    expect(output.output).toBe("hello")
  })

  test("respects the read option when disabled", async () => {
    const content = largeContent()
    const output = await runRead({ filePath: "/repo/src/big.ts" }, content, { read: false })
    expect(output.output).toBe(content)
  })
})
