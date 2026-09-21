/**
 * Background shell tasks.
 *
 * Modeled on MiniMax Code (MIT): a foreground command that outlives a short
 * threshold is not killed and not restarted. The same process keeps running as
 * a managed background task, the tool returns a receipt, and the owning session
 * is woken with a synthetic message when the task finishes.
 *
 * The process is owned by this registry's instance scope, not by the tool call,
 * so it survives the tool call returning and survives a turn abort. It is
 * terminated by an explicit stop, the lifetime cap, the idle reaper, session
 * deletion, or instance shutdown.
 */
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Cause, Context, Deferred, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import fs from "node:fs/promises"
import path from "path"
import { Identifier } from "@opencode-ai/core/id/id"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import type { SessionID, MessageID } from "@/session/schema"
import { TRUNCATION_DIR } from "../truncation-dir"
import { ToolID } from "../schema"
import { SessionWake, type WakeOps } from "../wake"
import { ShellTaskEvent } from "@opencode-ai/schema/shell-task-event"
import { lastLine, shouldPublish, wakeState, type Wake } from "./task-view"

export type Status = "running" | "exited" | "stopped" | "timed_out" | "cancelled"

export type Reason = "deadline" | "lifetime" | "idle" | "stopped" | "session" | "shutdown"

export type Info = {
  id: string
  sessionID: SessionID
  messageID: MessageID
  callID?: string
  command: string
  cwd: string
  pid?: number
  status: Status
  exitCode: number | null
  startedAt: number
  endedAt?: number
  /** Bytes of output captured, including anything past the output cap. */
  bytes: number
  /** Bytes written to the output file. */
  fileBytes: number
  file?: string
  outputCapped: boolean
  background: boolean
  reason?: Reason
  /** Set when the command could not be started at all. */
  error?: string
  /** The last line of output (computed when listed). */
  tail?: string
  /** Whether the finish reaches the agent (computed when listed). */
  wake?: Wake
}

export type Settings = {
  enabled: boolean
  yieldAfterMs: number
  maxLifetimeMs: number
  maxConcurrent: number
  maxOutputBytes: number
  idleReapMs: number
  sweepMs: number
}

export const DEFAULTS: Settings = {
  // Off for the first release: nothing in the UI shows a live background
  // process yet, so a user who presses escape would have no way to see or stop
  // the trees that keep running. Opt in with `experimental.background_shell`.
  enabled: false,
  yieldAfterMs: 15_000,
  maxLifetimeMs: 60 * 60 * 1000,
  maxConcurrent: 8,
  maxOutputBytes: 32 * 1024 * 1024,
  idleReapMs: 30 * 60 * 1000,
  sweepMs: 60_000,
}

/** Config shape: `experimental.background_shell`. */
export type ConfigInput =
  | boolean
  | {
      enabled?: boolean
      yield_after_ms?: number
      max_lifetime_ms?: number
      max_concurrent?: number
      max_output_bytes?: number
      idle_reap_ms?: number
      sweep_ms?: number
    }
  | undefined

export function settings(input: ConfigInput): Settings {
  if (input === undefined) return DEFAULTS
  if (typeof input === "boolean") return { ...DEFAULTS, enabled: input }
  return {
    // Writing the settings object is itself the opt-in; `enabled: false` still wins.
    enabled: input.enabled ?? true,
    yieldAfterMs: input.yield_after_ms ?? DEFAULTS.yieldAfterMs,
    maxLifetimeMs: input.max_lifetime_ms ?? DEFAULTS.maxLifetimeMs,
    maxConcurrent: input.max_concurrent ?? DEFAULTS.maxConcurrent,
    maxOutputBytes: input.max_output_bytes ?? DEFAULTS.maxOutputBytes,
    idleReapMs: input.idle_reap_ms ?? DEFAULTS.idleReapMs,
    sweepMs: input.sweep_ms ?? DEFAULTS.sweepMs,
  }
}

export type Limits = { maxLines: number; maxBytes: number }

export type StartInput = {
  command: ChildProcess.Command
  /** The command line, for receipts and listings. */
  display: string
  cwd: string
  sessionID: SessionID
  messageID: MessageID
  callID?: string
  limits: Limits
  settings: Settings
  /** Streams the rolling preview while the call is still in the foreground. */
  onPreview?: (text: string) => Effect.Effect<void>
}

export type PromoteInput = {
  wake?: WakeOps
  /** Absolute deadline for the process, in ms since start. Falls back to the lifetime cap. */
  deadlineMs?: number
}

export type Result = {
  info: Info
  /** The retained output window, exactly as the foreground path builds it. */
  raw: string
  cut: boolean
  preview: string
}

export type Handle = {
  readonly id: string
  readonly info: Effect.Effect<Info>
  readonly awaitExit: Effect.Effect<Info>
  readonly result: Effect.Effect<Result>
  /** Stops streaming previews into the tool call that started it. */
  readonly detach: Effect.Effect<void>
  readonly promote: (input: PromoteInput) => Effect.Effect<Info | undefined>
  readonly kill: (status: Exclude<Status, "running" | "exited">, reason: Reason) => Effect.Effect<Info>
}

export type ReadInput = {
  offset?: number
  waitMs?: number
  limits?: Limits
  /**
   * Called with the rolling preview every second while a read is waiting, so a
   * long wait still looks alive to anything watching the tool part's metadata.
   */
  onWait?: (preview: string) => Effect.Effect<void>
}

export type ReadResult = {
  info: Info
  text: string
  offset: number
  nextOffset: number
  /** Output before `offset` was dropped because the task hit the output cap. */
  skipped: boolean
  truncated: boolean
  timedOut: boolean
  /** Consecutive reads that saw the same status and offset. */
  unchanged: number
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Handle>
  readonly get: (sessionID: SessionID, id: string) => Effect.Effect<Info | undefined>
  readonly list: (sessionID?: SessionID) => Effect.Effect<Info[]>
  readonly read: (sessionID: SessionID, id: string, input?: ReadInput) => Effect.Effect<ReadResult | undefined>
  readonly stop: (sessionID: SessionID, id: string, reason?: Reason) => Effect.Effect<Info | undefined>
  readonly stopAll: (input?: { sessionID?: SessionID; reason?: Reason }) => Effect.Effect<Info[]>
  /** Running background tasks, for the concurrency cap. */
  readonly running: (sessionID?: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellTasks") {}

const TAIL_BYTES = 256 * 1024
const WAKE_BATCH_MS = 250
const WAKE_TAIL_LINES = 40
const WAKE_TAIL_BYTES = 4 * 1024
const MAX_WAIT_MS = 30_000
/** Output kept in memory for a finished background task; the file keeps the rest. */
const FINISHED_TAIL_BYTES = 8 * 1024
/** Finished tasks kept in the registry, newest first. */
const MAX_FINISHED = 50
/** Shortest gap between two output-only shell.task.updated events for one task. */
const PUBLISH_EVERY_MS = 1000

type Chunk = { text: string; size: number }

type Entry = {
  info: Info
  limits: Limits
  settings: Settings
  chunks: Chunk[]
  used: number
  cut: boolean
  preview: string
  /** Captured output that has not been written to a file yet. */
  memory: string
  file?: string
  /** Bytes handed to the write queue, including writes that have not landed yet. */
  written: number
  queue: Promise<void>
  tail: string
  stop: Deferred.Deferred<{ status: Exclude<Status, "running">; reason: Reason }>
  done: Deferred.Deferred<Info>
  onPreview?: (text: string) => Effect.Effect<void>
  wake?: WakeOps
  promotedAt?: number
  lastReadAt: number
  lastBusyAt: number
  observedTerminal: boolean
  reads: Map<string, { status: Status; offset: number; count: number }>
  cursor: number
  /** The wake note for this task was delivered. */
  woke: boolean
  /** When the last shell.task.updated event for this task went out. */
  publishedAt?: number
}

type State = {
  scope: Scope.Scope
  tasks: Map<string, Entry>
  settings: Settings
  sweeper?: Fiber.Fiber<void>
  pendingWake: Entry[]
  wakeFiber?: Fiber.Fiber<void>
}

function preview(text: string, cap = 30_000) {
  if (text.length <= cap) return text
  return "...\n\n" + text.slice(-cap)
}

function keepTail(text: string, bytes: number) {
  if (Buffer.byteLength(text, "utf-8") <= bytes) return text
  const buf = Buffer.from(text, "utf-8")
  let start = buf.length - bytes
  if (start < 0) start = 0
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString("utf-8")
}

export function lastLines(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    out.unshift(lines[i])
    bytes += size
  }
  return out.join("\n")
}

function snapshot(entry: Entry): Info {
  const tail = lastLine(entry.tail)
  return {
    ...entry.info,
    ...(tail ? { tail } : {}),
    wake: wakeState({
      hasWake: entry.wake !== undefined,
      status: entry.info.status,
      reason: entry.info.reason,
      observedTerminal: entry.observedTerminal,
      woke: entry.woke,
    }),
  }
}

/** A task as clients see it: the list endpoint and the shell.task.updated event. */
export function clientInfo(info: Info): ShellTaskEvent.Info {
  return {
    id: info.id,
    sessionID: info.sessionID,
    command: info.command,
    cwd: info.cwd,
    status: info.status,
    ...(info.pid === undefined ? {} : { pid: info.pid }),
    exitCode: info.exitCode,
    startedAt: info.startedAt,
    ...(info.endedAt === undefined ? {} : { endedAt: info.endedAt }),
    bytes: info.bytes,
    ...(info.file ? { file: info.file } : {}),
    ...(info.reason ? { reason: info.reason } : {}),
    ...(info.tail ? { tail: info.tail } : {}),
    ...(info.wake ? { wake: info.wake } : {}),
  }
}

/** The `<background-shell-finished>` message a finished task wakes its session with. */
export function wakeText(entries: readonly { info: Info; tail: string }[]) {
  const lines = ["<background-shell-finished>"]
  for (const entry of entries) {
    const info = entry.info
    const duration = (info.endedAt ?? Date.now()) - info.startedAt
    lines.push(
      `<task id="${info.id}" status="${info.status}" exit_code="${info.exitCode ?? "null"}" duration_ms="${duration}" command="${escapeAttribute(info.command)}" />`,
    )
    const tail = lastLines(entry.tail, WAKE_TAIL_LINES, WAKE_TAIL_BYTES)
    lines.push("Output tail:", tail.length > 0 ? tail : "(no output)")
    if (info.file) lines.push(`Full output: ${info.file}`)
  }
  lines.push(
    "This is the result of a background shell task you started. Continue the work with it.",
    "Read more with shell_output; do not rerun the command.",
    "</background-shell-finished>",
  )
  return lines.join("\n")
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ShellTasks.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const data: State = { scope, tasks: new Map(), settings: DEFAULTS, pendingWake: [] }
        // Session deletion kills that session's tasks. A turn abort deliberately
        // does not: a build or a dev server has to survive the user pressing escape.
        const unsubscribe = yield* events.listen((event) =>
          Effect.gen(function* () {
            if (event.type !== SessionV1.Event.Deleted.type) return
            if (event.location?.directory && event.location.directory !== ctx.directory) return
            const sessionID = (event.data as { sessionID?: SessionID })?.sessionID
            if (!sessionID) return
            // Only ask: an event listener must not block the publisher while a
            // process tree is being killed.
            yield* Effect.forEach(
              Array.from(data.tasks.values()).filter(
                (entry) => entry.info.status === "running" && entry.info.sessionID === sessionID,
              ),
              (entry) => requestStop(entry, "cancelled", "session"),
              { concurrency: "unbounded", discard: true },
            )
          }).pipe(Effect.ignore),
        )
        // Only ask here too. Closing this scope interrupts the fibers that own
        // the processes, and each one kills its tree on the way out, so waiting
        // for a status that those fibers can no longer report would hang
        // instance disposal.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            Array.from(data.tasks.values()).filter((entry) => entry.info.status === "running"),
            (entry) => requestStop(entry, "cancelled", "shutdown"),
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.andThen(unsubscribe), Effect.ignore),
        )
        return data
      }),
    )

    /** Asks the owning fiber to kill the process tree. Does not wait for it. */
    const requestStop = Effect.fn("ShellTasks.requestStop")(function* (
      entry: Entry,
      next: Exclude<Status, "running">,
      reason: Reason,
    ) {
      if (entry.info.status !== "running") return
      yield* Deferred.succeed(entry.stop, { status: next, reason }).pipe(Effect.ignore)
    })

    const terminate = Effect.fn("ShellTasks.terminate")(function* (
      entry: Entry,
      next: Exclude<Status, "running">,
      reason: Reason,
    ) {
      if (entry.info.status !== "running") return snapshot(entry)
      yield* requestStop(entry, next, reason)
      return yield* Deferred.await(entry.done)
    })

    const flush = (entry: Entry) => Effect.promise(() => entry.queue.catch(() => undefined))

    /**
     * Tells clients a background task changed: always on a status change
     * (`force`), otherwise at most once a second while output grows. A task that
     * never left the foreground is part of its tool call and is not announced.
     */
    const publish = Effect.fn("ShellTasks.publish")(function* (entry: Entry, force: boolean) {
      if (!entry.info.background) return
      const now = Date.now()
      if (!shouldPublish({ force, lastAt: entry.publishedAt, now, everyMs: PUBLISH_EVERY_MS })) return
      entry.publishedAt = now
      yield* events
        .publish(ShellTaskEvent.Updated, { sessionID: entry.info.sessionID, task: clientInfo(snapshot(entry)) })
        .pipe(Effect.ignore)
    })

    const writeFile = (entry: Entry, text: string) => {
      if (!entry.file || text.length === 0) return
      const file = entry.file
      const size = Buffer.byteLength(text, "utf-8")
      entry.queue = entry.queue
        .then(() => fs.appendFile(file, text, "utf-8"))
        .then(
          () => {
            entry.info.fileBytes += size
          },
          () => undefined,
        )
      entry.written += size
    }

    /** Gives the entry an output file and moves everything captured so far into it. */
    const spill = Effect.fn("ShellTasks.spill")(function* (entry: Entry) {
      if (entry.file) return
      yield* Effect.promise(() => fs.mkdir(TRUNCATION_DIR, { recursive: true })).pipe(Effect.ignore)
      // The `tool_` prefix keeps these files inside the existing truncation
      // retention sweep and the existing read permission glob.
      entry.file = path.join(TRUNCATION_DIR, ToolID.ascending())
      entry.info.file = entry.file
      entry.info.fileBytes = 0
      entry.written = 0
      const pending = entry.memory
      entry.memory = ""
      entry.queue = entry.queue.then(() => fs.writeFile(entry.file!, "", "utf-8")).catch(() => undefined)
      const room = entry.settings.maxOutputBytes
      const buffered = Buffer.from(pending, "utf-8")
      if (buffered.length > room) entry.info.outputCapped = true
      writeFile(entry, buffered.subarray(0, room).toString("utf-8"))
      yield* flush(entry)
    })

    const append = Effect.fn("ShellTasks.append")(function* (entry: Entry, chunk: string) {
      const size = Buffer.byteLength(chunk, "utf-8")
      entry.info.bytes += size
      entry.chunks.push({ text: chunk, size })
      entry.used += size
      const keep = entry.limits.maxBytes * 2
      while (entry.used > keep && entry.chunks.length > 1) {
        const item = entry.chunks.shift()
        if (!item) break
        entry.used -= item.size
        entry.cut = true
      }
      entry.tail = keepTail(entry.tail + chunk, TAIL_BYTES)
      entry.preview = preview(entry.preview + chunk)

      if (entry.file) {
        const room = entry.settings.maxOutputBytes - entry.written
        if (room <= 0) entry.info.outputCapped = true
        if (room >= size) writeFile(entry, chunk)
        if (room > 0 && room < size) {
          // Write the part that still fits so the file ends on a clean cap.
          writeFile(entry, Buffer.from(chunk, "utf-8").subarray(0, room).toString("utf-8"))
          entry.info.outputCapped = true
        }
      } else {
        entry.memory += chunk
        if (Buffer.byteLength(entry.memory, "utf-8") > entry.limits.maxBytes) {
          entry.cut = true
          yield* spill(entry)
        }
      }

      if (entry.onPreview) yield* entry.onPreview(entry.preview).pipe(Effect.ignore)
      yield* publish(entry, false)
    })

    /** Keeps the registry from growing without bound over a long session. */
    const prune = Effect.fn("ShellTasks.prune")(function* () {
      const data = yield* InstanceState.get(state)
      const finished = Array.from(data.tasks.values())
        .filter((entry) => entry.info.status !== "running")
        .toSorted((a, b) => (a.info.endedAt ?? a.info.startedAt) - (b.info.endedAt ?? b.info.startedAt))
      for (const entry of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
        data.tasks.delete(entry.info.id)
      }
    })

    const settle = Effect.fn("ShellTasks.settle")(function* (
      entry: Entry,
      next: Exclude<Status, "running">,
      code: number | null,
      reason?: Reason,
    ) {
      if (entry.info.status !== "running") return snapshot(entry)
      entry.info.status = next
      entry.info.exitCode = code
      entry.info.endedAt = Date.now()
      if (reason) entry.info.reason = reason
      if (entry.file) yield* flush(entry)
      if (entry.info.background) {
        // The tool call for a promoted task returned long ago; only the wake
        // tail is still needed, and the full output lives in the file.
        entry.chunks = []
        entry.used = 0
        entry.tail = keepTail(entry.tail, FINISHED_TAIL_BYTES)
        entry.preview = preview(entry.preview, FINISHED_TAIL_BYTES)
      }
      yield* Deferred.succeed(entry.done, snapshot(entry)).pipe(Effect.ignore)
      yield* publish(entry, true)
      yield* prune()
      return snapshot(entry)
    })

    /**
     * Wakes the owning session once per batch of finishes. Only a task that
     * ended on its own or hit a deadline wakes a session: a stop the agent
     * asked for, a cancelled task, and an idle-reaped task do not.
     */
    const scheduleWake = Effect.fn("ShellTasks.scheduleWake")(function* (entry: Entry) {
      if (!entry.wake) return
      if (entry.observedTerminal) return
      if (entry.info.status !== "exited" && entry.info.reason !== "deadline" && entry.info.reason !== "lifetime") return
      const data = yield* InstanceState.get(state)
      data.pendingWake.push(entry)
      if (data.wakeFiber) return
      const deliver = Effect.gen(function* () {
        yield* Effect.sleep(`${WAKE_BATCH_MS} millis`)
        const current = yield* InstanceState.get(state)
        const pending = current.pendingWake.filter((item) => !item.observedTerminal)
        current.pendingWake = []
        current.wakeFiber = undefined
        const bySession = new Map<SessionID, Entry[]>()
        for (const item of pending) {
          const list = bySession.get(item.info.sessionID) ?? []
          list.push(item)
          bySession.set(item.info.sessionID, list)
        }
        yield* Effect.forEach(
          Array.from(bySession.values()),
          (items) =>
            Effect.gen(function* () {
              const first = items[0]
              if (!first?.wake) return
              // The note copies the session's real user message, so it runs with
              // that turn's agent, model and system prompt and writes nothing to
              // the session row: a user who switched agents while the command ran
              // cannot be switched back by a message they did not send.
              yield* SessionWake.deliver({
                sessions,
                ops: first.wake,
                sessionID: first.info.sessionID,
                kind: "background_shell",
                label:
                  items.length === 1 ? "background command finished" : `${items.length} background commands finished`,
                text: wakeText(items.map((item) => ({ info: item.info, tail: item.tail }))),
              }).pipe(Effect.ignore)
              for (const item of items) {
                item.woke = true
                yield* publish(item, true)
              }
            }),
          { concurrency: 1, discard: true },
        )
      })
      data.wakeFiber = yield* Effect.forkIn(deliver, data.scope, { startImmediately: true })
    })

    /** Lifetime cap and idle reaping for promoted tasks. */
    const sweep = Effect.fn("ShellTasks.sweep")(function* () {
      const data = yield* InstanceState.get(state)
      const now = Date.now()
      for (const entry of Array.from(data.tasks.values())) {
        if (entry.info.status !== "running") continue
        if (!entry.info.background) continue
        const current = yield* status.get(entry.info.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (current && current.type !== "idle") entry.lastBusyAt = now
        if (now - entry.info.startedAt >= entry.settings.maxLifetimeMs) {
          yield* terminate(entry, "timed_out", "lifetime")
          continue
        }
        const quiet = now - Math.max(entry.lastReadAt, entry.lastBusyAt, entry.promotedAt ?? entry.info.startedAt)
        if (quiet >= entry.settings.idleReapMs) yield* terminate(entry, "timed_out", "idle")
      }
    })

    const ensureSweeper = Effect.fn("ShellTasks.ensureSweeper")(function* (next: Settings) {
      const data = yield* InstanceState.get(state)
      data.settings = next
      if (data.sweeper) return
      const loop = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(`${(yield* InstanceState.get(state)).settings.sweepMs} millis`)
          yield* sweep().pipe(Effect.ignore)
        }
      })
      data.sweeper = yield* Effect.forkIn(loop, data.scope, { startImmediately: true })
    })

    const start: Interface["start"] = Effect.fn("ShellTasks.start")(function* (input) {
      const data = yield* InstanceState.get(state)
      yield* ensureSweeper(input.settings)
      const id = Identifier.create("shl", "ascending")
      const entry: Entry = {
        info: {
          id,
          sessionID: input.sessionID,
          messageID: input.messageID,
          ...(input.callID ? { callID: input.callID } : {}),
          command: input.display,
          cwd: input.cwd,
          status: "running",
          exitCode: null,
          startedAt: Date.now(),
          bytes: 0,
          fileBytes: 0,
          outputCapped: false,
          background: false,
        },
        limits: input.limits,
        settings: input.settings,
        chunks: [],
        used: 0,
        cut: false,
        preview: "",
        memory: "",
        written: 0,
        queue: Promise.resolve(),
        tail: "",
        stop: yield* Deferred.make<{ status: Exclude<Status, "running">; reason: Reason }>(),
        done: yield* Deferred.make<Info>(),
        ...(input.onPreview ? { onPreview: input.onPreview } : {}),
        lastReadAt: Date.now(),
        lastBusyAt: Date.now(),
        observedTerminal: false,
        reads: new Map(),
        cursor: 0,
        woke: false,
      }
      data.tasks.set(id, entry)

      const body = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(input.command)
          entry.info.pid = handle.pid
          yield* Effect.forkScoped(Stream.runForEach(Stream.decodeText(handle.all), (chunk) => append(entry, chunk)))
          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(
              Effect.map((code) => ({ kind: "exit" as const, code: code as number | null })),
              Effect.catch(() => Effect.succeed({ kind: "exit" as const, code: null })),
            ),
            Deferred.await(entry.stop).pipe(Effect.map((value) => ({ kind: "stop" as const, value }))),
          ])
          if (exit.kind === "stop") {
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
            // Let the reader drain whatever the process wrote before it died.
            yield* Effect.sleep("50 millis")
            return yield* settle(entry, exit.value.status, null, exit.value.reason)
          }
          return yield* settle(entry, "exited", exit.code)
        }),
      ).pipe(
        // A command that could not be spawned at all (missing shell, bad cwd,
        // EACCES) must not read as "ran and printed nothing": the failure is
        // recorded on the entry and the caller raises it.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            entry.info.error =
              Cause.squash(cause) instanceof Error
                ? (Cause.squash(cause) as Error).message
                : String(Cause.squash(cause))
            return yield* settle(entry, "exited", null)
          }),
        ),
        Effect.andThen(scheduleWake(entry)),
        Effect.asVoid,
      )

      yield* Effect.forkIn(body, data.scope, { startImmediately: true })

      const handle: Handle = {
        id,
        info: Effect.sync(() => snapshot(entry)),
        awaitExit: Deferred.await(entry.done),
        result: Effect.sync(() => ({
          info: snapshot(entry),
          raw: entry.chunks.map((item) => item.text).join(""),
          cut: entry.cut,
          preview: entry.preview,
        })),
        detach: Effect.sync(() => {
          entry.onPreview = undefined
        }),
        promote: (promoteInput) =>
          Effect.gen(function* () {
            if (entry.info.status !== "running") return undefined
            const current = yield* InstanceState.get(state)
            const running = Array.from(current.tasks.values()).filter(
              (item) => item.info.status === "running" && item.info.background,
            )
            if (running.length >= entry.settings.maxConcurrent) return undefined
            entry.onPreview = undefined
            entry.info.background = true
            entry.promotedAt = Date.now()
            entry.lastReadAt = Date.now()
            entry.lastBusyAt = Date.now()
            if (promoteInput.wake) entry.wake = promoteInput.wake
            yield* spill(entry)
            const lifetime = Math.min(
              promoteInput.deadlineMs ?? entry.settings.maxLifetimeMs,
              entry.settings.maxLifetimeMs,
            )
            const reason: Reason =
              promoteInput.deadlineMs !== undefined && promoteInput.deadlineMs < entry.settings.maxLifetimeMs
                ? "deadline"
                : "lifetime"
            const remaining = Math.max(0, entry.info.startedAt + lifetime - Date.now())
            const watchdog = Effect.sleep(`${remaining} millis`).pipe(
              Effect.andThen(terminate(entry, "timed_out", reason)),
              Effect.asVoid,
            )
            yield* Effect.forkIn(watchdog, current.scope, { startImmediately: true })
            yield* publish(entry, true)
            return snapshot(entry)
          }),
        kill: (next, reason) => terminate(entry, next, reason),
      }
      return handle
    })

    const find = Effect.fn("ShellTasks.find")(function* (sessionID: SessionID, id: string) {
      const data = yield* InstanceState.get(state)
      const entry = data.tasks.get(id)
      if (!entry) return undefined
      if (entry.info.sessionID !== sessionID) return undefined
      return entry
    })

    const get: Interface["get"] = Effect.fn("ShellTasks.get")(function* (sessionID, id) {
      const entry = yield* find(sessionID, id)
      return entry ? snapshot(entry) : undefined
    })

    const list: Interface["list"] = Effect.fn("ShellTasks.list")(function* (sessionID) {
      const data = yield* InstanceState.get(state)
      return Array.from(data.tasks.values())
        .filter((entry) => entry.info.background && (!sessionID || entry.info.sessionID === sessionID))
        .map(snapshot)
        .toSorted((a, b) => a.startedAt - b.startedAt)
    })

    const running: Interface["running"] = Effect.fn("ShellTasks.running")(function* (sessionID) {
      return (yield* list(sessionID)).filter((info) => info.status === "running")
    })

    const slice = Effect.fn("ShellTasks.slice")(function* (entry: Entry, offset: number, limit: number) {
      if (!entry.file) {
        const buf = Buffer.from(entry.memory, "utf-8")
        return buf.subarray(offset, offset + limit).toString("utf-8")
      }
      yield* flush(entry)
      return yield* Effect.promise(async () => {
        const handle = await fs.open(entry.file!, "r")
        try {
          const size = Math.max(0, Math.min(limit, entry.info.fileBytes - offset))
          if (size <= 0) return ""
          const buf = Buffer.alloc(size)
          await handle.read(buf, 0, size, offset)
          return buf.toString("utf-8")
        } finally {
          await handle.close()
        }
      }).pipe(Effect.catchCause(() => Effect.succeed("")))
    })

    const read: Interface["read"] = Effect.fn("ShellTasks.read")(function* (sessionID, id, input = {}) {
      const entry = yield* find(sessionID, id)
      if (!entry) return undefined
      const limits = input.limits ?? entry.limits
      const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), MAX_WAIT_MS)
      const from = input.offset ?? entry.cursor
      let timedOut = false
      if (waitMs > 0 && entry.info.status === "running" && entry.info.bytes <= from) {
        const progress = input.onWait
        const waited = yield* Effect.raceAll([
          Deferred.await(entry.done).pipe(Effect.as("done" as const)),
          Effect.sleep(`${waitMs} millis`).pipe(Effect.as("timeout" as const)),
          // Poll cheaply for new output; the stream writes into the entry directly.
          Effect.gen(function* () {
            while (entry.info.bytes <= from && entry.info.status === "running") {
              yield* Effect.sleep("25 millis")
            }
            return "output" as const
          }),
          ...(progress
            ? [
                Effect.gen(function* () {
                  while (true) {
                    yield* Effect.sleep("1 seconds")
                    yield* progress(entry.preview).pipe(Effect.ignore)
                  }
                }).pipe(Effect.as("progress" as const)),
              ]
            : []),
        ])
        timedOut = waited === "timeout"
      }

      yield* flush(entry)
      const available = entry.file ? entry.info.fileBytes : Buffer.byteLength(entry.memory, "utf-8")
      const offset = Math.max(0, Math.min(from, available))
      // Past the output cap the file stopped growing, so serve the live tail
      // instead of silence and say that the middle was dropped.
      const capped = entry.info.outputCapped && offset >= available && entry.info.bytes > from
      const text = capped ? keepTail(entry.tail, limits.maxBytes) : yield* slice(entry, offset, limits.maxBytes)
      const nextOffset = capped ? entry.info.bytes : offset + Buffer.byteLength(text, "utf-8")
      const skipped = capped
      const truncated = !capped && nextOffset < available
      entry.lastReadAt = Date.now()
      entry.cursor = nextOffset
      if (entry.info.status !== "running" && !entry.observedTerminal) {
        entry.observedTerminal = true
        // the wake is no longer needed; clients see "read" instead of "pending"
        yield* publish(entry, true)
      }

      const key = `${sessionID}:${id}`
      const previous = entry.reads.get(key)
      const same = previous && previous.status === entry.info.status && previous.offset === nextOffset
      const unchanged = same ? previous.count + 1 : 0
      entry.reads.set(key, { status: entry.info.status, offset: nextOffset, count: unchanged })

      return {
        info: snapshot(entry),
        text,
        offset,
        nextOffset,
        skipped,
        truncated,
        timedOut,
        unchanged,
      }
    })

    const stop: Interface["stop"] = Effect.fn("ShellTasks.stop")(function* (sessionID, id, reason = "stopped") {
      const entry = yield* find(sessionID, id)
      if (!entry) return undefined
      if (entry.info.status !== "running") return snapshot(entry)
      return yield* terminate(entry, "stopped", reason)
    })

    const stopAll: Interface["stopAll"] = Effect.fn("ShellTasks.stopAll")(function* (input = {}) {
      const data = yield* InstanceState.get(state)
      const targets = Array.from(data.tasks.values()).filter(
        (entry) =>
          entry.info.status === "running" &&
          entry.info.background &&
          (!input.sessionID || entry.info.sessionID === input.sessionID),
      )
      return yield* Effect.forEach(targets, (entry) => terminate(entry, "stopped", input.reason ?? "stopped"), {
        concurrency: "unbounded",
      })
    })

    return Service.of({ start, get, list, read, stop, stopAll, running })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [CrossSpawnSpawner.node, SessionStatus.node, EventV2Bridge.node, Session.node],
})

export * as ShellTasks from "./tasks"
