import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { ShellTasks } from "../../src/tool/shell/tasks"
import { ShellOutputTool, ShellStopTool } from "../../src/tool/shell/tools"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { WakeOps } from "../../src/tool/wake"

const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      EventV2Bridge.node,
      SessionStatus.node,
      ShellTasks.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)

const sessionID = SessionID.make("ses_bg")

const wakes = () => {
  const prompts: string[] = []
  const ops: WakeOps = {
    prompt: (input) =>
      Effect.sync(() => {
        prompts.push(input.parts.map((part) => part.text).join(""))
        return { info: { id: "msg_wake", role: "user" }, parts: [] } as unknown as SessionV1.WithParts
      }),
    loop: () =>
      Effect.sync(
        () =>
          ({
            info: { id: "msg_reply", role: "assistant", parentID: "msg_wake" },
            parts: [],
          }) as unknown as SessionV1.WithParts,
      ),
  }
  return { prompts, ops }
}

const context = (input: { abort?: AbortSignal; ops?: WakeOps } = {}): Tool.Context => ({
  sessionID,
  messageID: MessageID.make("msg_bg"),
  callID: "call_bg",
  agent: "build",
  abort: input.abort ?? AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  ...(input.ops ? { extra: { promptOps: input.ops } } : {}),
})

const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const bin = quote(process.execPath.replaceAll("\\", "/"))
const PS = new Set(["pwsh", "powershell"])
const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

/** A command line that runs `code` with the current runtime in whichever shell is active. */
const run = (code: string, args: string[] = []) => {
  const text = [`${bin} -e ${evalarg(code)}`, ...args].join(" ")
  if (PS.has(sh())) return `& ${text}`
  return text
}

/**
 * A command that prints each word on its own line, optionally prints more words
 * after a delay, and optionally keeps running. The words travel as arguments so
 * the generated code carries no quotes of its own, which every shell here
 * would quote differently.
 */
const say = (words: string[], options: { later?: string[]; delayMs?: number; holdMs?: number } = {}) => {
  const later = options.later ?? []
  const write = (index: number) => `Bun.write(Bun.stdout, Bun.argv[${index}] + String.fromCharCode(10))`
  const code = [
    ...words.map((_, index) => write(index + 1)),
    ...(later.length > 0
      ? [`setTimeout(() => { ${later.map((_, index) => write(words.length + index + 1)).join("; ")} }, ${options.delayMs ?? 1000})`]
      : []),
    ...(options.holdMs ? [`setTimeout(() => {}, ${options.holdMs})`] : []),
  ].join("; ")
  return run(code, [...words, ...later])
}

const shell = () => Effect.flatMap(ShellTool, (tool) => tool.init())
const output = () => Effect.flatMap(ShellOutputTool, (tool) => tool.init())
const stop = () => Effect.flatMap(ShellStopTool, (tool) => tool.init())

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Leaving a background process alive holds the temp instance directory open on
 * Windows, so every test hands its tasks back before the fixture is cleaned up.
 */
const cleanly = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.ensuring(
    self,
    Effect.flatMap(ShellTasks.Service, (tasks) => tasks.stopAll()).pipe(Effect.ignore),
  )

const settle = (overrides: Record<string, unknown> = {}) => ({
  config: { experimental: { background_shell: { yield_after_ms: 2_000, sweep_ms: 100, ...overrides } } },
})

const taskId = (text: string) => text.match(/task_id="([^"]+)"/)?.[1]

it.instance(
  "yields a long command to a background task and keeps the same process running",
  () =>
    cleanly(
      Effect.gen(function* () {
        const wake = wakes()
        const tasks = yield* ShellTasks.Service
        const tool = yield* shell()
        const result = yield* tool.execute(
          {
            command: say(["early"], { later: ["late"], delayMs: 3000 }),
          },
          context({ ops: wake.ops }),
        )

        expect(result.output).toContain("<shell_background")
        expect(result.output).toContain("moved to a background task")
        expect(result.output).toContain("Output so far")
        expect(result.metadata.exit).toBeNull()
        const id = taskId(result.output)
        expect(id).toBeTruthy()

        const started = yield* tasks.get(sessionID, id!)
        expect(started?.status).toBe("running")
        expect(alive(started!.pid!)).toBe(true)

        // No reads: the agent is meant to be told on its own that this finished.
        const exited = yield* waitForStatus(id!, "exited")
        expect(exited?.exitCode).toBe(0)
        // The same process produced the rest of its output: it was not restarted.
        expect(exited?.pid).toBe(started?.pid)

        yield* Effect.sleep("1500 millis")
        expect(wake.prompts.length).toBe(1)
        expect(wake.prompts[0]).toContain("<background-shell-finished>")
        expect(wake.prompts[0]).toContain('exit_code="0"')
        expect(wake.prompts[0]).toContain("early")
        expect(wake.prompts[0]).toContain("late")

        const reader = yield* output()
        const full = yield* reader.execute({ task_id: id!, since: 0 }, context())
        expect(full.output).toContain("early")
        expect(full.output).toContain("late")
        expect(full.output).toContain("status=exited")
      }),
    ),
  settle(),
  90_000,
)

const waitForStatus = (id: string, status: ShellTasks.Status, timeoutMs = 30_000) =>
  Effect.gen(function* () {
    const tasks = yield* ShellTasks.Service
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const info = yield* tasks.get(sessionID, id)
      if (info?.status === status) return info
      yield* Effect.sleep("50 millis")
    }
    return yield* tasks.get(sessionID, id)
  })

it.instance(
  "does not wake the session when the agent already read the finished task",
  () =>
    cleanly(
      Effect.gen(function* () {
        const wake = wakes()
        const tool = yield* shell()
        const reader = yield* output()
        const result = yield* tool.execute(
          { command: say(["quick"], { holdMs: 2500 }), background: true },
          context({ ops: wake.ops }),
        )
        const id = taskId(result.output)!
        const finished = yield* reader.execute({ task_id: id, since: 0, wait_ms: 20_000 }, context())
        expect(finished.output).toContain("quick")
        yield* waitForStatus(id, "exited")
        yield* reader.execute({ task_id: id }, context())
        yield* Effect.sleep("1500 millis")
        expect(wake.prompts.length).toBe(0)
      }),
    ),
  settle(),
  90_000,
)

it.instance(
  "reads incrementally, lists tasks, warns about repeated empty reads, and stops on request",
  () =>
    cleanly(
      Effect.gen(function* () {
        const tool = yield* shell()
        const reader = yield* output()
        const stopper = yield* stop()
        const result = yield* tool.execute(
          { command: say(["first"], { holdMs: 600000 }), background: true },
          context(),
        )
        expect(result.output).toContain("Started in the background")
        const id = taskId(result.output)!

        const first = yield* reader.execute({ task_id: id, since: 0, wait_ms: 20_000 }, context())
        expect(first.output).toContain("first")
        expect(first.output).toContain("next_offset=")

        const second = yield* reader.execute({ task_id: id }, context())
        expect(second.output).toContain("(no new output)")
        const third = yield* reader.execute({ task_id: id }, context())
        const fourth = yield* reader.execute({ task_id: id }, context())
        expect(third.output + fourth.output).toContain("Stop polling")

        const list = yield* reader.execute({}, context())
        expect(list.output).toContain(id)
        expect(list.output).toContain("status=running")

        const missing = yield* reader.execute({ task_id: "shl_nope" }, context())
        expect(missing.output).toContain("No background shell task")

        const stopped = yield* stopper.execute({ task_id: id }, context())
        expect(stopped.output).toContain("killed its process tree")
        expect(stopped.metadata.status).toBe("stopped")
      }),
    ),
  settle(),
  90_000,
)

it.instance(
  "keeps a background task running when the turn is aborted",
  () =>
    cleanly(
      Effect.gen(function* () {
        const tasks = yield* ShellTasks.Service
        const controller = new AbortController()
        const tool = yield* shell()
        const result = yield* tool.execute(
          { command: say([], { holdMs: 600000 }), background: true },
          context({ abort: controller.signal }),
        )
        const id = taskId(result.output)!
        controller.abort()
        yield* Effect.sleep("2 seconds")
        const info = yield* tasks.get(sessionID, id)
        expect(info?.status).toBe("running")
        expect(alive(info!.pid!)).toBe(true)
      }),
    ),
  settle(),
  90_000,
)

it.instance(
  "kills a foreground command when the turn is aborted before it yields",
  () =>
    cleanly(
      Effect.gen(function* () {
        const controller = new AbortController()
        const tool = yield* shell()
        const running = yield* Effect.forkIn(
          tool.execute({ command: say([], { holdMs: 600000 }) }, context({ abort: controller.signal })),
          yield* Scope.Scope,
        )
        yield* Effect.sleep("1 seconds")
        controller.abort()
        const result = yield* Fiber.await(running)
        expect(Exit.isSuccess(result) ? result.value.output : "").toContain("User aborted the command")
      }),
    ),
  { config: { experimental: { background_shell: { yield_after_ms: 60_000 } } } },
  90_000,
)

it.instance(
  "still terminates a command that sets an explicit timeout",
  () =>
    cleanly(
      Effect.gen(function* () {
        const tool = yield* shell()
        const result = yield* tool.execute({ command: say([], { holdMs: 600000 }), timeout: 500 }, context())
        expect(result.output).toContain("shell tool terminated command after exceeding timeout 500 ms")
        expect(result.output).toContain("retry with a larger timeout value in milliseconds")
      }),
    ),
  settle(),
  90_000,
)

it.instance(
  "falls back to foreground behavior when the concurrency cap is full",
  () =>
    cleanly(
      Effect.gen(function* () {
        const tasks = yield* ShellTasks.Service
        const tool = yield* shell()
        yield* tool.execute({ command: say([], { holdMs: 600000 }), background: true }, context())
        const second = yield* tool.execute({ command: say([], { holdMs: 600000 }), timeout: 5_000 }, context())
        expect(second.output).toContain("background shell tasks are already running")
        expect(second.output).toContain("shell tool terminated command after exceeding timeout")
        expect((yield* tasks.running(sessionID)).length).toBe(1)
      }),
    ),
  settle({ max_concurrent: 1 }),
  90_000,
)

it.instance(
  "refuses an explicit background request at the cap instead of holding the command",
  () =>
    cleanly(
      Effect.gen(function* () {
        const tasks = yield* ShellTasks.Service
        const tool = yield* shell()
        yield* tool.execute({ command: say([], { holdMs: 600000 }), background: true }, context())
        const started = Date.now()
        const second = yield* tool.execute({ command: say([], { holdMs: 600000 }), background: true }, context())
        // No foreground fallback: an explicit background request is answered now.
        expect(Date.now() - started).toBeLessThan(20_000)
        expect(second.output).toContain("did not start this command in the background")
        expect(second.output).toContain("background shell tasks are already running")
        expect((yield* tasks.running(sessionID)).length).toBe(1)
      }),
    ),
  settle({ max_concurrent: 1 }),
  90_000,
)

it.instance(
  "is off unless the config turns it on",
  () =>
    Effect.gen(function* () {
      const tool = yield* shell()
      expect(tool.description).not.toContain("# Long commands")
      const result = yield* tool.execute({ command: say(["plain"]) }, context())
      expect(result.output.trim()).toBe("plain")
    }),
  // No background_shell key at all: the default.
  {},
  90_000,
)

it.instance(
  "leaves short commands exactly as they were",
  () =>
    cleanly(
      Effect.gen(function* () {
        const tool = yield* shell()
        const result = yield* tool.execute({ command: say(["hello"]) }, context())
        expect(result.output.trim()).toBe("hello")
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.truncated).toBe(false)
        expect(result.output).not.toContain("shell_background")
        expect(tool.description).toContain("# Long commands")
      }),
    ),
  // A generous yield threshold: a loaded machine can take seconds just to start
  // the child, and this test is about the result of a command that does finish.
  settle({ yield_after_ms: 60_000 }),
  90_000,
)

it.instance(
  "behaves like the old shell tool when background tasks are disabled",
  () =>
    Effect.gen(function* () {
      const tool = yield* shell()
      const result = yield* tool.execute({ command: say(["hello"]) }, context())
      expect(result.output.trim()).toBe("hello")
      expect(result.metadata.exit).toBe(0)
      expect(tool.description).not.toContain("# Long commands")
      const timed = yield* tool.execute({ command: say([], { holdMs: 600000 }), timeout: 2_000 }, context())
      expect(timed.output).toContain("shell tool terminated command after exceeding timeout 2000 ms")
    }),
  { config: { experimental: { background_shell: false } } },
  90_000,
)
