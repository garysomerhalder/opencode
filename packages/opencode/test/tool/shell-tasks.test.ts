import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import fs from "fs/promises"
import path from "path"
import { Config } from "@/config/config"
import { ShellTasks } from "../../src/tool/shell/tasks"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"
import type { WakeOps } from "../../src/tool/wake"

const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Truncate.node,
      Config.node,
      EventV2Bridge.node,
      SessionStatus.node,
      ShellTasks.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)

const sessionID = SessionID.make("ses_tasks")
const messageID = MessageID.make("msg_tasks")
const limits = { maxLines: 2000, maxBytes: 50 * 1024 }

const settings = (overrides: Partial<ShellTasks.Settings> = {}): ShellTasks.Settings => ({
  ...ShellTasks.DEFAULTS,
  yieldAfterMs: 200,
  sweepMs: 50,
  ...overrides,
})

/** Runs a script with the current runtime, the way the shell tool spawns a shell. */
const script = (code: string, args: string[] = [], cwd = process.cwd()) =>
  ChildProcess.make(process.execPath, ["-e", code, ...args], {
    cwd,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })

const start = (input: {
  code: string
  args?: string[]
  cwd?: string
  settings?: Partial<ShellTasks.Settings>
  session?: SessionID
}) =>
  Effect.gen(function* () {
    const tasks = yield* ShellTasks.Service
    return yield* tasks.start({
      command: script(input.code, input.args ?? [], input.cwd ?? process.cwd()),
      display: "test command",
      cwd: input.cwd ?? process.cwd(),
      sessionID: input.session ?? sessionID,
      messageID,
      limits,
      settings: settings(input.settings),
    })
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = <A>(self: Effect.Effect<A>, predicate: (value: A) => boolean, timeoutMs = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = yield* self
      if (predicate(value)) return value
      yield* Effect.sleep("25 millis")
    }
    return yield* self
  })

const recorder = () => {
  const prompts: { text: string; noReply: boolean }[] = []
  const loops: string[] = []
  const ops: WakeOps = {
    prompt: (input) =>
      Effect.sync(() => {
        prompts.push({
          text: input.parts.map((part) => part.text).join(""),
          noReply: input.noReply === true,
        })
        return { info: { id: "msg_wake", role: "user" }, parts: [] } as unknown as SessionV1.WithParts
      }),
    loop: (id) =>
      Effect.sync(() => {
        loops.push(id)
        return {
          info: { id: "msg_reply", role: "assistant", parentID: "msg_wake" },
          parts: [],
        } as unknown as SessionV1.WithParts
      }),
  }
  return { prompts, loops, ops }
}

it.instance(
  "keeps the same process running after it is promoted, and reads its output incrementally",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      const handle = yield* start({
        code: "require('fs').writeSync(1, 'one\\n'); setTimeout(() => { require('fs').writeSync(1, 'two\\n') }, 700)",
      })
      const first = yield* waitFor(
        tasks.read(sessionID, handle.id, { offset: 0 }).pipe(Effect.map((value) => value?.text ?? "")),
        (text) => text.includes("one"),
      )
      expect(first).toContain("one")

      const promoted = yield* handle.promote({})
      expect(promoted?.background).toBe(true)
      expect(promoted?.status).toBe("running")
      const pid = promoted?.pid
      expect(typeof pid).toBe("number")
      expect(alive(pid!)).toBe(true)

      const exited = yield* handle.awaitExit
      expect(exited.status).toBe("exited")
      expect(exited.exitCode).toBe(0)
      expect(exited.pid).toBe(pid)

      // The cursor continues where the previous read stopped.
      const next = yield* tasks.read(sessionID, handle.id)
      expect(next?.text).toContain("two")
      expect(next?.text).not.toContain("one")
      const all = yield* tasks.read(sessionID, handle.id, { offset: 0 })
      expect(all?.text).toContain("one")
      expect(all?.text).toContain("two")
      expect(all?.info.file).toBeTruthy()
      expect(yield* Effect.promise(() => fs.readFile(all!.info.file!, "utf-8"))).toContain("two")
    }),
  30_000,
)

it.instance(
  "wakes the session once when a task finishes, and answers the message it appended",
  () =>
    Effect.gen(function* () {
      const wake = recorder()
      const handle = yield* start({ code: "require('fs').writeSync(1, 'done\\n')" })
      yield* handle.promote({ wake: wake.ops, agent: "build" })
      yield* handle.awaitExit
      yield* Effect.sleep("900 millis")
      expect(wake.prompts.length).toBe(1)
      expect(wake.prompts[0].noReply).toBe(true)
      expect(wake.prompts[0].text).toContain("<background-shell-finished>")
      expect(wake.prompts[0].text).toContain('status="exited"')
      expect(wake.prompts[0].text).toContain('exit_code="0"')
      expect(wake.prompts[0].text).toContain("done")
      expect(wake.loops).toEqual([sessionID])
    }),
  30_000,
)

it.instance(
  "does not wake the session for a task that was stopped or already observed",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      const stopped = recorder()
      const stopping = yield* start({ code: "setInterval(() => {}, 1000)" })
      yield* stopping.promote({ wake: stopped.ops })
      yield* tasks.stop(sessionID, stopping.id)
      yield* Effect.sleep("900 millis")
      expect(stopped.prompts.length).toBe(0)

      const observed = recorder()
      const quick = yield* start({ code: "require('fs').writeSync(1, 'hi\\n')" })
      yield* quick.promote({ wake: observed.ops })
      yield* quick.awaitExit
      // Reading the finished task before the batch fires means the agent has
      // already seen the result, so there is nothing to wake it for.
      yield* tasks.read(sessionID, quick.id, { offset: 0 })
      yield* Effect.sleep("900 millis")
      expect(observed.prompts.length).toBe(0)
    }),
  30_000,
)

it.instance(
  "stopping a task kills its process tree and leaves other processes alone",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const pidFile = path.join(dir, "pids.json")
      const tasks = yield* ShellTasks.Service
      const handle = yield* start({
        code: [
          "const cp = require('child_process')",
          "const fs = require('fs')",
          "const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
          "fs.writeFileSync(process.argv[1] ?? Bun.argv[1], JSON.stringify({ parent: process.pid, child: child.pid }))",
          "setInterval(() => {}, 1000)",
        ].join("; "),
        args: [pidFile],
        cwd: dir,
      })
      yield* handle.promote({})

      const other = yield* start({ code: "setInterval(() => {}, 1000)" })
      yield* other.promote({})

      const pids = yield* waitFor(
        Effect.promise(() =>
          fs
            .readFile(pidFile, "utf-8")
            .then((text) => JSON.parse(text) as { parent: number; child: number })
            .catch(() => undefined),
        ),
        (value) => value !== undefined,
      )
      expect(pids).toBeTruthy()
      expect(alive(pids!.parent)).toBe(true)
      expect(alive(pids!.child)).toBe(true)

      const stopped = yield* tasks.stop(sessionID, handle.id)
      expect(stopped?.status).toBe("stopped")
      yield* waitFor(Effect.sync(() => alive(pids!.parent) || alive(pids!.child)), (any) => any === false)
      expect(alive(pids!.parent)).toBe(false)
      expect(alive(pids!.child)).toBe(false)

      const survivor = yield* handle.info.pipe(Effect.andThen(other.info))
      expect(survivor.status).toBe("running")
      expect(alive(survivor.pid!)).toBe(true)
      yield* tasks.stop(sessionID, other.id)
    }),
  40_000,
)

it.instance(
  "refuses to promote past the concurrency cap",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      const first = yield* start({ code: "setInterval(() => {}, 1000)", settings: { maxConcurrent: 1 } })
      expect(yield* first.promote({})).toBeTruthy()
      const second = yield* start({ code: "setInterval(() => {}, 1000)", settings: { maxConcurrent: 1 } })
      expect(yield* second.promote({})).toBeUndefined()
      expect((yield* tasks.running(sessionID)).length).toBe(1)
      yield* tasks.stop(sessionID, first.id)
      yield* second.kill("stopped", "stopped")
    }),
  40_000,
)

it.instance(
  "terminates a task at the lifetime cap and wakes the session",
  () =>
    Effect.gen(function* () {
      const wake = recorder()
      const handle = yield* start({ code: "setInterval(() => {}, 1000)", settings: { maxLifetimeMs: 500 } })
      yield* handle.promote({ wake: wake.ops })
      const info = yield* handle.awaitExit
      expect(info.status).toBe("timed_out")
      expect(info.reason).toBe("lifetime")
      expect(alive(info.pid!)).toBe(false)
      yield* Effect.sleep("900 millis")
      expect(wake.prompts.length).toBe(1)
      expect(wake.prompts[0].text).toContain('status="timed_out"')
    }),
  40_000,
)

it.instance(
  "reaps a task whose session has been idle with nobody reading it, without waking it",
  () =>
    Effect.gen(function* () {
      const wake = recorder()
      const handle = yield* start({
        code: "setInterval(() => {}, 1000)",
        settings: { idleReapMs: 300, sweepMs: 50 },
      })
      yield* handle.promote({ wake: wake.ops })
      const info = yield* handle.awaitExit
      expect(info.status).toBe("timed_out")
      expect(info.reason).toBe("idle")
      yield* Effect.sleep("900 millis")
      expect(wake.prompts.length).toBe(0)
    }),
  40_000,
)

it.instance(
  "caps the captured output file",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      const handle = yield* start({
        code: "require('fs').writeSync(1, 'x'.repeat(4000)); require('fs').writeSync(1, 'END')",
        settings: { maxOutputBytes: 1024 },
      })
      yield* handle.promote({})
      const info = yield* handle.awaitExit
      expect(info.outputCapped).toBe(true)
      expect(info.fileBytes).toBeLessThanOrEqual(1024)
      expect(info.bytes).toBeGreaterThan(1024)
      const read = yield* tasks.read(sessionID, handle.id, { offset: 0 })
      expect(read?.text.length).toBeGreaterThan(0)
    }),
  30_000,
)

it.instance(
  "kills a session's tasks when the session is deleted, and hides them from other sessions",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      const events = yield* EventV2Bridge.Service
      const handle = yield* start({ code: "setInterval(() => {}, 1000)" })
      yield* handle.promote({})
      expect(yield* tasks.get(SessionID.make("ses_other"), handle.id)).toBeUndefined()
      expect((yield* tasks.list(SessionID.make("ses_other"))).length).toBe(0)

      yield* events.publish(SessionV1.Event.Deleted, {
        sessionID,
        info: {
          id: sessionID,
          slug: "tasks-test",
          projectID: ProjectV2.ID.make("prj_tasks_test"),
          directory: (yield* TestInstance).directory,
          title: "tasks test",
          version: "0.0.0",
          time: { created: 1, updated: 1 },
        },
      })
      const info = yield* handle.awaitExit
      expect(info.status).toBe("cancelled")
      expect(info.reason).toBe("session")
      expect(alive(info.pid!)).toBe(false)
    }),
  40_000,
)
