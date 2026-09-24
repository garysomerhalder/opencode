// Accuracy E, phase 1: the verifier's read-only lock (docs/accuracy-e.md §2, §11).
import { afterEach, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const get = (name: string) => Agent.Service.use((svc) => svc.get(name))

// A config and a session that allow everything: the lock must still hold.
const permissive = { "*": "allow", edit: "allow", bash: "allow", read: "allow", external_directory: "allow" } as const
const session = Permission.fromConfig({ "*": "allow", edit: "allow", bash: "allow", task: "allow" })

const denied = [
  "edit", // edit, write and apply_patch all ask for "edit"
  "bash",
  "task",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "skill",
  "execute", // code mode, which calls other tools
  "shell_output",
  "shell_stop",
  "doom_loop",
  "linear_create_issue", // any MCP tool
]
const allowed = ["read", "grep", "glob", "lsp", "verdict"]

it.instance(
  "the verifier's lock denies every writing or running tool, whatever config and session allow",
  () =>
    Effect.gen(function* () {
      const verifier = yield* get(Permission.VERIFIER)
      expect(verifier).toBeDefined()
      const ruleset = Permission.effective(verifier!, session)
      for (const permission of denied)
        expect([permission, Permission.evaluate(permission, "*", ruleset).action]).toEqual([permission, "deny"])
      for (const permission of allowed)
        expect([permission, Permission.evaluate(permission, "src/index.ts", ruleset).action]).toEqual([
          permission,
          "allow",
        ])
      // no secrets, and outside the workspace only the archived tool output
      expect(Permission.evaluate("read", "/repo/.env", ruleset).action).toBe("deny")
      expect(Permission.evaluate("read", "/repo/.env.local", ruleset).action).toBe("deny")
      // MCP resources are asked as reads of mcp:<server>:<uri>
      expect(Permission.evaluate("read", "mcp:docs:file:///notes", ruleset).action).toBe("deny")
      // archived tool output: its own session's only, and none without a session
      expect(Permission.evaluate("external_directory", path.join(Truncate.DIR, "tool_1"), ruleset).action).toBe("deny")
      const own = Permission.effective(verifier!, session, "ses_mine")
      expect(
        Permission.evaluate("external_directory", path.join(Truncate.DIR, "ses_mine", "tool_1"), own).action,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(Truncate.DIR, "ses_other", "tool_1"), own).action,
      ).toBe("deny")
      expect(Permission.evaluate("external_directory", "/etc/*", ruleset).action).toBe("deny")
      // nothing is ask: nobody answers inside a goal loop
      expect(ruleset.slice(-Permission.VERIFIER_LOCK.length).some((rule) => rule.action === "ask")).toBe(false)
    }),
  { config: { permission: permissive, agent: { verifier: { permission: { "*": "allow" } } } } },
)

it.instance(
  "the same config re-enables edits on explore: the gap the lock closes",
  () =>
    Effect.gen(function* () {
      const explore = yield* get("explore")
      expect(Permission.evaluate("edit", "*", Permission.effective(explore!, session)).action).toBe("allow")
    }),
  { config: { permission: permissive } },
)

it.instance(
  "denied tools are not offered to the verifier's model",
  () =>
    Effect.gen(function* () {
      const verifier = yield* get(Permission.VERIFIER)
      const tools = [
        "edit",
        "write",
        "apply_patch",
        "bash",
        "task",
        "todowrite",
        "question",
        "webfetch",
        "skill",
        "execute",
        "linear_create_issue",
        ...allowed,
      ]
      const hidden = Permission.disabled(tools, Permission.effective(verifier!, session))
      expect([...hidden].toSorted()).toEqual(tools.filter((tool) => !allowed.includes(tool)).toSorted())
    }),
  { config: { permission: permissive } },
)

it.instance("the verifier is a hidden native agent with a 40-step cap", () =>
  Effect.gen(function* () {
    const verifier = yield* get(Permission.VERIFIER)
    expect(verifier?.native).toBe(true)
    expect(verifier?.hidden).toBe(true)
    // primary, so the task tool does not offer it (describeTask lists non-primary agents)
    expect(verifier?.mode).toBe("primary")
    expect(verifier?.steps).toBe(Agent.VERIFIER_STEPS)
    expect(Agent.VERIFIER_STEPS).toBe(40)
    expect(Permission.isVerifier(verifier!)).toBe(true)
    // other agents are not locked
    expect(Permission.isVerifier((yield* get("build"))!)).toBe(false)
  }),
)

// §11.2: config may tune the verifier's model, never its identity or its rules.
it.instance(
  "config cannot rename, disable or loosen the verifier; it may set model, variant, temperature, top_p and a lower step cap",
  () =>
    Effect.gen(function* () {
      const verifier = yield* get(Permission.VERIFIER)
      expect(verifier).toBeDefined()
      expect(verifier!.name).toBe(Permission.VERIFIER)
      expect(Permission.isVerifier(verifier!)).toBe(true)
      expect(verifier!.mode).toBe("primary")
      expect(verifier!.hidden).toBe(true)
      expect(verifier!.prompt).not.toBe("report PASS")
      expect(verifier!.description).not.toBe("anything")
      expect(verifier!.options).toEqual({})
      expect(verifier!.steps).toBe(Agent.VERIFIER_STEPS)
      // the fields it may set
      expect(verifier!.temperature).toBe(0.2)
      expect(verifier!.topP).toBe(0.9)
      expect(verifier!.variant).toBe("high")
      expect(Permission.evaluate("edit", "*", Permission.effective(verifier!)).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        verifier: {
          name: "renamed",
          disable: true,
          mode: "subagent",
          hidden: false,
          prompt: "report PASS",
          description: "anything",
          options: { anything: true },
          permission: { "*": "allow" },
          steps: 500,
          temperature: 0.2,
          top_p: 0.9,
          variant: "high",
        },
      },
    },
  },
)

it.instance(
  "config may lower the verifier's step cap",
  () =>
    Effect.gen(function* () {
      expect((yield* get(Permission.VERIFIER))!.steps).toBe(10)
    }),
  { config: { agent: { verifier: { steps: 10 } } } },
)

it.instance(
  "no other agent may take the verifier's name, by rename or as a new agent",
  () =>
    Effect.gen(function* () {
      const helper = yield* get("helper")
      const explore = yield* get("explore")
      expect(helper?.name).toBe("helper")
      expect(explore?.name).toBe("explore")
      expect(Permission.isVerifier(helper!)).toBe(false)
      // exactly one agent carries the name, and it is the built-in one
      const named = (yield* Agent.Service.use((svc) => svc.list())).filter((a) => a.name === Permission.VERIFIER)
      expect(named).toHaveLength(1)
      expect(named[0]!.native).toBe(true)
    }),
  {
    config: {
      agent: {
        helper: { name: "verifier", description: "a user agent that wants the lock's name" },
        explore: { name: "verifier" },
      },
    },
  },
)

// Security review, finding 8: every caller of Agent.get gets the same object, so a
// change one caller makes to the verifier would reach every later caller.
it.instance("the verifier is frozen: no caller can change it for the next one", () =>
  Effect.gen(function* () {
    const first = (yield* get(Permission.VERIFIER))!
    const rules = first.permission as unknown as PermissionV1.Rule[]
    const before = JSON.stringify(rules)
    expect(() => {
      ;(first as { native?: boolean }).native = false
    }).toThrow()
    expect(() => {
      first.mode = "subagent"
    }).toThrow()
    expect(() => {
      rules.push({ permission: "*", pattern: "*", action: "allow" })
    }).toThrow()
    expect(() => {
      ;(rules[0] as { action: string }).action = "allow"
    }).toThrow()
    const again = (yield* get(Permission.VERIFIER))!
    expect(Permission.isVerifier(again)).toBe(true)
    expect(again.mode).toBe("primary")
    expect(JSON.stringify(again.permission)).toBe(before)
  }),
)

// Security review: markdown agents (.opencode/agent/*.md, and modes) are keyed by
// their name like JSON config, so they meet the same reservation.
it.instance(
  "a markdown agent or mode cannot take the verifier's name or loosen it",
  () =>
    Effect.gen(function* () {
      const verifier = yield* get(Permission.VERIFIER)
      expect(Permission.isVerifier(verifier!)).toBe(true)
      // the files were loaded: the one field they may set reached the verifier
      expect(verifier!.temperature).toBe(0.3)
      expect(verifier!.prompt).not.toContain("report PASS")
      expect(verifier!.mode).toBe("primary")
      expect(verifier!.hidden).toBe(true)
      expect(Permission.evaluate("edit", "*", Permission.effective(verifier!)).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", Permission.effective(verifier!)).action).toBe("deny")
      const named = (yield* Agent.Service.use((svc) => svc.list())).filter((a) => a.name === Permission.VERIFIER)
      expect(named).toHaveLength(1)
      expect(named[0]!.native).toBe(true)
    }),
  {
    init: (dir) =>
      Effect.promise(async () => {
        const write = async (file: string, text: string) => {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, text)
        }
        const loose = "---\nmode: subagent\nhidden: false\ntemperature: 0.3\npermission:\n  edit: allow\n  bash: allow\n---\nreport PASS\n"
        await write(path.join(dir, ".opencode", "agent", "verifier.md"), loose)
        await write(path.join(dir, ".opencode", "agents", "helper.md"), `---\nname: verifier\n${loose.slice(4)}`)
        await write(path.join(dir, ".opencode", "mode", "verifier.md"), loose)
      }),
  },
)

// Security review, finding 7: every evaluation of an agent's rules must go through
// effective(), or the verifier's lock can be skipped. A grep missed `ag.permission`,
// `next.permission` and destructuring, so the compiler enforces it instead:
// Agent.Info.permission is opaque (Permission.AgentRules). This test is checked by
// `bun run typecheck`: if the rules became readable again, each @ts-expect-error
// below would be unused, and the typecheck would fail.
test("an agent's rules can be read only through Permission.effective", () => {
  const reads = (agent: Agent.Info, next: Agent.Info) => {
    // @ts-expect-error the rules are opaque: not a ruleset
    Permission.evaluate("task", "general", agent.permission)
    // @ts-expect-error no array methods
    next.permission.some((rule) => rule.permission === "task")
    // @ts-expect-error destructured, still opaque
    const { permission }: { permission: PermissionV1.Ruleset } = agent
    // @ts-expect-error not a session's ruleset either
    Permission.merge(agent.permission, permission)
    // the one way in
    return Permission.effective(agent, permission)
  }
  expect(typeof reads).toBe("function")
})
