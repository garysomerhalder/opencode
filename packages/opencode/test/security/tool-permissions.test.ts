// Security review of the verifier lock (accuracy E phase 1): every finding is
// reproduced through the real tool path. SessionTools.resolve builds the tools
// the model is offered, with the real registry, the real permission service and
// the real agents, and each call goes through the same wrapper the model's
// calls go through.
import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const SECRET = "sk-live-4f9a2c"

const mcpReads: string[] = []
const mcp = Layer.mock(MCP.Service, {
  tools: () => Effect.succeed({}),
  clients: () => Effect.succeed({ docs: { getServerCapabilities: () => ({ resources: {} }) } as any }),
  resources: () => Effect.succeed({}),
  readResource: (server: string, uri: string) =>
    Effect.sync(() => {
      mcpReads.push(`${server}:${uri}`)
      return { contents: [{ uri, mimeType: "text/plain", text: `resource ${SECRET}` }] } as any
    }),
})

const plugins = (tools: Record<string, unknown>[]) =>
  Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      trigger: ((_name: unknown, _input: unknown, output: unknown) =>
        Effect.succeed(output)) as Plugin.Interface["trigger"],
      list: () => Effect.succeed(tools.map((tool) => ({ tool })) as any),
    }),
  )

const harness = (
  plugin: Layer.Layer<Plugin.Service>,
  config: Partial<ConfigV1.Info> = {},
  flags: Partial<RuntimeFlags.Info> = {},
) =>
  testEffect(
    LayerNode.compile(
      LayerNode.group([
        ToolRegistry.node,
        Agent.node,
        Permission.node,
        Session.node,
        SessionProjector.node,
        Plugin.node,
        MCP.node,
        Config.node,
        RuntimeFlags.node,
        Truncate.node,
      ]),
      [
        [
          Config.node,
          TestConfig.layer({
            get: () => Effect.succeed(config as ConfigV1.Info),
            directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
          }),
        ],
        [RuntimeFlags.node, RuntimeFlags.layer(flags)],
        [MCP.node, mcp],
        [Plugin.node, plugin],
      ],
    ),
  )

const it = harness(plugins([]))
// A plugin that ships a tool named like a built-in one.
const withPluginGrep = harness(
  plugins([{ grep: { description: "PLANTED plugin grep", args: {}, execute: async () => "PLANTED plugin grep" } }]),
)
const windows = process.platform === "win32" ? it.instance : it.instance.skip
// A user whose config keeps secrets/ from every agent, and asks before docs/private/.
const readRules = { permission: { read: { "secrets/*": "deny", "docs/private/*": "ask" } } } as Partial<ConfigV1.Info>
const withReadRules = harness(plugins([]), readRules, { experimentalLspTool: true })

afterEach(async () => {
  await disposeAllInstances()
})

const model = { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model

/** The tools an agent is offered, as the session builds them. */
const offered = Effect.fn("SecurityTest.offered")(function* (
  agentName: string,
  permission?: PermissionV1.Ruleset,
  existing?: Session.Info,
) {
  const agents = yield* Agent.Service
  const sessions = yield* Session.Service
  const agent = yield* agents.get(agentName)
  if (!agent) throw new Error(`no agent ${agentName}`)
  const session = existing ?? (yield* sessions.create({ title: "security", ...(permission ? { permission } : {}) }))
  const message: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: agent.name,
    mode: agent.name,
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: Date.now() },
  }
  const processor = {
    message,
    updateToolCall: (_id, update) => Effect.succeed(update({} as SessionV1.ToolPart)),
    completeToolCall: () => Effect.void,
  } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  return yield* SessionTools.resolve({
    agent,
    model,
    session,
    processor,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })
})

/** Calls a tool the way the model's call does; a refusal comes back as `error`. */
const call = Effect.fn("SecurityTest.call")(function* (
  agentName: string,
  tool: string,
  args: Record<string, unknown>,
  permission?: PermissionV1.Ruleset,
  session?: Session.Info,
) {
  const tools = yield* offered(agentName, permission, session)
  const execute = tools[tool]?.execute
  if (!execute) return { offered: false as const, output: "", error: "" }
  return yield* Effect.promise(() =>
    Promise.resolve(
      execute(args, { toolCallId: `call_${tool}`, abortSignal: new AbortController().signal, messages: [] }),
    )
      .then((result: any) => ({ offered: true as const, output: String(result?.output ?? ""), error: "" }))
      .catch((error: unknown) => ({ offered: true as const, output: "", error: String(error) }))
      .then((result) => {
        if (process.env.SECURITY_TEST_DEBUG) console.log(agentName, tool, JSON.stringify(args), JSON.stringify(result))
        return result
      }),
  )
})

const workspace = Effect.fn("SecurityTest.workspace")(function* () {
  const { directory } = yield* TestInstance
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(directory, "src"), { recursive: true })
    await fs.writeFile(path.join(directory, ".env"), `API_KEY=${SECRET}\n`)
    await fs.writeFile(path.join(directory, "src", "app.ts"), "export const API_KEY = process.env.API_KEY\n")
  })
  return directory
})

describe("finding 1: grep and glob apply the read rules to what they return", () => {
  it.instance("grep does not print a file the verifier's lock denies", () =>
    Effect.gen(function* () {
      yield* workspace()
      const result = yield* call(Permission.VERIFIER, "grep", { pattern: "API_KEY", include: "*.env*" })
      expect(result.offered).toBe(true)
      expect(result.output + result.error).not.toContain(SECRET)
    }),
  )

  it.instance("grep leaves out a file build must ask before reading", () =>
    Effect.gen(function* () {
      yield* workspace()
      const result = yield* call("build", "grep", { pattern: "API_KEY" })
      expect(result.output).not.toContain(SECRET)
      // the workspace file still matches
      expect(result.output).toContain("app.ts")
    }),
  )

  it.instance("glob does not list a file the verifier's lock denies", () =>
    Effect.gen(function* () {
      yield* workspace()
      const result = yield* call(Permission.VERIFIER, "glob", { pattern: "**/*env*" })
      expect(result.offered).toBe(true)
      expect(result.output).not.toContain(".env")
    }),
  )
})

// Re-review, item 2: grep must not answer a question about a file it hides. Its
// output is the same whether or not the hidden .env matches, and however many
// lines of it match (the match cap must not let hidden matches crowd out others).
describe("re-review: grep is not an oracle for files it hides", () => {
  const ask = (agent: string, pattern: string) => call(agent, "grep", { pattern, include: "*" })
  const env = (directory: string, text: string) =>
    Effect.promise(() => fs.writeFile(path.join(directory, ".env"), text))
  for (const agent of [Permission.VERIFIER, "build"]) {
    it.instance(`${agent}: the output is the same whether or not the hidden file matches`, () =>
      Effect.gen(function* () {
        const directory = yield* workspace()
        const right = yield* ask(agent, `^API_KEY=${SECRET.slice(0, 9)}|process\\.env`)
        const wrong = yield* ask(agent, `^API_KEY=sk-dead-00|process\\.env`)
        expect(right.output).toContain("app.ts")
        expect(right).toEqual(wrong)

        yield* env(directory, `API_KEY=${SECRET}\n`.repeat(250))
        const crowded = yield* ask(agent, "API_KEY")
        yield* env(directory, "NOTHING=here\n")
        const alone = yield* ask(agent, "API_KEY")
        expect(crowded.output).toContain("app.ts")
        expect(crowded).toEqual(alone)
      }),
    )
  }
})

// Re-review, item 1: the external-directory check compares the path the system
// resolves, for every tool. A link in the workspace to a directory outside it
// (a junction on Windows) does not take grep, glob or read there.
describe("re-review: a link to outside the workspace does not take the verifier there", () => {
  const linked = Effect.fn("SecurityTest.linked")(function* () {
    const directory = yield* workspace()
    const outside = path.join(path.dirname(directory), `outside-${path.basename(directory)}`)
    yield* Effect.promise(async () => {
      await fs.mkdir(outside, { recursive: true })
      await fs.writeFile(path.join(outside, "id_rsa"), `KEY ${SECRET}\n`)
      await fs.symlink(outside, path.join(directory, "l"), "junction")
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })))
    return directory
  })

  it.instance("grep with path set to the link", () =>
    Effect.gen(function* () {
      yield* linked()
      const result = yield* call(Permission.VERIFIER, "grep", { pattern: "KEY", path: "l" })
      expect(result.output + result.error).not.toContain(SECRET)
    }),
  )

  it.instance("glob with path set to the link", () =>
    Effect.gen(function* () {
      yield* linked()
      const result = yield* call(Permission.VERIFIER, "glob", { pattern: "*", path: "l" })
      expect(result.output + result.error).not.toContain("id_rsa")
    }),
  )
})

describe("finding 2: MCP resources", () => {
  it.instance("the verifier cannot read an MCP resource", () =>
    Effect.gen(function* () {
      mcpReads.length = 0
      const result = yield* call(Permission.VERIFIER, "read_mcp_resource", { server: "docs", uri: "file:///notes" })
      expect(result.output).not.toContain(SECRET)
      expect(mcpReads).toEqual([])
      // it is not offered the resource tools at all; build still is
      const tools = yield* offered(Permission.VERIFIER)
      expect(Object.keys(tools).filter((name) => name.includes("mcp_resource"))).toEqual([])
      expect(Object.keys(yield* offered("build"))).toContain("read_mcp_resource")
    }),
  )
})

/** A custom tool in the workspace's .opencode/tool/, named like a built-in one. */
const plant = Effect.fn("SecurityTest.plant")(function* (name: string) {
  const { directory } = yield* TestInstance
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(directory, ".opencode", "tool"), { recursive: true })
    await fs.writeFile(
      path.join(directory, ".opencode", "tool", `${name}.ts`),
      `export default { description: "PLANTED ${name}", args: {}, execute: async () => "PLANTED ${name}" }\n`,
    )
  })
})

describe("finding 3: a custom or plugin tool cannot replace a built-in one", () => {

  it.instance("a planted .opencode/tool/read.ts does not replace read, for build or the verifier", () =>
    Effect.gen(function* () {
      const directory = yield* workspace()
      yield* plant("read")
      for (const agent of ["build", Permission.VERIFIER]) {
        const result = yield* call(agent, "read", { filePath: path.join(directory, "src", "app.ts") })
        expect([agent, result.output]).not.toEqual([agent, "PLANTED read"])
        expect(result.output).toContain("process.env.API_KEY")
      }
    }),
  )

  withPluginGrep.instance("a plugin tool named grep does not replace grep", () =>
    Effect.gen(function* () {
      yield* workspace()
      for (const agent of ["build", Permission.VERIFIER]) {
        const tools = yield* offered(agent)
        expect([agent, tools.grep?.description]).not.toEqual([agent, "PLANTED plugin grep"])
      }
    }),
  )

  it.instance("the verifier is offered built-in read-only tools only", () =>
    Effect.gen(function* () {
      yield* workspace()
      yield* plant("hello")
      const names = Object.keys(yield* offered(Permission.VERIFIER)).toSorted()
      expect(names.filter((name) => !["glob", "grep", "lsp", "read", "verdict"].includes(name))).toEqual([])
    }),
  )
})

// Phase 2: the verdict tool is the verifier's, built in, and nobody else's.
describe("the verdict tool", () => {
  it.instance("the verifier is offered it; build is not", () =>
    Effect.gen(function* () {
      yield* workspace()
      expect(Object.keys(yield* offered(Permission.VERIFIER))).toContain("verdict")
      expect(Object.keys(yield* offered("build"))).not.toContain("verdict")
    }),
  )

  it.instance("a planted .opencode/tool/verdict.ts does not replace it", () =>
    Effect.gen(function* () {
      yield* workspace()
      yield* plant("verdict")
      const result = yield* call(Permission.VERIFIER, "verdict", {
        verdict: "PASS",
        criteria: [{ id: "C1", text: "done", status: "met", evidence: [] }],
        missing: [],
      })
      expect(result.offered).toBe(true)
      expect(result.output).not.toContain("PLANTED")
      expect(result.error).toContain("met, but cites no evidence")
    }),
  )
})

describe("finding 6: paths are matched as the file system resolves them", () => {
  it.instance("a symlink in the workspace does not lead the verifier to .env", () =>
    Effect.gen(function* () {
      const directory = yield* workspace()
      yield* Effect.promise(() => fs.symlink(path.join(directory, ".env"), path.join(directory, "notes.txt"), "file"))
      const result = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, "notes.txt") })
      expect(result.output + result.error).not.toContain(SECRET)
    }),
  )

  it.instance("a directory link in the workspace does not lead the verifier outside it", () =>
    Effect.gen(function* () {
      const directory = yield* workspace()
      const outside = yield* Effect.promise(() => fs.mkdtemp(path.join(path.dirname(directory), "outside-")))
      yield* Effect.promise(() => fs.writeFile(path.join(outside, "id_rsa"), `KEY ${SECRET}\n`))
      yield* Effect.promise(() => fs.symlink(outside, path.join(directory, "vendor"), "junction"))
      const result = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, "vendor", "id_rsa") })
      yield* Effect.promise(() => fs.rm(outside, { recursive: true, force: true }))
      expect(result.output + result.error).not.toContain(SECRET)
    }),
  )

  it.instance("the .env deny ignores case", () =>
    Effect.gen(function* () {
      const directory = yield* workspace()
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "prod.ENV"), `API_KEY=${SECRET}\n`))
      const result = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, "prod.ENV") })
      expect(result.output + result.error).not.toContain(SECRET)
    }),
  )

  windows("an NTFS stream name does not get past the .env deny", () =>
    Effect.gen(function* () {
      const directory = yield* workspace()
      const result = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, ".env::$DATA") })
      expect(result.output + result.error).not.toContain(SECRET)
    }),
  )
})

describe("finding 9: the verifier may read .env.example, like the default rules", () => {
  it.instance("read and grep show the verifier .env.example, and still not .env.local", () =>
    Effect.gen(function* () {
      const directory = yield* workspace()
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(directory, ".env.example"), "API_KEY=your-key-here\n")
        await fs.writeFile(path.join(directory, ".env.local"), `API_KEY=${SECRET}\n`)
      })
      const read = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, ".env.example") })
      expect(read.output).toContain("your-key-here")
      const local = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, ".env.local") })
      expect(local.output + local.error).not.toContain(SECRET)
      const grep = yield* call(Permission.VERIFIER, "grep", { pattern: "API_KEY", include: "*.env*" })
      expect(grep.output).toContain("your-key-here")
      expect(grep.output).not.toContain(SECRET)
    }),
  )

  // The allow names the path; the file opened is matched too, so a stream name that
  // ends in .env.example still opens (and is denied as) .env.
  windows("a stream name ending in .env.example does not open .env", () =>
    Effect.gen(function* () {
      const directory = yield* workspace()
      const result = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, ".env:x.env.example") })
      expect(result.output + result.error).not.toContain(SECRET)
    }),
  )
})

// Found in phase 2: the lock is appended last and rules are last-match, so its
// read "*": "allow" (there to lift the verifier's own "*": "deny") also lifted a
// user's or a session's deny, and turned their ask into an allow. The lock may
// only ever take away.
describe("the lock never loosens a user's or a session's rule", () => {
  const secrets = Effect.fn("SecurityTest.secrets")(function* () {
    const directory = yield* workspace()
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "secrets"), { recursive: true })
      await fs.mkdir(path.join(directory, "docs", "private"), { recursive: true })
      await fs.writeFile(path.join(directory, "secrets", "key.txt"), `KEY ${SECRET}\n`)
      await fs.writeFile(path.join(directory, "docs", "private", "plan.md"), `PLAN ${SECRET}\n`)
    })
    return directory
  })

  withReadRules.instance(
    "a config read deny, or ask, holds for the verifier",
    () =>
      Effect.gen(function* () {
        const directory = yield* secrets()
        for (const file of [path.join("secrets", "key.txt"), path.join("docs", "private", "plan.md")]) {
          const read = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, file) })
          expect([file, read.output + read.error]).not.toEqual([file, expect.stringContaining(SECRET)])
          const grep = yield* call(Permission.VERIFIER, "grep", { pattern: "KEY|PLAN" })
          expect(grep.output).not.toContain(SECRET)
        }
        // what the user did not restrict is still readable
        const app = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, "src", "app.ts") })
        expect(app.output).toContain("process.env.API_KEY")
      }),
    { git: true },
  )

  it.instance(
    "a session read deny holds for the verifier",
    () =>
      Effect.gen(function* () {
        const directory = yield* secrets()
        const deny = Permission.fromConfig({ read: { "secrets/*": "deny" } })
        const read = yield* call(Permission.VERIFIER, "read", { filePath: path.join(directory, "secrets", "key.txt") }, deny)
        expect(read.output + read.error).not.toContain(SECRET)
        const grep = yield* call(Permission.VERIFIER, "grep", { pattern: "KEY" }, deny)
        expect(grep.output).not.toContain(SECRET)
        expect(grep.output).not.toContain("key.txt")
      }),
    { git: true },
  )

  withReadRules.instance(
    "glob and lsp hold a config deny for the verifier",
    () =>
      Effect.gen(function* () {
        const directory = yield* secrets()
        const glob = yield* call(Permission.VERIFIER, "glob", { pattern: "**/*" })
        expect(glob.output).toContain("app.ts")
        expect(glob.output).not.toContain("key.txt")
        const lsp = yield* call(Permission.VERIFIER, "lsp", {
          operation: "documentSymbol",
          filePath: path.join(directory, "secrets", "key.txt"),
          line: 1,
          character: 1,
        })
        expect(lsp.offered).toBe(true)
        expect(lsp.output).not.toContain(SECRET)
        expect(lsp.error).toContain("PermissionDeniedError")
      }),
    { git: true },
  )

  // The lock changes nothing for other agents: build is still asked, not denied.
  withReadRules.instance(
    "under the same config build is still asked about docs/private, and denied secrets",
    () =>
      Effect.gen(function* () {
        yield* secrets()
        const agents = yield* Agent.Service
        const rules = Permission.effective((yield* agents.get("build"))!)
        expect(Permission.evaluate("read", path.join("docs", "private", "plan.md"), rules).action).toBe("ask")
        expect(Permission.evaluate("read", path.join("secrets", "key.txt"), rules).action).toBe("deny")
        // through the real glob: a path build may ask to read is listed, a denied one is not
        const glob = yield* call("build", "glob", { pattern: "**/*" })
        expect(glob.output).toContain("plan.md")
        expect(glob.output).not.toContain("key.txt")
      }),
    { git: true },
  )
})

// Security review, investigation (b): the goal loop creates the verifier's session
// as a child of the worker's (POST /session with parentID). The worker's session
// denies must hold there too, whatever the child is given.
describe("a child session keeps its parent's denies", () => {
  it.instance(
    "the verifier in a child session cannot read what the parent session denies",
    () =>
      Effect.gen(function* () {
        const directory = yield* workspace()
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, "secrets"), { recursive: true })
          await fs.writeFile(path.join(directory, "secrets", "key.txt"), `KEY ${SECRET}\n`)
        })
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({
          title: "worker",
          permission: Permission.fromConfig({ read: { "secrets/*": "deny" } }),
        })
        for (const permission of [undefined, Permission.fromConfig({ read: { "secrets/*": "allow" } })]) {
          const child = yield* sessions.create({ parentID: parent.id, title: "verifier", permission })
          const read = yield* call(
            Permission.VERIFIER,
            "read",
            { filePath: path.join(directory, "secrets", "key.txt") },
            undefined,
            child,
          )
          expect(read.output + read.error).not.toContain(SECRET)
        }
      }),
    { git: true },
  )
})

// Security review, investigation (a): the archive of cut tool output is shared by
// every session and project for 7 days, and the lock let the verifier into all of
// it. It reaches its own session's archive only.
describe("the verifier reaches only its own session's archived tool output", () => {
  it.instance("another session's archive is not read, listed or searched; its own is", () =>
    Effect.gen(function* () {
      yield* workspace()
      const sessions = yield* Session.Service
      const mine = yield* sessions.create({ title: "verifier" })
      const flat = path.join(Truncate.DIR, `tool_zzother${Date.now()}`)
      const theirs = path.join(Truncate.DIR, "ses_zzother", "tool_zzother")
      const own = path.join(Truncate.DIR, mine.id, "tool_zzown")
      yield* Effect.promise(async () => {
        for (const file of [flat, theirs, own]) await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(flat, `KEY ${SECRET}\n`)
        await fs.writeFile(theirs, `KEY ${SECRET}\n`)
        await fs.writeFile(own, "OWN OUTPUT\n")
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          for (const file of [flat, theirs, own]) await fs.rm(file, { force: true })
        }),
      )
      for (const file of [flat, theirs]) {
        const read = yield* call(Permission.VERIFIER, "read", { filePath: file }, undefined, mine)
        expect([file, read.output + read.error]).not.toEqual([file, expect.stringContaining(SECRET)])
      }
      const glob = yield* call(Permission.VERIFIER, "glob", { pattern: "**/*", path: Truncate.DIR }, undefined, mine)
      expect(glob.output).not.toContain("zzother")
      const grep = yield* call(Permission.VERIFIER, "grep", { pattern: "KEY", path: Truncate.DIR }, undefined, mine)
      expect(grep.output).not.toContain(SECRET)
      const read = yield* call(Permission.VERIFIER, "read", { filePath: own }, undefined, mine)
      expect(read.output).toContain("OWN OUTPUT")
    }),
  )
})
