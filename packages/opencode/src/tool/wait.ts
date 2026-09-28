/**
 * `wait`: block on the server, not in model turns.
 *
 * The Muses spent 2-26% of their tool steps (13% over four sessions, 214 of
 * 1,440) on steps that only polled: `sleep N; check`, `shell_output` with
 * nothing new, `tail` of a log. Each of those steps resends the whole prompt
 * (about 93k tokens on average there) to learn one line. This tool waits for
 * the condition inside one tool call and returns a short tail, so a wait costs
 * one step however long it takes.
 *
 * Targets:
 * - `task_id`: a background shell task, until it finishes (or, with
 *   `pattern`, until its output matches).
 * - `path`: a file, until it exists (or, with `pattern`, until text written to
 *   it after the call started matches).
 *
 * A task the agent waited on is marked read, so its finish does not also wake
 * the session with a second message about the same result.
 */
import { Effect, Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import * as Tool from "./tool"
import { ShellTasks } from "./shell/tasks"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { assertExternalDirectoryEffect } from "./external-directory"

export const ToolID = "wait"

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const MAX_TIMEOUT_MS = 60 * 60 * 1000
export const DEFAULT_TAIL_LINES = 20
export const MAX_TAIL_LINES = 200
/** Bytes of tail the result may carry, whatever `tail_lines` asks for. */
export const MAX_TAIL_BYTES = 4 * 1024
/** How often a file or a pattern is checked. */
export const POLL_MS = 500
/** Kept between polls so a pattern split across two writes still matches. */
const CARRY_BYTES = 16 * 1024
/** Read per poll at most; a file growing faster than this is scanned over several polls. */
const READ_CHUNK_BYTES = 1024 * 1024

export const Parameters = Schema.Struct({
  task_id: Schema.optional(Schema.String).annotate({
    description: "A background shell task id (from the shell tool). Waits until it finishes.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "A file to wait for. Waits until it exists, or with `pattern` until new text in it matches.",
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description:
      "A regular expression. With `path`: wait until text written to the file after this call started matches. With `task_id`: wait until the task's output matches (or the task ends).",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Give up after this many milliseconds (default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}).`,
  }),
  tail_lines: Schema.optional(Schema.Number).annotate({
    description: `Lines of output to return (default ${DEFAULT_TAIL_LINES}, at most ${MAX_TAIL_LINES}; capped at ${MAX_TAIL_BYTES} bytes).`,
  }),
})

export const DESCRIPTION = [
  "Waits on the server until a condition holds, then returns a short tail of output. The wait costs no model turns, however long it takes.",
  "",
  "Use it instead of polling. Do NOT run `sleep` in the shell, call shell_output again and again, or re-run a status check to see whether something finished: each of those is a full model turn.",
  "",
  "- `task_id`: wait for a background shell task to finish; returns its exit code and the last lines of output.",
  "- `task_id` + `pattern`: wait until the task prints a line matching the regular expression (e.g. a server's 'listening on').",
  "- `path`: wait until a file exists.",
  "- `path` + `pattern`: wait until text written to the file after this call starts matches the regular expression (e.g. a log line).",
  `- Times out after timeout_ms (default ${DEFAULT_TIMEOUT_MS / 60000} minutes) and says so; waiting again is fine.`,
].join("\n")

type Condition = "exited" | "matched" | "exists" | "timeout" | "not_found"

export type Metadata = {
  condition?: Condition
  waitedMs?: number
  taskId?: string
  status?: string
  exit?: number | null
  path?: string
  truncated?: boolean
}

/** The last `lines` lines of `text`, at most MAX_TAIL_BYTES. */
export function tail(text: string, lines: number) {
  return ShellTasks.lastLines(text.replace(/\r\n/g, "\n").replace(/\n+$/, ""), lines, MAX_TAIL_BYTES)
}

function compile(pattern: string | undefined) {
  if (pattern === undefined || pattern === "") return undefined
  try {
    return new RegExp(pattern, "m")
  } catch {
    // not a valid expression: match it literally
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m")
  }
}

function clamp(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback
  return Math.min(Math.floor(value), max)
}

const sizeOf = (file: string) =>
  Effect.promise(() =>
    fs.stat(file).then(
      (stat) => (stat.isFile() ? stat.size : undefined),
      () => undefined,
    ),
  )

const readRange = (file: string, start: number, end: number) =>
  Effect.promise(async () => {
    const handle = await fs.open(file, "r")
    try {
      const size = Math.max(0, end - start)
      const buf = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buf, 0, size, start)
      return buf.subarray(0, bytesRead).toString("utf-8")
    } finally {
      await handle.close()
    }
  }).pipe(Effect.catchCause(() => Effect.succeed("")))

/** Waits on a file. Pure over the file system; the tool adds permissions. */
export const waitForFile = Effect.fn("Wait.file")(function* (input: {
  file: string
  pattern?: RegExp
  timeoutMs: number
  pollMs?: number
}) {
  const started = Date.now()
  const deadline = started + input.timeoutMs
  const poll = input.pollMs ?? POLL_MS
  const initial = yield* sizeOf(input.file)
  // A file that exists already: only text written from now on can match.
  let offset = initial ?? 0
  let carry = ""
  while (true) {
    const size = yield* sizeOf(input.file)
    if (size !== undefined) {
      if (!input.pattern) {
        const text = yield* readRange(input.file, Math.max(0, size - CARRY_BYTES), size)
        return { condition: "exists" as const, text, waitedMs: Date.now() - started }
      }
      if (size < offset) {
        // truncated or replaced: start over from the top
        offset = 0
        carry = ""
      }
      if (size > offset) {
        const end = Math.min(size, offset + READ_CHUNK_BYTES)
        const chunk = yield* readRange(input.file, offset, end)
        offset = end
        const scanned = carry + chunk
        if (input.pattern.test(scanned)) {
          return { condition: "matched" as const, text: scanned, waitedMs: Date.now() - started }
        }
        carry = scanned.slice(-CARRY_BYTES)
        if (offset < size) continue
      }
    }
    if (Date.now() >= deadline) {
      return { condition: "timeout" as const, text: carry, waitedMs: Date.now() - started, exists: size !== undefined }
    }
    yield* Effect.sleep(`${Math.min(poll, Math.max(0, deadline - Date.now()))} millis`)
  }
})

/** Waits on a background shell task. */
export const waitForTask = Effect.fn("Wait.task")(function* (input: {
  tasks: ShellTasks.Interface
  sessionID: Tool.Context["sessionID"]
  id: string
  pattern?: RegExp
  timeoutMs: number
  pollMs?: number
}) {
  const started = Date.now()
  const first = yield* input.tasks.get(input.sessionID, input.id)
  if (!first) return { condition: "not_found" as const, text: "", waitedMs: 0, info: undefined }

  const lastText = (info: ShellTasks.Info) =>
    input.tasks
      .read(input.sessionID, input.id, {
        offset: Math.max(0, (info.file ? info.fileBytes : info.bytes) - CARRY_BYTES),
        limits: { maxLines: 100_000, maxBytes: CARRY_BYTES },
      })
      .pipe(Effect.map((result) => ({ info: result?.info ?? info, text: result?.text ?? "" })))

  if (!input.pattern) {
    const info = (yield* input.tasks.awaitExit(input.sessionID, input.id, input.timeoutMs)) ?? first
    const last = yield* lastText(info)
    return {
      condition: last.info.status === "running" ? ("timeout" as const) : ("exited" as const),
      text: last.text,
      waitedMs: Date.now() - started,
      info: last.info,
    }
  }

  const deadline = started + input.timeoutMs
  const poll = input.pollMs ?? POLL_MS
  // Only output printed from now on can match, like a file.
  let offset = first.bytes
  let carry = ""
  while (true) {
    const result = yield* input.tasks.read(input.sessionID, input.id, {
      offset,
      limits: { maxLines: 100_000, maxBytes: READ_CHUNK_BYTES },
    })
    if (!result)
      return { condition: "not_found" as const, text: carry, waitedMs: Date.now() - started, info: undefined }
    offset = result.nextOffset
    const scanned = carry + result.text
    if (input.pattern.test(scanned))
      return { condition: "matched" as const, text: scanned, waitedMs: Date.now() - started, info: result.info }
    carry = scanned.slice(-CARRY_BYTES)
    if (result.truncated) continue
    if (result.info.status !== "running")
      return { condition: "exited" as const, text: carry, waitedMs: Date.now() - started, info: result.info }
    if (Date.now() >= deadline)
      return { condition: "timeout" as const, text: carry, waitedMs: Date.now() - started, info: result.info }
    yield* Effect.sleep(`${Math.min(poll, Math.max(0, deadline - Date.now()))} millis`)
  }
})

function attribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

export const WaitTool = Tool.define(
  ToolID,
  Effect.gen(function* () {
    const tasks = yield* ShellTasks.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const timeoutMs = clamp(params.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
          const lines = Math.max(1, clamp(params.tail_lines, DEFAULT_TAIL_LINES, MAX_TAIL_LINES))
          const pattern = compile(params.pattern)

          if (!params.task_id === !params.path) {
            return {
              title: "wait",
              metadata: {},
              output: "Give exactly one of task_id (a background shell task) or path (a file) to wait on.",
            }
          }

          if (params.task_id) {
            yield* ctx.metadata({ title: `waiting for ${params.task_id}` })
            const result = yield* waitForTask({
              tasks,
              sessionID: ctx.sessionID,
              id: params.task_id,
              pattern,
              timeoutMs,
            })
            if (!result.info) {
              return {
                title: params.task_id,
                metadata: { condition: "not_found" as const, taskId: params.task_id },
                output: `No background shell task ${params.task_id} in this session. Use shell_output with no task_id to list them.`,
              }
            }
            const info = result.info
            const head = [
              `<wait task_id="${info.id}" condition="${result.condition}" status="${info.status}"`,
              ...(info.status === "running" ? [] : [` exit_code="${info.exitCode ?? "null"}"`]),
              ` waited_ms="${result.waitedMs}" command="${attribute(info.command)}">`,
            ].join("")
            const body = tail(result.text, lines)
            const note =
              result.condition === "timeout"
                ? `Still running after ${Math.round(result.waitedMs / 1000)}s. Wait again, or do other work: you are told when it finishes.`
                : result.condition === "exited" && pattern
                  ? "The task ended without printing a match."
                  : undefined
            return {
              title: info.command,
              metadata: {
                condition: result.condition,
                waitedMs: result.waitedMs,
                taskId: info.id,
                status: info.status,
                exit: info.exitCode,
                // the result is a tail by design; nothing here is for the cap to cut
                truncated: false,
              },
              output: [
                head,
                body.length > 0 ? body : "(no output)",
                ...(note ? [note] : []),
                ...(info.file ? [`Full output: ${info.file}`] : []),
                "</wait>",
              ].join("\n"),
            }
          }

          const instance = yield* InstanceState.context
          let file = params.path!
          if (!path.isAbsolute(file)) file = path.resolve(instance.directory, file)
          if (process.platform === "win32") file = FSUtil.normalizePath(file)
          const named = file
          file = Tool.canonicalPath(file)
          yield* assertExternalDirectoryEffect(ctx, file, {
            bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
            kind: "file",
          })
          yield* Tool.askRead(ctx, instance.worktree, named)
          yield* ctx.metadata({ title: `waiting for ${path.relative(instance.worktree, file) || file}` })

          const result = yield* waitForFile({ file, pattern, timeoutMs })
          const body = tail(result.text, lines)
          const note =
            result.condition === "timeout"
              ? pattern
                ? `No match after ${Math.round(result.waitedMs / 1000)}s.`
                : `The file did not appear within ${Math.round(result.waitedMs / 1000)}s.`
              : undefined
          return {
            title: path.relative(instance.worktree, file) || file,
            metadata: { condition: result.condition, waitedMs: result.waitedMs, path: file, truncated: false },
            output: [
              `<wait path="${attribute(file)}" condition="${result.condition}" waited_ms="${result.waitedMs}">`,
              ...(body.length > 0 ? [body] : []),
              ...(note ? [note] : []),
              "</wait>",
            ].join("\n"),
          }
        }),
    }
  }),
)

export * as Wait from "./wait"
