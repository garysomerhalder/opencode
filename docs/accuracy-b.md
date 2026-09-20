# Accuracy B: background long commands for the shell tool

Status: implemented on `feat/accuracy-background-shell` and shipped **off by default**. This
document describes what is built, not a proposal.

It is opt-in for its first release because nothing in the UI shows a live background process
yet: a user who presses escape has no list, no indicator and no stop button for trees that
keep running. Two follow-ups turn it on by default — a UI affordance for running tasks, and a
notice when the idle reaper kills something. Until then `experimental.background_shell` is
how you get it, and the server endpoints in section 4 are the only way to see and stop tasks.

Model: MiniMax Code (MIT). Its bash tool soft-yields a foreground command to a managed
background task after 15 s without restarting it, hands back a receipt, exposes
`task_output` / `task_stop`, and wakes the owning conversation when the task ends. We ported
the model, not the code. Files that paraphrase it closely carry a `MiniMax Code (MIT)` note.

## 1. Why

`packages/opencode/src/tool/shell.ts` had a flat 2-minute default and killed the command at
the deadline with "retry with a larger timeout". On Terminal-Bench style tasks (compiles,
installs, test suites, servers) that means lost work, a rerun from scratch, and a model that
guesses timeouts. With a soft yield the process is never restarted, the model gets control
back in 15 s, and it can do something else while it waits.

## 2. Lifecycle

```
shell call ──permission check (unchanged)──> spawned inside the task registry's instance scope
      │
      ├─ exits before yield_after_ms ──> the same result as today
      ├─ explicit `timeout` hits first ──> killed, the same message as today
      ├─ ctx.abort before the yield ───> killed, "User aborted the command" (as today)
      └─ yield_after_ms reached ───────> PROMOTED: the tool returns a receipt and the same
                                         process keeps running as a background task
                                                   │
       running ── shell_stop ──────────────────> stopped   (no wake: the agent asked for it)
       running ── explicit timeout / 60 min cap ─> timed_out (wake)
       running ── session idle 30 min, no reads ─> timed_out, reason "idle" (no wake)
       running ── session deleted / shutdown ────> cancelled (no wake)
       running ── process exits ─────────────────> exited(code) (wake)
```

- The process is spawned once. The fiber that owns the child handle and the output reader is
  forked into the `ShellTasks` instance scope, so it outlives the tool call **and outlives a
  turn abort**: pressing escape must not kill a build or a dev server. The foreground call
  races the task's exit against `yield_after_ms`, `ctx.abort` and the explicit timeout.
- A turn abort *before* the yield still kills the command, exactly as today.
- Short commands keep today's behavior: the same output text and the same metadata
  (`output`, `exit`, `truncated`, `outputPath`), the same truncation.
- Timeout semantics with the flag on: an explicit `timeout` is still a hard deadline for the
  process, foreground or promoted. With no explicit timeout the old 2-minute kill is gone: the
  command yields and is bounded by `max_lifetime_ms`. With the flag off, nothing changes, and
  `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` keeps its old meaning.
- `background: true` starts in the background immediately (servers, watchers). It goes through
  the same permission check.
- At the concurrency cap a foreground command does not yield: it keeps today's foreground
  behavior and the timeout message says the cap was hit and to stop a task with `shell_stop`.
  A `background: true` call has no foreground behavior to fall back to, so it is refused right
  away rather than being held for the full timeout and then killed.
- A command that cannot be started at all (missing shell, unreachable working directory,
  EACCES) raises a tool error, the way it did before this change. It is never reported as a
  command that ran and printed nothing.

### Receipt (the tool result on a yield)

```
<shell_background task_id="shl_…" status="running" elapsed_ms="15012">
Still running, so it moved to a background task. The SAME process keeps running; it was not
restarted and must not be rerun.
You will be told automatically when it finishes, with the exit code and output tail. Do not
poll in a loop; do other useful work.
Read new output with shell_output({ task_id: "shl_…" }) and stop it with shell_stop({ … }).
Output so far is also being written to: <path>
Output so far:
…
</shell_background>
```

The tool part's metadata keeps `output` (the 30k preview), sets `exit: null`, and adds
`background: { taskId, status }`.

## 3. Task registry

`src/tool/shell/tasks.ts`: the `ShellTasks` service, instance-scoped (`InstanceState`), one
entry per task:

| field | meaning |
|---|---|
| `id` | `shl_<ascending>` |
| `sessionID`, `messageID`, `callID` | the owner; every lookup is scoped to the session |
| `command`, `cwd`, `pid` | what runs |
| `status` | `running` \| `exited` \| `stopped` \| `timed_out` \| `cancelled` |
| `exitCode`, `startedAt`, `endedAt`, `reason` | how it ended |
| `bytes`, `fileBytes`, `file`, `outputCapped` | output capture |
| `background` | promoted (a foreground call in flight is not listed and not capped) |

Output capture matches the foreground path: a rolling window in memory (2 × `maxBytes`), the
30k preview, and a spill file once the buffer passes the truncation limit. Promotion always
spills, so a promoted task always has a file. The file lives in the existing truncation
directory with the existing `tool_` prefix, so the existing 7-day retention, the existing read
permission glob and the existing path handling apply unchanged. Writes are serialized through
one append queue, and a read flushes it before slicing the file, so a read never misses bytes
that were already captured. Past `max_output_bytes` the file stops growing; reads then serve
the live in-memory tail and say that the middle was dropped.

Redaction: the shell output path does not redact secrets today, and this change does not
either — it would alter what the model sees. Redacting logs and UI surfaces is a separate,
follow-up concern for both paths at once.

## 4. Tools

Registered in `tool/registry.ts` only when the flag is on, and hidden from any agent whose
`bash` permission is `deny` (reading or stopping a shell task is meaningless without a shell).

### `shell_output(task_id?, since?, wait_ms?)`

- With no `task_id`: lists this session's background tasks.
- Returns the new output since `since` (a byte offset) or since this session's cursor, plus
  status, exit code, duration and `next_offset`, bounded by the truncation limits.
- `wait_ms` (max 30 000) waits for new output or for the task to end. While it waits it pushes
  the rolling preview into this tool part once a second through `ctx.metadata({ output })`, so
  a long wait does not read as a frozen tool call and the desktop goal loop's progress signal
  keeps moving for a promoted build. Reaching the wait limit never stops the task.
- Polling discouragement, following MiniMax: the description says the finish arrives on its own,
  and after two reads that return nothing new the result says to stop polling and offers
  `wait_ms=30000`.
- A task id from another session reads as not found.

### `shell_stop(task_id)`

Stops that task and kills its process tree only. Idempotent on a finished task. It does not
wake the session, since the agent asked for it.

### Server endpoints (for a user, not the model)

- `GET /experimental/shell/task[?sessionID=…]` lists tasks.
- `POST /experimental/shell/task/stop[?sessionID=…]` stops all of them and kills their trees.

## 5. Wake: how a finish enters the session loop

On `exited`, or on `timed_out` from a deadline, the registry sends one synthetic message to the
owning session, batching finishes that land within 250 ms:

```
<background-shell-finished>
<task id="shl_…" status="exited" exit_code="0" duration_ms="…" command="…" />
Output tail:
…last 40 lines / 4 KB…
Full output: <path>
This is the result of a background shell task you started. Continue the work with it.
Read more with shell_output; do not rerun the command.
</background-shell-finished>
```

It is suppressed when the agent already read the finished task (`shell_output` saw the terminal
state), when the task was stopped on request, when it was cancelled, and when it was
idle-reaped — in those cases either the agent knows or nobody is waiting.

Transport (`src/tool/wake.ts`, shared with the background subagent in `tool/task.ts`):
`promptOps.prompt({ … noReply: true })` appends the message, then `promptOps.loop(sessionID)`
runs the session loop and the result is checked for an assistant message whose `parentID` is
the appended message; up to 3 attempts.

**The wake must not move the session.** The agent, model and variant are read from the session
row at wake time, not captured when the command started, and passed through so
`createUserMessage` sees no difference and calls no `setAgentModel`. Capturing them at start
time was a real bug: a user who ran a build under `build`, then switched to `plan`, would be
switched back to `build` — permissions included — by a message they never sent, and the switch
was written to the session row. The same read also preserves a non-default model variant,
which a missing `variant` would otherwise reset to `"default"` for every later turn.

Race analysis (`effect/runner.ts`, `SessionPrompt.runLoop`):

- **Idle session:** the message is appended and a new run starts.
- **Turn running:** `loop` joins the running run. The loop reads history only at the top of
  each step, so the message never lands mid-stream; the next step sees it unanswered and keeps
  going. History order stays valid (`U1, A1(tool calls), U2(synthetic), A2`).
- **The narrow window** — the message lands after the running loop's final history read but
  before the runner goes idle — is what the retry covers: the joined run returns an assistant
  that does not answer our message, so `loop` is called again and starts a fresh run whose
  top-of-loop check sees the unanswered message. The background subagent had this same latent
  bug and now shares the fix.

**The only session/\* change:** one line in `session/prompt.ts` `ops()` exposing `loop`, plus
the matching optional `loop?` on `TaskPromptOps` in `tool/task.ts`.

## 6. Caps and cleanup

Config (`experimental.background_shell`, **absent means off**; `true`/`false` is also accepted,
and writing the settings object is itself the opt-in unless it says `enabled: false`):

```jsonc
"experimental": { "background_shell": {
  "enabled": true,              // false, or no key at all = today's behavior exactly
  "yield_after_ms": 15000,
  "max_lifetime_ms": 3600000,   // 60 min, then timed_out (wakes the session)
  "max_concurrent": 8,          // promoted running tasks per instance
  "max_output_bytes": 33554432,
  "idle_reap_ms": 1800000,      // session idle this long with no reads, then killed
  "sweep_ms": 60000             // how often the lifetime and idle limits are checked
} }
```

What ends a task: `shell_stop`, the stop-all endpoint, an explicit `timeout`, the lifetime cap,
the idle reaper (the session is idle and nobody has read the task for `idle_reap_ms`), session
deletion (a `session.deleted` event; the listener only asks for the stop so it never blocks the
publisher), and instance shutdown (the instance-scope finalizer kills every running tree).
A turn abort deliberately does **not**. The registry is process-local: a server restart loses
the tasks, and their trees die with the instance scope.

## 7. Process trees: Windows and POSIX

Killing goes through `ChildProcessSpawner` (`core/src/cross-spawn-spawner.ts`), which the
foreground shell already used:

- **POSIX:** the shell is spawned with `detached: true`, so it leads a process group;
  `process.kill(-pid, SIGTERM)`, then SIGKILL after 3 s. Only our group is signalled.
- **Windows:** `taskkill /pid <pid> /T /F` kills the tree rooted at our shell pid only.
  Known limit: a grandchild that re-parents away (`start`, `Start-Process`, a service) escapes
  `/T`, exactly as it does for foreground commands today. Job Objects would need native code and
  are out of scope. Pid reuse is not a risk because we only kill while the handle is live.
- Killing a tree takes several seconds on Windows, which is why the tests allow for it.

## 8. Permissions

- The permission check is unchanged and happens once, before spawn, for foreground and
  `background: true` alike (`external_directory` plus the `bash` patterns). Promotion is not a
  new execution; it is the same approved process.
- `shell_output` only reads tasks the same session started; its file sits in the truncation
  directory, which `read` already allows.
- `shell_stop` can only terminate trees the same session started, so it asks for nothing. Both
  tools are hidden when the agent's `bash` permission is `deny`.

## 9. Tests

- `test/tool/shell-tasks.test.ts` (registry, 13 tests): promotion keeps the same pid and the
  output keeps flowing; incremental reads and the session cursor; the wake fires once with the
  exit code and tail and its message is answered; the wake runs the loop again when the first
  run answered something else, and gives up after three attempts; the wake carries the
  session's current agent, model and variant rather than the ones the command started under;
  a command that cannot be started is recorded as an error; no wake after a stop or after the
  agent read the end; stopping kills the task's own tree (parent and grandchild) and leaves
  another task alive; the concurrency cap refuses promotion; the lifetime cap terminates and
  wakes; the idle reaper terminates without waking; the output cap; session deletion cancels
  and cross-session lookups return nothing.
- `test/tool/shell-background.test.ts` (tool, 11 tests): a long command yields a receipt and the
  same process finishes it; the wake carries the output; no wake when the agent already read it;
  incremental reads, listing, the polling warning and `shell_stop`; a turn abort leaves a
  background task running; a turn abort before the yield still kills; an explicit timeout still
  kills with the old message; the foreground cap fallback says so and a `background: true` call
  at the cap is refused immediately; short commands are unchanged; the tool is off with no
  config key; with the flag off both the description and the timeout behavior are the old ones.
- `test/server/httpapi-experimental.test.ts` covers the two endpoints' routing, query shape and
  response schema. The served app builds its own service graph, so live task state is not
  visible from that test; the lifecycle is covered in the registry suite.
- The wake stub is a fake of the session prompt ops, so assertions about wake *delivery* are
  assertions about that fake. What it does prove is the branch the registry takes: how many
  prompts, with which agent, model and variant, and how many loops. The real
  `SessionPrompt.prompt`/`loop` pair is exercised by the existing session suites.
- `test/tool/shell.test.ts` is the regression guard and still passes. Two timeouts in it were
  raised to 30 s because killing a process tree on Windows takes longer than the old 15 s
  allowance — those tests already failed on `dev` on this machine.

Runs on this machine: `bun test --timeout 30000 test/tool/shell.test.ts
test/tool/shell-tasks.test.ts test/tool/shell-background.test.ts`, plus `bun run typecheck`.

## 10. Files

| file | change |
|---|---|
| `src/tool/shell.ts` | the managed run path: spawn in the registry, race the yield, receipt |
| `src/tool/shell/tasks.ts` | new: the registry, output capture, caps, reaper, wake |
| `src/tool/shell/tools.ts` | new: `shell_output`, `shell_stop` |
| `src/tool/wake.ts` | new: the synthetic wake message and the answered-or-retry loop |
| `src/tool/shell/prompt.ts` | the `background` parameter and the "Long commands" section |
| `src/tool/registry.ts` | registers the two tools behind the flag and hides them without a shell |
| `src/tool/task.ts` | background subagents use the shared wake (same missed-wake fix) |
| `src/session/prompt.ts` | one line: `loop` on the prompt ops |
| `core/src/v1/config/config.ts` | `experimental.background_shell` |
| `server/.../groups/experimental.ts`, `handlers/experimental.ts`, `httpapi/server.ts` | list and stop-all endpoints |
| `sdk/js/src/v2/gen/*` | regenerated for the two endpoints (`packages/client` does not cover this group) |

## 11. Open items

- **Harness notes need their own part type.** The wake is a `text` part with `synthetic: true`,
  which is invisible to consumers that switch on part type, exactly as `compaction` parts are
  visible to them. This is a shared problem with the accuracy-a branch and is being fixed once,
  in one helper, rather than twice.
- **No UI affordance yet** for a running background task: no list, no indicator, no stop
  button. This is why the flag ships off.
- **The idle reaper kills without notice** after 30 minutes of an idle session with no reads.
  It should say something when it does.
