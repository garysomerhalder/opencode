// Accuracy E, phase 1: the verifier's read-only lock (docs/accuracy-e.md §2, §11).
import { afterEach, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import path from "path"
import { readdirSync, readFileSync, statSync } from "fs"
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
      expect(Permission.evaluate("external_directory", path.join(Truncate.DIR, "tool_1"), ruleset).action).toBe("allow")
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

test("an agent's rules are only read through Permission.effective", () => {
  // Every evaluation of an agent's rules must go through effective(), or the
  // verifier's lock can be skipped. These files may read agent.permission:
  const allowed = new Set([
    "permission/index.ts", // effective() itself
    "agent/agent.ts", // where the rules are built
    "agent/subagent-permissions.ts", // derives a child session's rules; evaluation happens through effective()
    "cli/cmd/agent.ts", // prints them
  ])
  const root = path.join(import.meta.dir, "../../src")
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return files(full)
      return /\.tsx?$/.test(name) ? [full] : []
    })
  const offenders = files(root).flatMap((file) => {
    const rel = path.relative(root, file).split(path.sep).join("/")
    if (allowed.has(rel)) return []
    return readFileSync(file, "utf-8")
      .split("\n")
      .flatMap((line, index) => (/[A-Za-z]*[aA]gent\??\.permission\b/.test(line) ? [`${rel}:${index + 1}`] : []))
  })
  expect(offenders).toEqual([])
})
