import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { ShellTasks } from "../../src/tool/shell/tasks"
import { Wait } from "../../src/tool/wait"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { testEffect } from "../lib/effect"

const layer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Truncate.node,
      Config.node,
      EventV2Bridge.node,
      SessionStatus.node,
      Session.node,
      SessionProjector.node,
      ShellTasks.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)

const sessionID = SessionID.make("ses_wait")
const messageID = MessageID.make("msg_wait")

const script = (code: string, args: string[] = []) =>
  ChildProcess.make(process.execPath, ["-e", code, ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    detached: process.platform !== "win32",
  })

/** Starts a task and promotes it to the background, the way a yielded shell call is. */
const background = (code: string, args: string[] = []) =>
  Effect.gen(function* () {
    const tasks = yield* ShellTasks.Service
    const handle = yield* tasks.start({
      command: script(code, args),
      display: "wait test",
      cwd: process.cwd(),
      sessionID,
      messageID,
      limits: { maxLines: 2000, maxBytes: 50 * 1024 },
      settings: { ...ShellTasks.DEFAULTS, yieldAfterMs: 100, sweepMs: 50 },
    })
    yield* handle.promote({})
    return handle.id
  })

const cleanly = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.ensuring(self, Effect.flatMap(ShellTasks.Service, (tasks) => tasks.stopAll()).pipe(Effect.ignore))

describe("wait: files", () => {
  test("returns as soon as a missing file appears, with its tail", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-wait-"))
    const file = path.join(dir, "done.txt")
    setTimeout(() => fs.writeFile(file, "one\ntwo\nthree\n"), 300)
    const started = Date.now()
    const result = await Effect.runPromise(Wait.waitForFile({ file, timeoutMs: 10_000, pollMs: 50 }))
    expect(result.condition).toBe("exists")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(Wait.tail(result.text, 2)).toBe("two\nthree")
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("matches only text written after the wait started", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-wait-"))
    const file = path.join(dir, "server.log")
    await fs.writeFile(file, "listening on 1\n")
    setTimeout(() => fs.appendFile(file, "compiling\nlistening on 2\n"), 300)
    const result = await Effect.runPromise(
      Wait.waitForFile({ file, pattern: /listening on \d/, timeoutMs: 10_000, pollMs: 50 }),
    )
    expect(result.condition).toBe("matched")
    expect(result.text).toContain("listening on 2")
    expect(result.text).not.toContain("listening on 1")
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("times out and says so", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-wait-"))
    const result = await Effect.runPromise(
      Wait.waitForFile({ file: path.join(dir, "never"), timeoutMs: 200, pollMs: 50 }),
    )
    expect(result.condition).toBe("timeout")
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("the tail is capped in bytes whatever the line count", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n")
    const out = Wait.tail(text, 200)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(Wait.MAX_TAIL_BYTES)
    expect(out.endsWith("line 499 " + "x".repeat(100))).toBe(true)
  })
})

describe("wait: background shell tasks", () => {
  it.instance(
    "blocks until the task exits and returns the exit code and output tail",
    () =>
      cleanly(
        Effect.gen(function* () {
          const tasks = yield* ShellTasks.Service
          const id = yield* background("setTimeout(() => { console.log('built ok'); process.exit(3) }, 800)")
          const result = yield* Wait.waitForTask({ tasks, sessionID, id, timeoutMs: 20_000, pollMs: 50 })
          expect(result.condition).toBe("exited")
          expect(result.info?.exitCode).toBe(3)
          expect(result.text).toContain("built ok")
        }),
      ),
    60_000,
  )

  it.instance(
    "a task the agent waited on does not also wake the session",
    () =>
      cleanly(
        Effect.gen(function* () {
          const tasks = yield* ShellTasks.Service
          const id = yield* background("setTimeout(() => console.log('done'), 500)")
          yield* Wait.waitForTask({ tasks, sessionID, id, timeoutMs: 20_000, pollMs: 50 })
          const info = yield* tasks.get(sessionID, id)
          expect(info?.wake).not.toBe("pending")
        }),
      ),
    60_000,
  )

  it.instance(
    "with a pattern, returns when the running task prints a match",
    () =>
      cleanly(
        Effect.gen(function* () {
          const tasks = yield* ShellTasks.Service
          const id = yield* background(
            "console.log('booting'); setTimeout(() => console.log('listening on 4096'), 600); setTimeout(() => {}, 30000)",
          )
          const result = yield* Wait.waitForTask({
            tasks,
            sessionID,
            id,
            pattern: /listening on \d+/,
            timeoutMs: 20_000,
            pollMs: 50,
          })
          expect(result.condition).toBe("matched")
          expect(result.info?.status).toBe("running")
          expect(result.text).toContain("listening on 4096")
        }),
      ),
    60_000,
  )

  it.instance(
    "times out on a task that keeps running",
    () =>
      cleanly(
        Effect.gen(function* () {
          const tasks = yield* ShellTasks.Service
          const id = yield* background("setTimeout(() => {}, 30000)")
          const result = yield* Wait.waitForTask({ tasks, sessionID, id, timeoutMs: 300, pollMs: 50 })
          expect(result.condition).toBe("timeout")
          expect(result.info?.status).toBe("running")
        }),
      ),
    60_000,
  )

  it.instance("an unknown task is reported, not waited on", () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      const result = yield* Wait.waitForTask({ tasks, sessionID, id: "shl_missing", timeoutMs: 10_000 })
      expect(result.condition).toBe("not_found")
    }),
  )
})

describe("wait: steering", () => {
  test("the description tells the model to use it instead of sleep-and-poll", () => {
    expect(Wait.DESCRIPTION).toContain("instead of polling")
    expect(Wait.DESCRIPTION).toContain("sleep")
  })
})
