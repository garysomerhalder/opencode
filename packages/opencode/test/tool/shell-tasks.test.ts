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
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session } from "@/session/session"
import { HarnessNote } from "@/session/harness-note"
import { SessionProjector } from "@opencode-ai/core/session/projector"
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
      Session.node,
      SessionProjector.node,
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

/**
 * Only the session loop is stubbed here; the note itself is written through the
 * real Session service and read back from the session, so these assertions are
 * about persisted state rather than about a fake. `unanswered` makes the first
 * N loops return an assistant that answers some earlier message, which is
 * exactly the case the wake retry exists for.
 */
const recorder = (sessions: Session.Interface, options: { unanswered?: number } = {}) => {
  const loops: string[] = []
  let unanswered = options.unanswered ?? 0
  const ops: WakeOps = {
    loop: (id) =>
      Effect.gen(function* () {
        loops.push(id)
        const messages = yield* sessions
          .messages({ sessionID: SessionID.make(id) })
          .pipe(Effect.catchCause(() => Effect.succeed([])))
        const newest = messages.filter((message) => HarnessNote.isNote(message)).at(-1)
        const parentID = unanswered-- > 0 ? "msg_older" : newest?.info.id
        return {
          info: { id: "msg_reply", role: "assistant", parentID },
          parts: [],
        } as unknown as SessionV1.WithParts
      }),
  }
  return { loops, ops }
}

/** The harness notes a session has accumulated, newest last. */
const notes = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID }).pipe(Effect.catchCause(() => Effect.succeed([])))
    return messages
      .filter((message) => HarnessNote.isNote(message))
      .map((message) => ({
        id: message.info.id,
        agent: message.info.role === "user" ? message.info.agent : undefined,
        model: message.info.role === "user" ? message.info.model : undefined,
        kind: HarnessNote.kind(message.parts),
        text: message.parts
          .filter((part) => part.type === "reminder")
          .map((part) => (part.type === "reminder" ? part.text : ""))
          .join(""),
      }))
  })

/** A session with one real user message for a note to copy. */
const seedSession = (input: { agent?: string; variant?: string } = {}) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "wake target", ...(input.agent ? { agent: input.agent } : {}) })
    const user: SessionV1.User = {
      id: MessageID.ascending(),
      role: "user",
      sessionID: session.id,
      time: { created: Date.now() },
      agent: input.agent ?? "build",
      model: {
        providerID: ProviderV2.ID.make("some-provider"),
        modelID: ModelV2.ID.make("some-model"),
        ...(input.variant ? { variant: input.variant } : {}),
      },
    }
    yield* sessions.updateMessage(user)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID: session.id,
      type: "text",
      text: "run the build",
      time: { start: Date.now(), end: Date.now() },
    })
    return session
  })

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
  "appends one harness note when a task finishes, and answers it",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const wake = recorder(sessions)
      const session = yield* seedSession()
      const handle = yield* start({ code: "require('fs').writeSync(1, 'done\\n')", session: session.id })
      yield* handle.promote({ wake: wake.ops })
      yield* handle.awaitExit
      yield* Effect.sleep("900 millis")
      const written = yield* notes(session.id)
      expect(written.length).toBe(1)
      expect(written[0].kind).toBe("background_shell")
      expect(written[0].text).toContain("<background-shell-finished>")
      expect(written[0].text).toContain('status="exited"')
      expect(written[0].text).toContain('exit_code="0"')
      expect(written[0].text).toContain("done")
      expect(wake.loops).toEqual([session.id])
    }),
  30_000,
)

it.instance(
  "runs the session loop again when the note went unanswered",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const wake = recorder(sessions, { unanswered: 1 })
      const session = yield* seedSession()
      const handle = yield* start({ code: "require('fs').writeSync(1, 'retry\\n')", session: session.id })
      yield* handle.promote({ wake: wake.ops })
      yield* handle.awaitExit
      yield* Effect.sleep("900 millis")
      expect((yield* notes(session.id)).length).toBe(1)
      // The first run answered an older message, so the wake ran the loop again.
      expect(wake.loops).toEqual([session.id, session.id])
    }),
  30_000,
)

it.instance(
  "gives up after three attempts instead of looping forever",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const wake = recorder(sessions, { unanswered: 99 })
      const session = yield* seedSession()
      const handle = yield* start({ code: "require('fs').writeSync(1, 'nope\\n')", session: session.id })
      yield* handle.promote({ wake: wake.ops })
      yield* handle.awaitExit
      yield* Effect.sleep("900 millis")
      expect(wake.loops.length).toBe(3)
    }),
  30_000,
)

it.instance(
  "carries the session's agent, model and variant onto the note, and changes neither",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const wake = recorder(sessions)
      const session = yield* seedSession({ agent: "plan", variant: "thinking" })
      const before = yield* sessions.get(session.id)
      const handle = yield* start({ code: "require('fs').writeSync(1, 'switched\\n')", session: session.id })
      yield* handle.promote({ wake: wake.ops })
      yield* handle.awaitExit
      yield* Effect.sleep("900 millis")
      const written = yield* notes(session.id)
      expect(written.length).toBe(1)
      expect(written[0].agent).toBe("plan")
      expect(String(written[0].model?.providerID)).toBe("some-provider")
      expect(String(written[0].model?.modelID)).toBe("some-model")
      expect(written[0].model?.variant).toBe("thinking")
      // Appending a note writes nothing to the session row, so the agent and
      // model the user is on cannot be moved by a message they did not send.
      const after = yield* sessions.get(session.id)
      expect(after.agent).toBe(before.agent)
      expect(after.model).toEqual(before.model)
    }),
  30_000,
)

it.instance(
  "reports a command that could not be started as an error, not an empty run",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      // A working directory that does not exist fails at spawn on every
      // platform, where a missing binary may be resolved by a shell first.
      const missing = path.join((yield* TestInstance).directory, "no-such-directory")
      const handle = yield* tasks.start({
        command: ChildProcess.make(process.execPath, ["-e", "0"], { cwd: missing, stdin: "ignore" }),
        display: "bad working directory",
        cwd: missing,
        sessionID,
        messageID,
        limits,
        settings: settings(),
      })
      const info = yield* handle.awaitExit
      expect(info.error).toBeTruthy()
      expect(info.exitCode).toBeNull()
    }),
  30_000,
)

it.instance(
  "does not wake the session for a task that was stopped or already observed",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      const sessions = yield* Session.Service
      const session = yield* seedSession()
      const stopped = recorder(sessions)
      const stopping = yield* start({ code: "setInterval(() => {}, 1000)", session: session.id })
      yield* stopping.promote({ wake: stopped.ops })
      yield* tasks.stop(session.id, stopping.id)
      yield* Effect.sleep("900 millis")
      expect((yield* notes(session.id)).length).toBe(0)

      const observed = recorder(sessions)
      const quick = yield* start({
        code: "setTimeout(() => require('fs').writeSync(1, 'hi\\n'), 400)",
        session: session.id,
      })
      yield* quick.promote({ wake: observed.ops })
      // A read that is already waiting when the task ends sees the terminal
      // state first, so the agent has the result and there is nothing to wake
      // it for. Waiting first also keeps this off the batch timer's heels.
      yield* tasks.read(session.id, quick.id, { offset: 0, waitMs: 20_000 })
      const read = yield* tasks.read(session.id, quick.id, { waitMs: 20_000 })
      expect(read?.info.status).toBe("exited")
      yield* Effect.sleep("900 millis")
      expect((yield* notes(session.id)).length).toBe(0)
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
      yield* waitFor(
        Effect.sync(() => alive(pids!.parent) || alive(pids!.child)),
        (any) => any === false,
      )
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
      const sessions = yield* Session.Service
      const session = yield* seedSession()
      const wake = recorder(sessions)
      const handle = yield* start({
        code: "setInterval(() => {}, 1000)",
        settings: { maxLifetimeMs: 500 },
        session: session.id,
      })
      yield* handle.promote({ wake: wake.ops })
      const info = yield* handle.awaitExit
      expect(info.status).toBe("timed_out")
      expect(info.reason).toBe("lifetime")
      expect(alive(info.pid!)).toBe(false)
      yield* Effect.sleep("900 millis")
      const written = yield* notes(session.id)
      expect(written.length).toBe(1)
      expect(written[0].text).toContain('status="timed_out"')
    }),
  40_000,
)

it.instance(
  "reaps a task whose session has been idle with nobody reading it, without waking it",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* seedSession()
      const wake = recorder(sessions)
      const handle = yield* start({
        code: "setInterval(() => {}, 1000)",
        settings: { idleReapMs: 300, sweepMs: 50 },
        session: session.id,
      })
      yield* handle.promote({ wake: wake.ops })
      const info = yield* handle.awaitExit
      expect(info.status).toBe("timed_out")
      expect(info.reason).toBe("idle")
      yield* Effect.sleep("900 millis")
      expect((yield* notes(session.id)).length).toBe(0)
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

/** Every shell.task.updated event published while `self` runs. */
const collectTaskEvents = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const seen: Array<{ sessionID: string; task: ShellTasks.Info & { tail?: string; wake?: string } }> = []
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === "shell.task.updated") seen.push(event.data as (typeof seen)[number])
      return Effect.void
    })
    const value = yield* self
    yield* Effect.sleep("200 millis")
    yield* unsubscribe
    return { value, seen }
  })

it.instance(
  "publishes shell.task.updated when a task goes to the background and when it ends",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const wake = recorder(sessions)
      const session = yield* seedSession()
      const { seen } = yield* collectTaskEvents(
        Effect.gen(function* () {
          const handle = yield* start({
            code: "require('fs').writeSync(1, 'building\\n'); setTimeout(() => {}, 600)",
            session: session.id,
          })
          yield* waitFor(handle.info, (info) => info.bytes > 0)
          yield* handle.promote({ wake: wake.ops })
          yield* handle.awaitExit
          yield* Effect.sleep("900 millis")
        }),
      )
      const statuses = seen.map((item) => item.task.status)
      expect(statuses[0]).toBe("running")
      expect(statuses.at(-1)).toBe("exited")
      expect(seen.every((item) => item.sessionID === session.id)).toBe(true)
      // the promoted event already carries the last output line and a pending wake
      expect(seen[0]!.task.tail).toBe("building")
      expect(seen[0]!.task.wake).toBe("pending")
      // after the wake was delivered, the last event says so
      expect(seen.at(-1)!.task.wake).toBe("delivered")
    }),
  30_000,
)

it.instance(
  "a task that never goes to the background publishes nothing",
  () =>
    Effect.gen(function* () {
      const { seen } = yield* collectTaskEvents(
        Effect.gen(function* () {
          const handle = yield* start({ code: "require('fs').writeSync(1, 'quick\n')" })
          yield* handle.awaitExit
        }),
      )
      expect(seen).toEqual([])
    }),
  30_000,
)

it.instance(
  "a stopped task lists no wake",
  () =>
    Effect.gen(function* () {
      const tasks = yield* ShellTasks.Service
      const sessions = yield* Session.Service
      const wake = recorder(sessions)
      const handle = yield* start({ code: "setInterval(() => {}, 1000)" })
      yield* handle.promote({ wake: wake.ops })
      const stopped = yield* tasks.stop(sessionID, handle.id)
      expect(stopped?.status).toBe("stopped")
      const listed = (yield* tasks.list(sessionID)).find((info) => info.id === handle.id) as
        | (ShellTasks.Info & { wake?: string })
        | undefined
      expect(listed?.wake).toBe("suppressed")
    }),
  30_000,
)
