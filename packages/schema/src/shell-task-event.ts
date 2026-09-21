export * as ShellTaskEvent from "./shell-task-event"

import { Schema } from "effect"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

/**
 * Whether a background task's finish reaches the agent that started it.
 * - `none`: nothing will wake the session (a task that never went to the background).
 * - `pending`: it will be told when the task ends.
 * - `delivered`: it was told.
 * - `read`: it already read the end itself, so no wake was needed.
 * - `suppressed`: no wake, on purpose (stopped on request, cancelled, or reaped as idle).
 */
export const Wake = Schema.Literals(["none", "pending", "delivered", "read", "suppressed"])
export type Wake = Schema.Schema.Type<typeof Wake>

/** A background shell task, as listed to clients. The one shape for the list endpoint and the event. */
export const Info = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  command: Schema.String,
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited", "stopped", "timed_out", "cancelled"]),
  pid: Schema.optionalKey(NonNegativeInt),
  exitCode: Schema.NullOr(Schema.Number),
  startedAt: NonNegativeInt,
  endedAt: Schema.optionalKey(NonNegativeInt),
  bytes: NonNegativeInt,
  file: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  /** The last line of output, at most 200 characters. */
  tail: Schema.optionalKey(Schema.String),
  wake: Schema.optionalKey(Wake),
}).annotate({ identifier: "ShellTask" })
export type Info = Schema.Schema.Type<typeof Info>

export const Updated = Event.define({
  type: "shell.task.updated",
  schema: {
    sessionID: SessionID,
    task: Info,
  },
})

export const Definitions = Event.inventory(Updated)
