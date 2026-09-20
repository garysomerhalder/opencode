/**
 * `shell_output` and `shell_stop`.
 *
 * Modeled on MiniMax Code (MIT) `task_output` / `task_stop`, including the
 * hint that discourages tight polling when a read returns nothing new.
 */
import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { ShellTasks } from "./tasks"

export const OutputToolID = "shell_output"
export const StopToolID = "shell_stop"

const MAX_WAIT_MS = 30_000

export const OutputParameters = Schema.Struct({
  task_id: Schema.optional(Schema.String).annotate({
    description: "The background task to read. Omit it to list this session's background shell tasks.",
  }),
  since: Schema.optional(Schema.Number).annotate({
    description: "Byte offset to read from. Omit it to continue from the last read (next_offset).",
  }),
  wait_ms: Schema.optional(Schema.Number).annotate({
    description: `Wait up to this many milliseconds for new output or for the task to finish. Capped at ${MAX_WAIT_MS}.`,
  }),
})

export const StopParameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The background task to stop." }),
})

const OUTPUT_DESCRIPTION = [
  "Reads new output from a background shell task started by the shell tool.",
  "",
  "- A shell command that runs longer than the yield threshold keeps running as a background task. The process is never restarted.",
  "- You are told automatically when a task finishes, with its exit code and output tail. Do NOT sit in a polling loop waiting for it: continue with other work.",
  "- Each read continues from the previous one. Pass `since` to re-read from a byte offset, and `wait_ms` to wait for new output instead of returning immediately.",
  "- Omit `task_id` to list this session's background shell tasks.",
  "- Reading never stops the task. Use shell_stop for that.",
].join("\n")

const STOP_DESCRIPTION = [
  "Stops a background shell task and kills its process tree.",
  "",
  "- Only the process tree that this task started is killed; other tasks and the rest of the machine are untouched.",
  "- Use it for a dev server or a watcher you no longer need, or a command that is clearly stuck.",
  "- A finished task is left alone; the call just reports its final state.",
].join("\n")

type OutputMetadata = {
  taskId?: string
  status?: string
  exit?: number | null
  nextOffset?: number
  output?: string
  outputPath?: string
  count?: number
}

function describe(info: ShellTasks.Info) {
  const duration = (info.endedAt ?? Date.now()) - info.startedAt
  const parts = [
    `id=${info.id}`,
    `status=${info.status}`,
    ...(info.status === "running" ? [] : [`exit_code=${info.exitCode ?? "null"}`]),
    `duration_ms=${duration}`,
    ...(info.reason ? [`reason=${info.reason}`] : []),
  ]
  return `${parts.join(" ")} command=${JSON.stringify(info.command)}`
}

export const ShellOutputTool = Tool.define(
  OutputToolID,
  Effect.gen(function* () {
    const tasks = yield* ShellTasks.Service

    return {
      description: OUTPUT_DESCRIPTION,
      parameters: OutputParameters,
      execute: (
        params: Schema.Schema.Type<typeof OutputParameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<OutputMetadata>> =>
        Effect.gen(function* () {
          if (!params.task_id) {
            const list = yield* tasks.list(ctx.sessionID)
            const output =
              list.length === 0
                ? "No background shell tasks in this session."
                : ["Background shell tasks:", ...list.map((info) => `- ${describe(info)}`)].join("\n")
            return {
              title: "background shell tasks",
              metadata: { count: list.length },
              output,
            }
          }

          const result = yield* tasks.read(ctx.sessionID, params.task_id, {
            ...(params.since === undefined ? {} : { offset: params.since }),
            ...(params.wait_ms === undefined ? {} : { waitMs: params.wait_ms }),
            // Keep this tool part visibly moving while the read waits, the way
            // a foreground shell call streams its output.
            onWait: (text) => ctx.metadata({ metadata: { output: text.slice(-30_000) } }),
          })
          if (!result) {
            return {
              title: params.task_id,
              metadata: { taskId: params.task_id, status: "not_found" },
              output: `No background shell task ${params.task_id} in this session. Use shell_output with no task_id to list them.`,
            }
          }

          const info = result.info
          const header = `<shell_output ${describe(info)} next_offset=${result.nextOffset}>`
          const body: string[] = []
          if (result.skipped)
            body.push(
              `...output before this point was dropped: the task passed its output cap (${info.bytes} bytes captured)...`,
            )
          body.push(result.text.length > 0 ? result.text : "(no new output)")
          if (result.truncated) body.push(`...more output available: read again with since=${result.nextOffset}...`)
          if (info.status !== "running" && info.file) body.push(`Full output saved to: ${info.file}`)
          if (info.status === "running" && result.unchanged >= 2)
            body.push(
              "This read returned nothing new and neither did the previous one. Stop polling: you are told automatically when the task finishes. Do other work, or read again with wait_ms=30000.",
            )
          const output = [header, ...body, "</shell_output>"].join("\n")

          return {
            title: info.command,
            metadata: {
              taskId: info.id,
              status: info.status,
              exit: info.exitCode,
              nextOffset: result.nextOffset,
              output: result.text.slice(-30_000),
              ...(info.file ? { outputPath: info.file } : {}),
            },
            output,
          }
        }),
    }
  }),
)

export const ShellStopTool = Tool.define(
  StopToolID,
  Effect.gen(function* () {
    const tasks = yield* ShellTasks.Service

    return {
      description: STOP_DESCRIPTION,
      parameters: StopParameters,
      execute: (
        params: Schema.Schema.Type<typeof StopParameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<OutputMetadata>> =>
        Effect.gen(function* () {
          const before = yield* tasks.get(ctx.sessionID, params.task_id)
          if (!before) {
            return {
              title: params.task_id,
              metadata: { taskId: params.task_id, status: "not_found" },
              output: `No background shell task ${params.task_id} in this session. Use shell_output with no task_id to list them.`,
            }
          }
          const info = (yield* tasks.stop(ctx.sessionID, params.task_id)) ?? before
          return {
            title: info.command,
            metadata: { taskId: info.id, status: info.status, exit: info.exitCode },
            output:
              info.status === "stopped"
                ? `Stopped background shell task ${info.id} and killed its process tree.\n${describe(info)}`
                : `Background shell task ${info.id} was already finished.\n${describe(info)}`,
          }
        }),
    }
  }),
)
