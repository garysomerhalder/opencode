# Accuracy B: background long commands for the shell tool

Status: design, waiting for the architect's go. Nothing here is implemented yet.

Model: MiniMax Code (MIT). Its bash tool soft-yields a foreground command to a managed
background task after 15 s without restarting it, hands back a receipt, exposes
`task_output` / `task_stop`, and wakes the owning conversation when the task ends. We port
the model, not the code. Files that paraphrase it closely carry a `MiniMax Code (MIT)` header.

## 1. Why

`packages/opencode/src/tool/shell.ts` has a flat 2-minute default (`:347`) and kills the
command at the deadline with "retry with a larger timeout" (`:564`). On Terminal-Bench style
tasks (compiles, installs, test suites, servers) that means lost work, a rerun from scratch,
and a model that guesses timeouts. With a soft yield the process is never restarted, the model
gets control back in 15 s, and it can do something else while it waits.

## 2. Lifecycle

```
shell call ──permission check (unchanged)──> spawn in a BackgroundJob scope
      │
      ├─ exits before yield_after_ms ──> the same result as today, byte for byte
      ├─ explicit `timeout` hits first ──> killed, the same message as today
      ├─ ctx.abort before yield ──────> killed, "User aborted the command" (as today)
      └─ yield_after_ms reached ──────> PROMOTED: registered as a shell task,
                                        the tool returns a receipt, the process keeps running
                                                   │
       running ── task_stop ───────────────────> stopped   (no wake: the agent asked for it)
       running ── lifetime cap / explicit timeout ─> timed_out (wake)
       running ── session abort / delete / instance dispose ─> cancelled (no wake, tree killed)
       running ── process exits ─────────────────> exited(code) (wake)
```

- The process is spawned once. The effect that owns the child handle and the output reader runs
  inside a `BackgroundJob` job scope (`type: "shell"`, `metadata.parentSessionId = sessionID`)
  from the start, so it survives the tool call's own scope. The foreground call races the
  job's exit against `yield_after_ms`, `ctx.abort` and the explicit timeout.
- Short commands keep today's behavior: the same output text, the same metadata
  (`output`, `exit`, `truncated`, `outputPath`), the same truncation. The only difference is an
  internal job entry, which is not a registered shell task and does not count toward the caps.
- Timeout semantics when the flag is on: an explicit `timeout` is still a hard deadline for the
  process (foreground or promoted). With no explicit timeout the old 2-minute kill is gone: the
  command yields at 15 s and is bounded by `max_lifetime_ms`. When the flag is off, nothing
  changes.
- Optional parameter `background: true` promotes immediately (yield at 0 ms) for servers and
  watchers. This goes through the same permission check. (Proposed; easy to drop.)
- If the concurrency cap is full at yield time, the call does not yield. It keeps today's
  foreground behavior (the default deadline and kill) and the timeout message says the
  background cap was reached and names the running task ids.

### Receipt (the tool result on yield)

```
<shell_background task_id="shl_…" status="running" elapsed_ms="15012">
Still running after 15 s. It was moved to a background task; the process was NOT restarted.
Do not rerun the command. You will get a message automatically when it finishes.
Continue with other work. task_output("shl_…") reads new output; task_stop("shl_…") stops it.
Output so far (tail):
…
</shell_background>
```

The tool part's metadata keeps `output` (a 30k preview), `exit: null`, and adds
`background: { taskId, status: "running" }`.

## 3. Task registry

`src/tool/shell/tasks.ts`: a `ShellTasks` service (instance-scoped, `LayerNode`, depends on
`BackgroundJob` and `Truncate`). One entry per promoted task:

| field | meaning |
|---|---|
| `id` | `shl_<ascending>` (the same id as the BackgroundJob job) |
| `sessionID`, `callID`, `messageID` | the owner; every lookup is scoped to the session |
| `command`, `cwd`, `shell`, `pid` | what runs |
| `status` | `running` \| `exited` \| `stopped` \| `timed_out` \| `cancelled` |
| `exitCode` | `number \| null` |
| `startedAt`, `endedAt` | epoch ms |
| `file` | the output file |
| `bytes`, `fileCapped` | bytes written, whether the file cap was hit |
| `tail` | an in-memory ring of the last 64 KB (for receipts, wake and reads past the cap) |
| `cursor` | the session's automatic read offset for `task_output` without `since` |
| `observedTerminal` | the agent already saw the final state (suppresses the wake) |

Output capture: from spawn, the chunks go to the same places as today (the in-memory `list`
and `last` preview, then the file once over `maxBytes`). On promotion the task gets a file in
the existing truncation directory, named with the `tool_` prefix (`ToolID.ascending()`), so the
existing 7-day retention, the existing read permission glob (`Truncate.GLOB`) and the existing
path handling apply unchanged. Everything captured so far is flushed to it first. The file stops
growing at `max_output_bytes` (default 32 MB). After that only the in-memory tail advances and
reads say so. Redaction: the current shell output path does no secret redaction (I checked
`truncate.ts` and `shell.ts`). The task file gets exactly the same treatment, no more and no
less. If the architect wants redaction, it should be added to both paths in one place.

## 4. Tools

Both tools are registered in `tool/registry.ts` only when the flag is on, and only for agents
that have the shell tool (if `bash` is denied for an agent, they are hidden too).

### `task_output(task_id, since?, wait_ms?)`

- Returns the new output since `since` (a byte offset) or since this session's automatic cursor,
  plus `status`, `exit_code`, `elapsed_ms` and `next_offset`, bounded by the truncation limits
  (head from the offset, with `next_offset`). A terminal status includes the full-output path.
- `wait_ms` (optional, max 30 000): a bounded long-poll that returns early on new output or exit.
  While it waits, it streams `ctx.metadata({ output: preview })`, so the desktop goal loop's
  progress signal (the newest tool part's `metadata.output`) keeps moving for a promoted build.
  Reaching the wait limit never stops the task.
- Polling discouragement: the description says the finish arrives on its own and not to poll.
  Reads are tracked per (session, task): if the status and offset are unchanged across 2
  consecutive reads, the result gets a hint (paraphrasing MiniMax's polling hint and
  runaway-guard `polling_repeat`). From the 4th unchanged read, a missing `wait_ms` is treated as
  `wait_ms = 30000`, so a tight loop costs wall time, not tokens.
- A task id from another session is reported as not found.

### `task_stop(task_id)`

Cancels that task's BackgroundJob, which closes its scope and kills its process tree only
(see section 7). It returns the final status and the output tail. It is idempotent on a finished
task. It does not wake the session.

## 5. Wake: how the finish enters the session loop

On a terminal transition (`exited` or `timed_out`, and only when `observedTerminal` is false),
the registry sends one synthetic message to the owning session. It batches the finishes that
land within 250 ms of each other:

```
<background-shell-finished>
<task task_id="shl_…" status="exited" exit_code="0" duration_ms="…" command="…"/>
Output tail:
…last ~40 lines / 4 KB…
Full output: <path>. Use task_output for more. Continue the task using this result.
</background-shell-finished>
```

Transport: the same path the background subagent (`tool/task.ts` `inject`) already uses:
`ctx.extra.promptOps.prompt({ sessionID, agent, parts: [{ type: "text", synthetic: true, … }] })`,
forked into the tool's scope. The ops are captured on the entry at promotion time.

Race analysis (Runner, `effect/runner.ts`; `SessionPrompt.runLoop`):

- **Session idle.** `prompt` writes the user message, then `ensureRunning` starts a new run.
  This is safe.
- **Turn running.** `prompt` writes the message and `ensureRunning` joins the run. The loop
  re-reads history only at the top of each step, so the message never lands mid-stream. The next
  step sees `lastUser` = our message and `lastAssistant.parentID ≠ lastUser.id`, so it continues
  and answers. History order stays valid (`U1, A1(tool calls + results), U2(synthetic), A2`).
- **Remaining window.** The message is written after the loop's final top-of-loop read but
  before the Runner goes idle. The joined run then completes without answering it, and the
  message is orphaned until the next prompt. The background subagent has the same latent race
  today. Fix: after `prompt` returns, the wake checks whether an assistant message with
  `parentID === <our message id>` exists. If not, it calls `promptOps.loop(sessionID)`, which
  starts a fresh run from Idle whose top-of-loop check sees the unanswered message. This is
  bounded to 3 attempts.
- **Session cancelled or deleted.** The tasks were already cancelled (section 6), so there is
  no wake.

**The only session/\* touch:** `session/prompt.ts` `ops()` gains one line,
`loop: (sessionID) => loop({ sessionID })`, and `TaskPromptOps` (in `tool/task.ts`) gains the
matching optional member. If the architect prefers zero session/\* edits, the fallback is to
wait for `SessionStatus` idle before injecting (a smaller window, not zero). I recommend the
one-liner.

## 6. Caps and cleanup

Config (`experimental.background_shell`, default on):

```jsonc
"experimental": { "background_shell": {
  "enabled": true,              // false = today's behavior exactly
  "yield_after_ms": 15000,
  "max_lifetime_ms": 3600000,   // 60 min hard kill, status timed_out
  "max_concurrent": 8,          // promoted running tasks per instance (also enforced per session)
  "max_output_bytes": 33554432
} }
```

`true`/`false` is also accepted as shorthand. The env var `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`
keeps its meaning (the default hard deadline) when the flag is off.

Cleanup reuses what the BackgroundJob already provides, so session/\* needs no new code for it:

- **Session abort** (`SessionRunState.cancel`, `run-state.ts:78`) cancels the running jobs whose
  `metadata.parentSessionId` is the session, which kills our trees.
- **Session delete** (`Session.remove`, `session.ts:615`) does the same.
- **Instance dispose or server shutdown:** the BackgroundJob instance scope closes all job
  scopes, which kills everything.
- **Lifetime cap:** a timer in the job effect. The status becomes `timed_out` and the session is
  woken.
- The registry is process-local and not durable (the same as BackgroundJob): a server restart
  loses tasks, and their trees die with the job scopes.

Open point for the architect: the goal loop and users abort turns. Killing background shells on
abort matches background subagents and the brief ("cleanup on … abort"), but it means a dev
server started with `background: true` dies on the next Esc.

## 7. Process trees: Windows and POSIX

Killing goes through `ChildProcessSpawner` (`core/src/cross-spawn-spawner.ts`), which the
foreground shell already uses:

- **POSIX:** `cmd()` spawns with `detached: true`, so the shell leads a new process group.
  `killGroup` sends `process.kill(-pid, SIGTERM)`, then SIGKILL after `forceKillAfter` (3 s). Only
  our group is signalled.
- **Windows:** `taskkill /pid <pid> /T /F`, which kills the tree rooted at our shell pid only.
  PowerShell is spawned `detached: false` (as today). Known limits: a grandchild that re-parents
  away (`start`, `Start-Process`, services) escapes `/T`, as it does for foreground commands
  today. Job Objects would need native code, which is out of scope. Pid reuse is not a risk
  because we kill only while we still hold the live handle (status `running`).
- Scope close (abort, delete, dispose, stop) runs the spawner's finalizer, which calls the same
  `killGroup`.

## 8. Permissions

- The permission check is unchanged and happens once, before spawn, for foreground and
  `background: true` alike (`ask()` in `shell.ts`: `external_directory` plus the `bash` patterns).
  Promotion is not a new execution; it is the same approved process.
- `task_output` only reads output of tasks the same session started. The file is in the
  truncation directory, which `read` already allows.
- `task_stop` can only terminate trees the same session started, so it has no ask. Both tools
  get permission ids (`task_output`, `task_stop`) so users can deny them. They are hidden when
  the agent's `bash` permission is `deny`.

## 9. Tests (test-first, red then green)

New: `test/tool/shell-background.test.ts`, `test/tool/shell-tasks.test.ts`. The existing
`test/tool/shell.test.ts` stays green unchanged, which is the regression guard for short commands.
Commands use `node -e` / `bun -e` scripts so they run on Windows and POSIX, with
`yield_after_ms` set to about 300 ms in tests.

1. **Yields and continues.** A command that prints, sleeps 1.5 s and prints a marker returns a
   receipt at about 300 ms with the first output. The process pid stays the same and the marker
   appears later: no restart.
2. **task_output.** Incremental reads with `since` and the automatic cursor, `next_offset`, a
   terminal status with `exit_code`, `wait_ms` returning early on output, and the cross-session
   id reported as not found.
3. **Wake.** A fake `promptOps` records the synthetic message: one per finish, batched, with
   exit code and tail; none after `task_stop`; none when `task_output` already observed the end.
   The orphan retry calls `loop` when there is no answering assistant.
4. **task_stop kills only its tree.** The task spawns a child and a grandchild that write their
   pids. A sibling process that the test itself spawned stays alive. After stop, the task's pids
   are gone and the sibling is alive (Windows via `taskkill /T`, POSIX via the process group).
5. **Caps.** `max_concurrent` (the n+1th call does not yield and reports the cap),
   `max_lifetime_ms` (becomes `timed_out`, killed, woken), and `max_output_bytes` (file capped,
   tail still advances).
6. **Cleanup on abort.** Cancel the owning session through `SessionRunState.cancel` / the
   BackgroundJob cancel for the parent session: status `cancelled`, tree dead, no wake. Also
   `Session.remove`.
7. **Short command unchanged.** Output and metadata equality for a sub-threshold command,
   flag on vs off. Explicit `timeout` below the yield threshold still gives today's kill message.
   Abort before yield gives the same result as today.

Runs: `timeout 300 bun test test/tool/shell*.test.ts test/session/prompt.test.ts
test/session/tools.test.ts` several times, plus `timeout 300 bun run typecheck`. Free memory is
checked before each heavy run.

## 10. Files

| file | change |
|---|---|
| `src/tool/shell.ts` | spawn inside a job, race with yield, receipt; the old path when the flag is off |
| `src/tool/shell/tasks.ts` | new: the registry, output file, caps, wake |
| `src/tool/shell/task-tools.ts` | new: `task_output`, `task_stop` |
| `src/tool/shell/prompt.ts`, `shell.txt` | the `background` parameter and text about yielding and not polling |
| `src/tool/registry.ts` | register the two tools behind the flag |
| `core/src/config/experimental.ts` | `background_shell` schema |
| `src/effect/app-runtime.ts`, `server/.../server.ts` | add the `ShellTasks.node` layer |
| `src/tool/task.ts` | `TaskPromptOps.loop?` (the optional member) |
| `src/session/prompt.ts` | **one line** in `ops()` (section 5) |
