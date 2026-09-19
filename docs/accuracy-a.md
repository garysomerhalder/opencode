# Accuracy A: autonomy prompt, runaway guard, todo completion

Status: design, waiting for review. Techniques adapted from MiniMax Code (MIT). Nothing is copied
verbatim; ported files carry a `MiniMax Code (MIT)` credit header.

Motivation: on FrontierHarness Eval (30 tasks, same Kimi K3 model) minimax-code scored 76.7% and
OpenCode 50.0%. The model is the same, so the gap is in the harness. Three harness gaps are in scope:

1. The Kimi prompt tells the model to ask for clarification and confirmation. Headless runs cannot
   answer, so the model stops early.
2. Doom-loop detection only looks at parts of the current assistant message, but the loop makes a new
   assistant message per step (`prompt.ts` runLoop), so repeats across steps are never seen. When it
   does fire, it raises a `doom_loop` permission ask, which `opencode run` auto-rejects.
3. The loop exits on any `stop`, even when todos are still pending or in progress.

## Flags

All flags live under `experimental.accuracy` in `opencode.json`. Every flag defaults to ON; set it to
`false` to get today's behaviour back.

```jsonc
{
  "experimental": {
    "accuracy": {
      "autonomy_prompt": true,        // A
      "runaway_guard": true,          // B
      "runaway_guard_threshold": 3,   // B: repeats before the reminder (min 2)
      "todo_reminder": true,          // C
      "todo_reminder_interval": 5     // C: steps between periodic reminders (min 1)
    }
  }
}
```

The schema goes into `packages/core/src/v1/config/config.ts`, next to `continue_loop_on_deny`, with
`description` annotations. A small `session/accuracy.ts` helper resolves the effective values and
applies the defaults.

## Files touched

| File | Change |
|---|---|
| `packages/core/src/v1/config/config.ts` | `experimental.accuracy` schema |
| `packages/opencode/src/session/accuracy.ts` (new) | Reads the flags with defaults; detects headless mode |
| `packages/opencode/src/session/prompt/autonomy.txt` (new) | Shared autonomy section (interactive variant) |
| `packages/opencode/src/session/prompt/autonomy-headless.txt` (new) | Headless addendum |
| `packages/opencode/src/session/prompt/kimi.txt` | Softens the lines that force asking; keeps the git safety rule |
| `packages/opencode/src/session/runaway-guard.ts` (new, MiniMax credit) | Pure fingerprint and streak detector, plus the reminder text |
| `packages/opencode/src/session/todo-reminder.ts` (new, MiniMax credit) | Todo summary, interval gate, reminder text |
| `packages/opencode/src/session/processor.ts` | Feeds the guard at step end; skips the `doom_loop` ask when the guard is on |
| `packages/opencode/src/session/prompt.ts` | Injects the autonomy system section; persists reminders; continues once on stop with open todos |
| `packages/opencode/src/tool/todowrite.txt` | "Updating the list does not complete the work" plus a reconcile-before-final rule |
| tests (listed below) | New and extended tests |

`tool/shell.ts` and the task registry belong to the parallel `accuracy-b` work. This branch does not
touch them.

## A. Autonomy prompt

A shared section goes into every request's system prompt for every provider (Anthropic, GPT, Gemini,
Kimi, default and the rest). It is appended in `prompt.ts` next to the env, instructions, MCP and
skills blocks. This avoids editing ten provider files, and it also covers agents that have their own
`prompt`. The section tells the model to:

- finish everything that does not depend on the user's answer first, and settle discoverable
  uncertainty from files, tools or a safe reversible default;
- ask only about decisions that materially change the outcome, or when going ahead would be unsafe;
- turn explicit requirements into acceptance checks, run them as soon as something is runnable, and
  run them again after the final edit;
- verify before declaring completion;
- write a final report that says what succeeded, what failed, what was skipped and what is still
  unverified;
- base conclusions on evidence, because not recognising something does not prove it doesn't exist.

**Interactive vs headless.** The deciding signal is whether the model can reach a human through the
tool set for that step. If the `question` tool is present in the resolved tools, the run is
interactive. If it is absent, the run is headless. The `question` tool is missing in these cases:

- `opencode run` without `--interactive`, which denies `question`, `plan_enter` and `plan_exit`;
- clients other than app, cli and desktop, which the tool registry gates out;
- subagents, which run without the tool.

The signal is observable and needs no new configuration. It also matches reality: a model that has no
question tool cannot ask anyway.

- Interactive: the shared section only. The model may still ask through the `question` tool for
  outcome-changing decisions. Safety confirmations stay in place, such as the kimi.txt rule to
  confirm every git mutation and to confirm installs outside the working directory.
- Headless: the shared section plus a headless addendum. It says that nobody can answer questions
  during the run, so the model should not stop to ask. It should pick the safest reasonable default
  and record the assumption in the final report. Safety rules still hold, but a step that needs
  confirmation is skipped rather than asked about. For example, the model makes no destructive git
  mutation unless the task explicitly asks for it, and it reports what it skipped. Headless runs never
  weaken the safety rules. They only replace "ask" with "skip and report".

kimi.txt changes:

- "Ask the user for clarification if there is anything unclear" and "ask for clarification before
  you start if needed" become "resolve ambiguity from context first; ask only when the answer
  materially changes the outcome".
- The git-mutation confirmation line and the outside-cwd install confirmation stay unchanged. The
  headless addendum turns them into "do not do it, report it" instead of "ask".

When the flag is off, no section is added and kimi.txt stays as it is today. The kimi.txt edit is a
content change, so the flag cannot restore the old wording. The new wording is still correct in
interactive runs.

## B. Runaway guard

`runaway-guard.ts` is a pure module (no Effect services), so it is easy to unit test.

- **Scope.** A `RunawayGuard.State` is created once per `runLoop` invocation, which is one user turn.
  It is passed to `processor.create({ ..., guard })`.
- **Feed.** At the processor's step end, after the stream has drained and `cleanup()` has settled
  every tool part, the processor builds a step view from the assistant message's tool parts and calls
  `RunawayGuard.observe(state, view)`. Doing this after `cleanup` rather than at the `step-finish`
  event ensures every tool result is final. Provider-executed tools and tools rejected by permission
  are excluded, the same way MiniMax excludes permission-blocked calls.
- **Fingerprints per step:**
  - action key: `tool + stable-stringified input`;
  - result key: `tool + hash(normalised output, bounded)`, for successful results only;
  - error-family key: `tool + category`. The category is one of timeout, rate_limit, network, auth,
    permission, not_found, invalid_argument or process_exit, found by regex on the error text, with a
    fallback to the bounded normalised text.
- **Streaks.** For each key kind, `count = previous[key] + occurrences in this step`. Keys that are
  absent from the current step are dropped, so only consecutive steps count. This fixes the
  cross-message gap.
- **Reminder.** When any key reaches the threshold (default 3), and no reminder has been sent yet in
  this turn, `observe` returns one reminder. Priority: same error family, then exact action repeat,
  then exact result repeat. The wording is paraphrased: don't repeat the same thing unchanged; inspect
  what you already have; change one variable or strategy with a concrete expected change, or report
  the blocker; repetition does not prove the task is done or impossible. It also says the reminder is
  temporary and applies only to this turn.
- **Delivery.** `handle.reminder` exposes the reminder. `prompt.ts` persists it as a synthetic user
  message before the next step. That message has all parts `synthetic: true` and
  `metadata: { accuracy_reminder: "runaway_guard" }`, and it copies agent, model, format, system and
  tools from the last real user message. This follows the existing precedents: the subtask "Summarize
  the task tool output" message and the compaction continue message.
- **Never blocks.** With the flag on, the `doom_loop` `permission.ask` in `processor.ts` is skipped.
  The guard never rejects or aborts a tool, and it fails open: any error inside the guard is caught and
  ignored. With the flag off, today's `doom_loop` ask comes back.

## C. Todo completion

`todo-reminder.ts` holds the logic: `summarize(todos)` returns total, active, completed and cancelled
counts, where active means pending or in_progress. It also holds `shouldRemind(state, step, interval)`
and the reminder text: you still have N active todos; continue the unfinished work, or mark finished
items completed and obsolete ones cancelled; don't present the task as complete while items are
active.

- **Periodic reminder.** At the start of each loop step, when the loop is continuing after tool calls,
  `prompt.ts` reads `Todo.get(sessionID)`. If there are active todos, and at least `interval` steps
  have passed since the last todo reminder in this turn (counted from the first step), it persists one
  synthetic user message with `metadata: { accuracy_reminder: "todo_periodic" }`.
- **Continue once on stop.** At the loop-exit branch, where the last assistant finished with `stop`,
  has no tool calls, and its parent is the last user message, the loop checks for active todos. If
  there are any, and the flag is on, and none of the exclusions below applies, it persists a synthetic
  user message with `metadata: { accuracy_reminder: "todo_continue" }` and continues. It does this
  once per turn. The exclusions are:
  - the message has an error or was aborted;
  - `finish` is not `stop`, such as length or content-filter;
  - the output is structured JSON;
  - the continue has already been used this turn (a local flag);
  - the last user message is already a `todo_continue` message. This durable guard survives a loop
    restart.

  If the model stops again, the loop exits normally. It can never loop forever.
- **Reminders don't pile up.** If the guard and the periodic todo reminder fire in the same step, they
  are merged into one synthetic message.
- **todowrite.txt** gains two rules: "Updating the list does not complete the work" and "Before your
  final response, reconcile statuses with the actual work."

## Tests (test-first: red, then green)

Style: `it.instance` with the `TestLLMServer` scripted mock, following `test/session/prompt.test.ts`
and `processor-effect.test.ts`.

- `test/session/runaway-guard.test.ts` (unit):
  - three identical actions in consecutive steps give one reminder;
  - a non-consecutive repeat gives none;
  - the same error family across different inputs triggers;
  - one reminder per turn at most;
  - permission-rejected calls are excluded;
  - the threshold is configurable.
- `test/session/todo-reminder.test.ts` (unit): summary counts, the interval gate, and no reminder
  when every item is terminal.
- `test/session/accuracy-loop.test.ts` (integration, mock LLM):
  - B: the mock issues the same tool call on three steps, then stops. Expect exactly one synthetic
    `runaway_guard` user message, no `permission.asked` event, the tool still executed every time,
    and the reminder text in the 4th LLM request body.
  - B off: no reminder message.
  - C continue: the mock calls todowrite with pending items, then stops. Expect one `todo_continue`
    synthetic message and a second LLM call. When it stops again, the loop exits with no third
    reminder.
  - C periodic: the mock issues 5 tool steps with an active todo. Expect a `todo_periodic` reminder in
    the 6th request.
  - C off: the loop exits on the first stop.
- `test/session/system.test.ts` / prompt test (A):
  - the autonomy section appears in the request system prompt for a non-Kimi model;
  - the headless addendum appears when `question` is denied in session permission and is absent when
    the question tool is available;
  - the flag off removes both.
- `test/agent/agent.test.ts` keeps its `doom_loop` default-permission assertion. The permission still
  exists; only the processor stops asking it when the guard is on.

Run the relevant files several times with `timeout 300`, plus `bun run typecheck` in
`packages/opencode`.

## Uncertainty and risks

- Synthetic user messages mid-turn change `lastUser`. They copy every user field, so model, agent,
  format and system stay the same. The desktop goal loop and UI renderers need to tolerate all-synthetic
  user messages the way they already do for the compaction continue message. I'll check whether the TUI
  and app hide them.
- The generated SDK types (`packages/sdk/js/**/types.gen.ts`) will not include the new config keys
  unless they are regenerated. I will regenerate them if the repo script runs cleanly in the worktree.
  If it doesn't, I'll leave them and report it.
- Headless detection by the presence of the `question` tool treats clients such as ACP as headless,
  because their question tool is gated off. That is intended: those clients cannot answer a question.
