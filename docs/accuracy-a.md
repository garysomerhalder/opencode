# Accuracy A: autonomy prompt, runaway guard, todo completion

Status: implemented on `feat/accuracy-prompt-loop-todo`. Techniques adapted from MiniMax Code (MIT). Nothing is copied
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

All flags live under `experimental.accuracy` in `opencode.json`. The three feature flags default to
ON; set one to `false` to get today's behaviour back. The one opt-in flag defaults to OFF.

```jsonc
{
  "experimental": {
    "accuracy": {
      "autonomy_prompt": true,                   // A
      "autonomy_when_no_question_tool": false,   // A: opt-in second autonomy signal
      "runaway_guard": true,                     // B
      "runaway_guard_threshold": 3,              // B: repeats before the reminder (min 2)
      "todo_reminder": true,                     // C
      "todo_reminder_interval": 5                // C: steps between periodic reminders (min 1)
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
| `packages/schema/src/v1/session.ts` | `ReminderPart` (the harness-note part type) and `autonomous?: boolean` on the user message |
| `packages/opencode/src/session/harness-note.ts` (new) | Builds and recognises harness notes; shared with the parallel wake work |
| `packages/opencode/src/session/message-v2.ts` | A `reminder` part becomes user-role text for the model |
| `packages/opencode/src/session/revert.ts`, `compaction.ts`, `reminders.ts` | Skip notes when picking the user message or counting turns |
| `packages/desktop/src/main/goal-loop.ts` | Sends `autonomous: true`; treats harness notes as part of the running turn |
| `packages/tui/src/routes/session/index.tsx` | Renders a harness note as a system divider, not a user bubble |
| `packages/session-ui/src/components/message-part.tsx`, `packages/ui/src/i18n/en.ts` | Same for the app, with the `ui.messagePart.harnessReminder` label |
| `packages/app/src/utils/prompt.ts`, `pages/session/use-session-commands.tsx` | `isHarnessNote`; undo and redo skip notes |
| `packages/tui/src/routes/session/harness-note.ts` (new), `index.tsx` | Same for the TUI, plus the system-note divider |
| `packages/sdk/js/src/v2/gen/{types,sdk}.gen.ts` | Regenerated: `ReminderPart`, `autonomous` on prompt/prompt_async, `experimental.accuracy` on config |
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

**Interactive vs autonomous.** One signal by default, a second on request:

1. **The caller says so** (default). `autonomous: true` on `prompt` and `prompt_async` (persisted on
   the user message as `SessionV1.User.autonomous`, and copied onto every harness note so it survives
   the rest of the turn). The desktop goal loop sets it on every prompt it sends: those turns run
   inside the desktop client, which does have a question tool, but nobody is there to answer it.
2. **No question tool for this step** — only when `autonomy_when_no_question_tool` is on. The check
   mirrors the filtering `llm/request.ts` does just before the call: the tool has to be registered for
   the client, allowed by the agent and session permissions, and not turned off on the message. It is
   missing for `opencode run` without `--interactive` (which denies `question`, `plan_enter` and
   `plan_exit`), for clients other than app, cli and desktop, and for subagents.

Signal 2 is opt-in because a missing tool does not mean a missing human: someone who denies the
question tool to stop being interrupted is still at the keyboard, and telling them "nobody is
watching this run, never stop to ask" would be a lie the harness told itself. Turn it on for scripted
fleets, where nothing can answer.

- Interactive: the shared section only. The model may still ask through the `question` tool for
  outcome-changing decisions. Safety confirmations stay in place, such as the kimi.txt rule to
  confirm every git mutation and to confirm installs outside the working directory.
- Autonomous: the shared section plus the headless addendum. It says that nobody can answer questions
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
  `RunawayGuard.observe(state, toolParts)`. Doing this after `cleanup` rather than at the `step-finish`
  event ensures every tool result is final. Provider-executed tools and tools rejected by permission
  are excluded, the same way MiniMax excludes permission-blocked calls.
- **Fingerprints per step:**
  - action key: `tool + stable-stringified input`;
  - result key: `tool + hash(normalised output, bounded)`, for successful results only;
  - error-family key: `tool + category`. The category is one of timeout, rate_limit, network, auth,
    permission, not_found, invalid_argument, process_exit or aborted, found by regex on the error
    text. Anything unmatched falls into the literal bucket `other`. The error text itself never
    enters a key: the key is what the reminder and the log record are built from, and an error
    message can carry a secret.
- **Streaks.** For each key kind, `count = previous[key] + occurrences in this step`, and the
  per-step figure counts occurrences rather than steps: three identical calls inside one assistant
  message count as three. That is what makes the guard subsume the `doom_loop` ask it replaces, which
  only ever saw repeats inside a single message. Keys absent from the current step are dropped, so
  streaks only survive across consecutive steps — the half the old detector could not see.
- **Reminder.** When any key reaches the threshold (default 3), and no reminder has been sent yet in
  this turn, `observe` returns one reminder. Priority: same error family, then exact action repeat,
  then exact result repeat. The wording is paraphrased: don't repeat the same thing unchanged; inspect
  what you already have; change one variable or strategy with a concrete expected change, or report
  the blocker; repetition does not prove the task is done or impossible. It also says the reminder is
  temporary and applies only to this turn.
- **Delivery.** `handle.reminder` exposes the reminder. `prompt.ts` persists it before the next step
  as a harness note: a user message whose only part is a `reminder` part of kind `runaway_guard`
  (see "Harness notes and turn tracking" below).
- **Never blocks, and it subsumes what it replaces.** With the flag on, the `doom_loop`
  `permission.ask` in `processor.ts` is skipped. That ask fired on three identical calls inside one
  assistant message, and headless runs auto-reject it, so it ended the turn instead of steering it.
  The guard sees that case through per-occurrence counting and answers it with a reminder. It never
  rejects or aborts a tool, and it fails open: any error inside the guard is caught and ignored. With
  the flag off, the `doom_loop` ask comes back unchanged.

## C. Todo completion

`todo-reminder.ts` holds the logic: `summarize(todos)` returns total, active, completed and cancelled
counts, where active means pending or in_progress. It also holds `periodic(state, summary, step)` and `onStop(state, summary)`
and the reminder text: you still have N active todos; continue the unfinished work, or mark finished
items completed and obsolete ones cancelled; don't present the task as complete while items are
active.

- **Periodic reminder.** At the end of each loop step, when the loop is continuing after tool calls,
  `prompt.ts` reads `Todo.get(sessionID)`. If there are active todos, and at least `interval` steps
  have passed since the last todo reminder in this turn (counted from the first step), it persists one
  harness note of kind `todo_periodic`.
- **Continue once on stop.** At the loop-exit branch, where the last assistant finished with `stop`,
  has no tool calls, and its parent is the last user message, the loop checks for active todos. If
  there are any, and the flag is on, and none of the exclusions below applies, it persists a
  harness note of kind `todo_continue` and continues. It does this
  once per turn. The exclusions are:
  - the message has an error or was aborted;
  - `finish` is not `stop`, such as length or content-filter;
  - the output is structured JSON;
  - the continue has already been used this turn (a local flag);
  - the last user message is already a `todo_continue` message. This durable guard survives a loop
    restart.

  If the model stops again, the loop exits normally. It can never loop forever.
- **Reminders don't pile up.** If the guard and the periodic todo reminder fire in the same step, they
  are merged into one note.
- **todowrite.txt** gains two rules: "Updating the list does not complete the work" and "Before your
  final response, reconcile statuses with the actual work."

## Harness notes and turn tracking

A harness note is a user message whose parts are `reminder` parts — a part type of its own
(`ReminderPart`: `kind`, `text`, optional `label`), not a text part with a flag on it. Every other
field is copied from the turn's user message (agent, model, variant, format, system, tools,
`autonomous`), so the step that reads the note runs with the settings of the prompt it belongs to.
`session/harness-note.ts` builds them, and the background-task wake on the parallel branch builds its
message through the same helper.

An earlier draft of this note claimed the compaction "continue" message as precedent for a synthetic
*text* part. That was wrong, and it was load-bearing: `SessionCompaction.create` writes a part of type
`compaction`, which is exactly why compaction never caused this class of bug. A flag on a text part is
invisible to every consumer that switches on part type, so two branches independently broke the same
four consumers while believing they were following precedent.

With a part type, most consumers need nothing at all — they already ignore parts they do not handle:

- **Model conversion** (`message-v2.ts`) gets one arm: a `reminder` part becomes user-role text, which
  is how the model reads it.
- **`opencode run` and ACP clients** need no change. `session-data.ts` and `acp/event.ts` only handle
  text, file and reasoning parts, so a reminder is never replayed as something the user said.
- **Renderers** get one arm each: the TUI and the app show a note as a centred system divider (labelled
  from `part.label`), instead of the empty user bubble a text-only reader would produce.

What still needs to know about notes is anything that picks *a user message*, because the carrier is
still user-role:

- **The loop** (`prompt.ts`): the `@agent` exemption (`bypassAgentCheck`) is read from the last real
  user message, so a reminder mid-turn cannot change which tools the task gate allows. The "already
  continued" guard looks the turn's user message up by `lastUser.id` rather than scanning `msgs`,
  which comes from `filterCompacted` and is reordered for model consumption.

  The same reordering is why `lastRealUser` compares messages with `MessageV2.isAfter` instead of
  walking the array backwards. In a compacted session the newest user message sits at index 0, so
  `findLast` would return a prompt from the retained tail — and in a long session that compacts, an
  `@agent` turn would be granted or refused its exemption based on an earlier prompt. The ordering
  lives in the helper rather than at the call sites, because the helper is shared with the
  background-task wake and the next caller will not know the array is reordered.
- **Undo and redo**: the revert boundary comes from the last real user message (`revert.ts`), so a
  revert cannot stop at a reminder and leave the user's prompt and its edits in place. The TUI's
  `/undo` and `/redo` and the app's `userMessages()` skip notes for the same reason.
- **Compaction pruning** does not count a note as a turn, and **plan reminders** (`reminders.ts`)
  attach to the user's own message.
- **Desktop goal loop** (`goal-loop.ts`): `isHarnessNote()` tags each parsed message. `turnText()`
  now starts after the last *real* user message, so a turn the server continued after its own
  reminder still reads as one turn — including a completion marker the model emitted just before the
  reminder landed. The idle-poll check that waits for an admitted-but-unrun user prompt skips harness
  notes too, so a trailing note is never mistaken for a prompt that failed to start.
- **TUI** (`routes/session/index.tsx`) and **app** (`session-ui/message-part.tsx`): a harness note
  renders as a centred system divider ("Runaway guard reminder" / "Task completion reminder" in the
  TUI, `ui.messagePart.harnessReminder` in the app) instead of an empty user bubble.
- **Secrets**: fingerprints are SHA-256 hashes truncated to 16 hex characters. Raw tool output never
  enters a reminder, a log line or the guard's state — the log record is
  `{ kind, tool, occurrences, fingerprint }`, and a test asserts that a secret printed by a tool
  appears in none of them.

## Tests

Style: `it.instance` with the `TestLLMServer` scripted mock, following `test/session/prompt.test.ts`.
Each feature was taken red first, then green.

- `packages/opencode/test/session/runaway-guard.test.ts` (unit, 11): three identical actions in a row
  give one reminder; **three identical calls inside one step give one immediately** (the case the
  `doom_loop` ask used to catch); two in one step plus one in the next reach the threshold; an
  interrupted repeat gives none; the same error family across different inputs triggers; identical
  results with different inputs trigger; permission-rejected and provider-executed calls are ignored;
  the threshold is configurable; a repeated action's reminder and log record contain no raw output;
  **an uncategorised error's reminder and log record contain neither its text nor the secret in it**;
  a step with no tool calls clears the streak.
- `packages/opencode/test/session/todo-reminder.test.ts` (unit, 5): summary counts, the interval
  gate, one stop reminder per turn, nothing when every item is terminal.
- `packages/opencode/test/session/harness-note.test.ts` (unit, 6): a `reminder` part makes a note and
  a synthetic text part does not (a compaction-continue message is not a note); `kind` reporting;
  `lastRealUser` skips notes so an `@agent` turn keeps its exemption; it follows message order rather
  than array order on a compacted list (red against the `findLast` version, which returned the
  retained tail's prompt); nothing when the user has not spoken; `build` carries the turn's agent,
  model, system and `autonomous` onto the note.
- `packages/opencode/test/session/message-v2.test.ts` (+1): a reminder part reaches the model as
  user-role text — without this arm the model never sees the reminder at all.
- `packages/opencode/test/session/accuracy-loop.test.ts` (integration, 10): the autonomy section is
  present by default without the headless part; `autonomous: true` adds the headless part even with a
  question tool available; denying `question` does **not** by itself make a turn autonomous; opting
  in makes it; the flag off removes both; a repeated failing tool call injects exactly one runaway
  reminder, it reaches the next request, and no permission is left pending; the guard off injects
  none; stopping with open todos continues exactly once (3 LLM calls, not a loop); the todo flag off
  exits at the first stop; a periodic reminder lands mid-run.
- `packages/opencode/test/session/revert-compact.test.ts` (+1): reverting a turn that got a reminder
  lands on the user's own message, not the note.
- `packages/tui/test/harness-note.test.ts` (unit, 3) and `packages/app/src/utils/prompt.test.ts`
  (+2): note recognition, `/undo` stepping back past a note, `/redo` stepping forward past one, and
  the empty prompt a note would otherwise restore.
- `packages/desktop/src/main/goal-loop.test.ts` (+4): `isHarnessNote` recognition; a mid-turn
  reminder does not hide the completion marker; a trailing note is not mistaken for an unrun prompt;
  goal-loop prompts carry `autonomous: true`. The two turn-tracking tests were confirmed red against
  the unpatched loop.

Not testable here: the intra-step case has no integration-level test because the scripted LLM streams
every tool call into slot `index: 0`, so one reply with several calls arrives merged into one call. A
multi-call reply hangs that harness with the guard on and off alike, so it would prove nothing either
way; the case is covered at unit level, where the input is exactly a step holding three tool parts.

Typecheck: `packages/opencode`, `core`, `schema`, `desktop`, `tui`, `session-ui` all clean.

## Scope: this is the V1 loop

Everything here hooks `SessionPrompt.runLoop` (the V1 session loop) and the V1 message/part shapes.
The V2 session engine in `packages/core/src/session/runner` drives its own loop and builds its
messages from `session.next.*` events, so none of this reaches it. When V2 becomes the default it
needs the same three hooks — the autonomy section in its system prompt, the guard at its step end,
and the todo reminder at its turn boundary — and its own reminder carrier.

## Uncertainty and risks

- Harness notes change `lastUser` for the rest of the turn. Every user field is copied over, so agent,
  model, format, system and `autonomous` are preserved, and the loop's exit condition
  (`assistant.parentID === lastUser.id`) still holds. The part type makes a new consumer's mistake
  visible — it has to name `reminder` to be wrong about it — but a *message*-level reader can still
  pick a note without noticing, which is what the four fixed consumers all did.
- `packages/opencode/test/session/prompt.test.ts` has 4 failing tests on this machine both with and
  without these changes (shell and cancel timing on Windows); the failing names vary between runs.
- `packages/opencode/test/session/compaction.test.ts`, run in a clean `dev` worktree and on this
  branch back to back: dev 45 pass / 1 skip / 10 fail, branch 44 / 1 / 11. Every failure on both sides
  is a 60s timeout, not an assertion; all ten of dev's failures appear on the branch; and the one
  extra ("does not leave a summary assistant when aborted before processor setup") also fails on clean
  dev when run alone. The machine is the cause — 35 bun/node processes, ~90% CPU, and a bare `git
  init`+commit taking 2.7s — and the same conditions make the `revert-compact.test.ts` suite time out
  wholesale, including tests this branch never touches.
- Running `runaway-guard.test.ts` and `todo-reminder.test.ts` in one `bun test` invocation sometimes
  fails the preload's `afterAll` temp-dir cleanup on Windows (EBUSY). Each file passes on its own and
  the assertions pass either way.
- SDK regeneration rewrites every generated file with LF endings; only the two files with real
  content changes are kept in the commit.
