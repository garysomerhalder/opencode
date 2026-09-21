# Accuracy E: goal mode with an independent read-only verifier

Status: **design only, not implemented.** Branch `docs/accuracy-c-design`. This is technique #7 in
`plans/legatus-harness/plan.md`: goal mode with an independent read-only verifier (PASS / FAIL /
PARTIAL, with missing evidence fed back to the worker). No code until the architect approves.

This builds on the desktop goal loop (`packages/desktop/src/main/goal-loop.ts`). It does not add a
second loop. The loop keeps driving the worker. The verifier replaces one line of it: the line that
believes the worker when it says it is done.

## 1. What happens today (evidence)

- **Done means "the worker said so".** The loop reads the latest turn's text, and if a line equals
  the completion marker it finishes as `completed` (`goal-loop.ts:631-634`). `completionReached` is a
  regex on the worker's own output (`:139-142`). Nothing checks the claim. The first prompt asks the
  worker to judge itself ("When the goal is fully achieved, reply with GOAL_COMPLETE",
  `:91-97`). This is the failure the autonomy prompt (accuracy A) can only discourage.
- **The loop is well built and should be reused.** It already handles a busy session that stops
  moving (`:531-593`), aborted and failed turns with backoff (`:635-676`), server outages (`:686-704`),
  context growth with a summarize before continuing (`:456-493`), prompts from other clients into the
  same session (`:404-410`, `:596-610`), harness notes inside a turn (`:207-232`), and an iteration cap
  (`:502-515`). Every one of those is needed while a verifier runs too.
- **There is exactly one loop in the app.** `active` is a single variable (`:301`), and `start` throws
  "a goal loop is already running" (`:737`). The persisted state is one key
  (`desktop/src/main/store-keys.ts:6-9`, `main/index.ts:332-352`). The UI note (`accuracy-ui.md` §1)
  deals with that. This note works with one loop or many.
- **No read-only agent exists.** `explore` is the closest, and it allows `bash`
  (`opencode/src/agent/agent.ts:196-218`), which can write anything. Worse, every native agent merges
  the user's config **last** (`Permission.merge(defaults, agentRules, user)`, e.g. `agent.ts:185-191`),
  and evaluation takes the **last** matching rule (`permission/index.ts:28-38`). A user config with
  `"edit": "allow"` therefore re-enables edits on any native agent, including one we call read-only.
  The session's own ruleset is merged after that at every call site (`session/tools.ts:87`,
  `session/llm.ts:149`, `session/llm/request.ts:211`, `tool/registry.ts:293`, `tool/code-mode.ts:209`,
  `session/system.ts:122`, `session/prompt.ts:365`, `:1353`), and `PATCH /session/:id` can append rules
  to it (`server/.../handlers/session.ts:197`).
- **What the server already gives us.** Child sessions (`POST /session` takes `parentID`, `agent` and
  `permission`: `session/session.ts:260-270`). Structured output with a JSON schema, a forced tool call
  and an error when the model does not comply (`session/prompt.ts:1325-1330`, `:1371-1385`,
  `:1409-1412`). A per-agent step cap (`agent.ts:54`, `prompt.ts:1255-1256`). A user-run shell command
  recorded in the session (`POST /session/:id/shell`, `groups/session.ts:98`). A workspace snapshot
  with a content hash (`opencode/src/snapshot/index.ts:39`, `track()`).

## 2. Design

### The loop's new branch

```
worker turn ends ──marker seen?──no──> continue (unchanged)
                         │ yes
                         ▼
             verify disabled? ──yes──> completed (unchanged)
                         │ no
                         ▼
  background tasks of the worker still running? ──yes──> phase "waiting-on-tasks", poll (bounded)
                         │ no
                         ▼
  nothing changed since the last FAIL/PARTIAL? ──yes──> feedback "no change since the last verdict", attempt++
                         │ no
                         ▼
     phase "verifying": run checks, run the verifier session, validate the verdict
                         │
          ┌──────────────┼──────────────────────┐
         PASS        FAIL / PARTIAL           error (timeout, invalid, tamper)
          │              │                           │
      completed     attempt++ ; bounds? ──hit──> failed        retry once ──again──> unverified
                         │ ok
                         ▼
             feedback prompt to the worker, iteration++ ──> back to the top
```

`GoalLoopState` (`packages/app/src/goal-loop/types.ts`) gains `phase` (`turn` | `waiting` |
`waiting-on-tasks` | `verifying`), `verify` (settings), `verifications` (the attempt count) and
`lastVerdict` (verdict, time, the verifier session id, the criteria with their evidence). The terminal
statuses gain `unverified`. A loop with verification on is never `completed` without a PASS.

The loop also writes `goal: { text, lastVerdict }` into the worker session's metadata
(`PATCH /session/:id`, the existing `metadata` field), so the server can put the goal line in the
compaction checkpoint (accuracy D).

### The verifier session

For each verification the loop:

1. Takes a workspace snapshot hash (`snapshot.track()`, through a small experimental endpoint).
2. Creates a **child session of the worker**: `POST /session { parentID: worker, agent: "verifier" }`.
   It shows up under the worker in session lists, like a subagent, so the evidence can be inspected.
3. Runs the **user-declared checks** in that child with `POST /session/:child/shell`, one per check.
   They are recorded as user-executed tool parts, with exit code and output. Output over budget is
   archived with a receipt (accuracy C).
4. Sends one prompt with `autonomous: true` that must end with a call to the `verdict` tool (below;
   it works like `StructuredOutput` with `toolChoice: "required"`, but validates before it accepts),
   containing:
   - the goal verbatim, and the acceptance criteria (the user's list if given; otherwise the verifier's
     first job is to derive testable criteria from the goal, and it must list them);
   - the host record from accuracy D (task statement, todo list with its age, running tasks, changed
     files);
   - the diff since the loop started (host-computed from the snapshot taken at `start`);
   - the worker's final report, **inside a block labeled as claims to check, not facts**;
   - the check results, by call id.
   It does **not** get the worker's history. That is what makes it independent: a separate session,
   a separate context, and no access to the worker's reasoning that would anchor it.
5. Waits for the child to go idle, with the same busy and progress watch the loop uses for the worker.
6. Reads the verdict, validated on the server (below).
7. Takes the snapshot hash again. If it changed, the verdict is **void** and the loop fails loudly
   (`failed`, "the workspace changed during verification"). That would mean the read-only enforcement
   has a hole, which is a bug to fix, not a condition to retry.

### Read-only: how it is enforced

Three layers. The first is the real one.

1. **A permission lock that is applied last, always.** A native hidden agent `verifier`
   (`mode: "subagent"`, `steps: 40`, `temperature` from config) with a fixed ruleset:

   ```ts
   const VERIFIER_LOCK = Permission.fromConfig({
     "*": "deny",                       // every tool, MCP and plugin tools included
     read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
     grep: "allow", glob: "allow", lsp: "allow",
     verdict: "allow",                  // the verdict tool, below
     external_directory: { "*": "deny", [Truncate.GLOB]: "allow" },  // archives only
   })
   ```

   Denied, by name, because they matter most: `edit`, `write`, `apply_patch`, `bash`, `task`
   (a subagent could edit), `todowrite`, `question`, `webfetch`, `websearch`, `skill`, `execute`
   (code mode, `tool/code-mode.ts:12`, which calls other tools), `shell_output`, `shell_stop`, every
   MCP tool. `lsp` stays allowed because all nine of its operations are lookups (`tool/lsp.ts:11-21`).

   The lock is not merged into the agent's rules the usual way, because the user's config and the
   session's rules come after that and would win (section 1). Instead, one helper,
   `Permission.effective(agent, sessionRules)`, replaces the `Permission.merge(agent.permission,
   session.permission)` call sites listed in section 1, and appends `VERIFIER_LOCK` **after** the
   session rules when `agent.name === "verifier"`. Last rule wins, so neither `opencode.json` nor
   a `PATCH` on the session nor a client passing `permission` at create time can loosen it. The same
   helper feeds `Permission.disabled`, so denied tools are not even offered to the model.
   Nothing is `ask`: a question with nobody to answer would hang the loop.
2. **No shell.** The verifier cannot run anything. Checks that need a command are declared by the
   user when starting the goal (`checks: string[]` on `GoalLoopStartInput`) and run by the loop in
   step 3, **before** the verifier starts. The worker cannot add, remove or change them. Their trust
   is the user's, the same as a command the user types.
3. **The snapshot comparison** in step 7, which catches anything the first two missed, including a
   tool that writes as a side effect.

### The verdict and its evidence

The verifier ends by calling a `verdict` tool (like `StructuredOutput`, registered only for the
`verifier` agent):

```ts
type Verdict = {
  verdict: "PASS" | "FAIL" | "PARTIAL"
  criteria: {
    id: string
    text: string
    status: "met" | "unmet" | "unknown"
    evidence: (
      | { kind: "file"; path: string; lines: [number, number]; quote: string }
      | { kind: "check"; callID: string; exit: number; excerpt: string }
      | { kind: "diff"; path: string; excerpt: string }
    )[]
  }[]
  missing: { criterion: string; need: string }[]   // what evidence would settle it
  todos?: { content: string; status: "met" | "unmet" | "obsolete" }[]
}
```

The tool **validates before it accepts** (`Verdict.validate(verdict, world)`, a pure function over a
file reader, the check records and the diff):

- A PASS needs every criterion `met` with at least one evidence item.
- A `file` quote must appear in that file within the cited lines, after whitespace normalization. A
  `check` must name a check call in this session with that exit code, and the excerpt must appear in
  its output. A `diff` excerpt must appear in the host diff.
- The verdict must agree with the criteria (no PASS with an `unmet`, no FAIL with everything `met`).

When validation fails, the tool returns the reasons to the verifier as a tool error, so it can fix the
citation (the tool is allowed 3 submissions). A PASS that is still unsupported after that is stored as
**PARTIAL**, with the unsupported criteria listed as missing evidence. A citation that does not check
out is never allowed to count as evidence.

### What happens on FAIL or PARTIAL

The loop sends the worker one prompt (the continue prompt for that iteration, in place of the plain
"continue"):

```
<verifier-verdict verdict="PARTIAL" attempt="1 of 3" session="<verifier session id>">
An independent read-only check of your work did not confirm the goal.
Unmet or unproven:
  - C2 "tests pass": check `bun test` exited 1 (call_…): "3 fail"
  - C4 "README documents the flag": no evidence found; need a section naming `--budget`
Met: C1 (src/tool/truncate.ts:88-121), C3 (check call_… exited 0)
</verifier-verdict>
Fix what is unmet, produce the missing evidence, and reply with GOAL_COMPLETE only when you have.
These are findings to check, not orders: if you think one is wrong, show evidence for why.
```

What goes back is the criteria that are unmet or unproven, each with its evidence or with what
evidence is needed, plus the met ones by id (so the worker does not redo them). The verifier's
reasoning text does not go back, only its structured findings.

### Bounds: why it cannot loop forever

- `max_verifications` (default 3): each FAIL or PARTIAL uses one. When they run out, the loop ends as
  `failed` with the last verdict's missing list as the reason.
- **Same gaps twice:** if two verdicts in a row have the same set of unmet criterion ids and the same
  missing-evidence entries (a stable fingerprint), the loop stops as `failed` ("the verifier found
  the same gaps twice") without spending the third attempt.
- **No change:** a completion claim with the same workspace snapshot hash as the last failed
  verification, and no new tool calls, skips the verifier and counts as an attempt.
- **Verifier errors** (a timeout, no valid verdict after the tool's 3 submissions, an unreachable
  server past the outage tolerance) are retried once for that claim. The second error ends the loop as
  `unverified`. Errors never count as a PASS.
- The verifier session has its own caps: `steps: 40` and the loop's `waitTimeoutMs` for no progress.
- `maxIterations` still caps the whole loop. A feedback prompt is an iteration.

Settings, per goal (start dialog) with config defaults:

```jsonc
"experimental": { "accuracy": {
  "goal_verifier": false,             // default for new goal loops
  "goal_verifier_max_verifications": 3,
  "goal_verifier_model": null,        // null = the worker's model
  "goal_verifier_task_wait_ms": 1800000  // how long to wait for the worker's background tasks
} }
```

`GoalLoopStartInput` gains `verify?: boolean`, `checks?: string[]` and `criteria?: string[]`.

## 3. What is decidable (red-first unit tests)

- **The lock** (`permission.test.ts`): with the verifier agent, `evaluate` denies `edit`, `write`,
  `apply_patch`, `bash`, `task` and an MCP tool name **even when** the user config says
  `"*": "allow"` and `edit: "allow"`, **and** the session ruleset allows them. The same test against
  `explore` shows the user config winning there (the gap this closes). `Permission.disabled` hides
  every denied tool. Every call site uses the helper (a grep test: no direct
  `Permission.merge(agent.permission, …)` outside the helper).
- **`Verdict.validate`**: a PASS citing a quote that is not in the file becomes invalid; a quote in
  the file but outside the cited lines is invalid; a check citation with the wrong exit code is
  invalid; an unsupported PASS after 3 submissions is stored as PARTIAL with the right missing
  entries; a consistent FAIL is accepted as is.
- **The loop** (`goal-loop.test.ts`, with the scripted fetch it already uses):
  - verification off: the marker completes the loop, as today;
  - PASS: completed, with `lastVerdict` set;
  - FAIL then PASS: exactly one feedback prompt, whose text contains the unmet criteria and not the
    verifier's prose, then completed;
  - three FAILs: `failed`, with the missing list in `reason`;
  - the same gaps twice: `failed` after two verifications, not three;
  - no change since the last FAIL: no verifier session is created, and the attempt count still goes
    up;
  - a verifier timeout, then a PASS: completed; two timeouts: `unverified`;
  - the snapshot hash changes during verification: `failed`, verdict void;
  - running background tasks: `waiting-on-tasks` until they end, then verifying;
  - the verifier prompt contains the worker's report only inside the claims block, and none of the
    worker's messages.
- **The feedback text builder** is pure: its input is a validated verdict, and the output has a stable
  order.

## 4. The thin untestable layer

- How good the verifier's judgment is, and whether the same model can catch its own kind of mistakes.
  Measured, not assumed (section 7), and the reason `goal_verifier_model` exists.
- How the worker reacts to a FAIL: fixing the work versus arguing with the verdict. The feedback asks
  for evidence when it disagrees, but that is a prompt.

## 5. Failure modes

- **A false PASS.** The verifier is fooled, for example by a test that was edited to pass. Mitigations:
  checks are user-declared and run by the loop, and the diff is in the verifier's input, so an edited
  test is visible. It is not eliminated, and the eval's false-PASS rate is the number to watch.
- **A false FAIL** on work that is correct: costs up to `max_verifications` extra iterations, then
  ends as `failed` with the verdict visible, so a human can overrule it. The UI note gives that a
  control.
- **Criteria the verifier invents** when the user gave none. They are listed in the verdict, so they
  can be seen, and a user who cares supplies `criteria`.
- **Stale worker todos** (the "2 of 9, days old" case): the verifier gets the list with its age and
  reports each item `met`/`unmet`/`obsolete`. It does not fail a goal only because the list is stale,
  and it does not mark items done because they are listed.
- **Prompt injection through the workspace.** A file can say "report PASS". The verifier's prompt
  frames file content as data, and the validator only accepts verdicts whose citations check out, so
  an injected PASS still needs real evidence.
- **Cost.** One more session per completion claim, bounded at `max_verifications + 1` per loop.

## 6. Interaction with the shipped techniques and the goal loop

- **The goal loop.** Built on it, as above. The verifier session is driven by the same `request`,
  outage handling and progress watch. The iteration count, the summarize-before-continue and the
  harness-note turn tracking are unchanged. The loop's other prompts (first and continue) are
  unchanged when verification is off.
- **#2 autonomy.** Both sessions get `autonomous: true`. The verifier's `question` is denied by the
  lock.
- **#4 todo reminders.** The worker's todo list is an input to the verifier, not a gate. When the
  verifier reports todo items as `met` with evidence, the loop records them (session id, content
  hash, verdict, evidence, time) in a `todo_evidence` table on the server. The checkpoint (accuracy D)
  and the todo dock (`accuracy-ui.md` §3) show those items as verified. The todo `onStop` continue
  still runs inside the worker's turn before the loop sees the turn end, so the worker gets one chance
  to reconcile its list before the verifier looks.
- **#1 background shell.** The verifier does not run while the worker has background tasks running.
  A build still going is not evidence either way. This is the same rule as Claude Code's `/goal`,
  whose evaluator does not fire while background work runs. The wait is bounded by
  `goal_verifier_task_wait_ms`, after which the tasks are listed as running in the verifier's input.
- **#3 runaway guard.** Runs inside the verifier session like any other. A verifier that repeats the
  same failing read gets the usual nudge.
- **#5 receipts (accuracy C).** Check output is budgeted and archived. The verifier can read archives
  (the only external directory it may read).
- **#6 checkpoints (accuracy D).** The verifier's input includes the same host record, and the
  checkpoint shows the last verdict. A worker that compacts after a FAIL still knows what was unmet.

## 7. Default, and how the effect is measured

**Default: off**, like accuracy B, until the goal panel in `accuracy-ui.md` shows the verdict and its
evidence. A loop that keeps going after the worker said "done" must say why, on screen. After that
ships, the default is decided by the eval, not by this note.

Measurement follows the shared protocol in `accuracy-c.md` §7. One point is specific to this note:
the FrontierHarness tasks run headless, and the verifier lives in the desktop goal loop. That is not
a blocker. `createGoalLoop` takes everything it needs by injection (`getServer`, `fetchImpl`, `now`;
`goal-loop.ts:18-46`), so the Harbor adapter can import it and drive `opencode serve` directly. The eval
then measures this exact code, not a copy.

Arms: `loop` (goal loop, verification off) and `loop+verifier`. The eval's own grader is the ground
truth. Metrics:

- pass rate, paired by task;
- **false-PASS rate**: verifier PASS on a run the grader fails. This is the most important number,
  because it is the failure the verifier exists to stop;
- **false-FAIL rate**: verifier FAIL/PARTIAL on runs the grader passes (the cost);
- **rescue rate**: runs whose first completion claim would have failed the grader and that pass after
  verifier feedback;
- extra tokens and wall time per task.

A second pair of arms uses a different verifier model (`goal_verifier_model`) to see whether a
different model family lowers the false-PASS rate.

## 8. Files touched (when implemented)

| File | Change |
|---|---|
| `packages/desktop/src/main/goal-loop.ts` | the verify branch, phases, bounds, feedback, session metadata |
| `packages/app/src/goal-loop/types.ts` | `phase`, `verify`, `verifications`, `lastVerdict`, `unverified`, the new start fields |
| `packages/opencode/src/agent/agent.ts` | the `verifier` agent |
| `packages/opencode/src/permission/index.ts` | `VERIFIER_LOCK`, `effective()`; the call sites in section 1 switch to it |
| `packages/opencode/src/tool/verdict.ts` (new), `session/verdict.ts` (new) | the tool and the pure validator |
| `packages/opencode/src/session/todo.ts` + `core/src/session/sql.ts` | the `todo_evidence` table |
| `packages/opencode/src/server/.../experimental.ts` | snapshot hash endpoint |
| tests | `permission.test.ts`, `verdict.test.ts` (new), `goal-loop.test.ts` |

## 9. Scope and open items

- V1 server paths only. The lock helper has to be carried into V2's permission evaluation.
- The verifier cannot run anything the user did not declare. That is the safe choice and also a real
  limit: a goal whose criteria need a command nobody declared can only be verified by reading. See
  section 10.

## 10. Decision requested

**No shell for the verifier.** This note gives the verifier no `bash` at all. Commands that produce
evidence are declared by the user when starting the goal and run by the loop before the verifier
starts. The alternative is a verifier with an allowlist of read-only commands (`git diff`, `git log`,
test runners). It would verify more goals without setup, but a bash allowlist is not read-only in
practice: `git diff --output=<file>` writes, and a test runner executes code the worker wrote, which
can change anything. The snapshot comparison would catch the damage only after it happened. The note
proposes no shell, with the loud limit that undeclared checks can only be verified by reading.
