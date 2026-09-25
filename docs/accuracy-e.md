# Accuracy E: goal mode with an independent read-only verifier

Status: **design only, not implemented.** Branch `docs/accuracy-c-design`. This is technique #7 in
`plans/legatus-harness/plan.md`: goal mode with an independent read-only verifier (PASS / FAIL /
PARTIAL, with missing evidence fed back to the worker). No code until the architect approves.

This builds on the desktop goal loop (`packages/desktop/src/main/goal-loop.ts`). It does not add a
second loop. The loop keeps driving the worker. The verifier replaces one line of it: the line that
believes the worker when it says it is done.

## 1. What happens today (evidence)

- **Done means "the worker said so".** The loop reads the latest turn's text, and if a line equals
  the completion marker it finishes as `completed` (`goal-loop.ts:668-671`). `completionReached` is a
  regex on the worker's own output (`:153-156`). Nothing checks the claim. The first prompt asks the
  worker to judge itself ("When the goal is fully achieved, reply with GOAL_COMPLETE",
  `:110-116`). This is the failure the autonomy prompt (accuracy A) can only discourage.
- **The loop is well built and should be reused.** It already handles a busy session that stops
  moving (`:560-630`), aborted and failed turns with backoff (`:672-718`), server outages (`:720-742`),
  context growth with a summarize before continuing (`:505-530`), prompts from other clients into the
  same session (`:635-645`), harness notes inside a turn (`:222-250`), and an iteration cap
  (`:540-546`). Every one of those is needed while a verifier runs too.
- **One loop per session** (since `825bca40b0`). Each `createGoalLoop` still drives one session
  (`active`, `:317`; `start` throws "a goal loop is already running", `:774`), and
  `desktop/src/main/goal-loops.ts` keeps one per session, persisted per session
  (`store-keys.ts:11-12`). This note works with one loop or many.
- **No read-only agent exists.** `explore` is the closest, and it allows `bash`
  (`opencode/src/agent/agent.ts:196-218`), which can write anything. Worse, every native agent merges
  the user's config **last** (`Permission.merge(defaults, agentRules, user)`, e.g. `agent.ts:185-191`),
  and evaluation takes the **last** matching rule (`permission/index.ts:28-38`). A user config with
  `"edit": "allow"` therefore re-enables edits on any native agent, including one we call read-only.
  The session's own ruleset is merged after that at every call site (`session/tools.ts:87`,
  `session/llm.ts:149`, `session/llm/request.ts:211`, `tool/registry.ts:292`, `tool/code-mode.ts:209`,
  `session/system.ts:122`, `session/prompt.ts:366`, `:1379`), and `PATCH /session/:id` can append rules
  to it (`server/.../handlers/session.ts:197`).
- **What the server already gives us.** Child sessions (`POST /session` takes `parentID`, `agent` and
  `permission`: `session/session.ts:260-270`). Structured output with a JSON schema, a forced tool call
  and an error when the model does not comply (`session/prompt.ts:1351-1356`, `:1397-1411`,
  `:1435-1440`). A per-agent step cap (`agent.ts:54`, `prompt.ts:1280-1281`). A user-run shell command
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
`goal-loop.ts:27-64`), so the Harbor adapter can import it and drive `opencode serve` directly. The eval
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

Ruled 2026-09-21: approved. No shell, host-verified citations, a lock ruleset, and one goal loop per
session.

## 11. Addendum before implementation (2026-09-23)

A reread of the code on dev `463ae65e1a` found two holes in section 2's lock and some stale
references.

**Ruled 2026-09-23: approved.**
- 11.1: the proposal. An explicit deny in an agent's ruleset is final, and approvals only lift
  `ask`, with a CHANGELOG entry.
- 11.2: accepted, and the reverse hole is closed too. No other agent may take the name `verifier`,
  by rename or as a new agent. The lock is keyed on the built-in agent's identity, not on a name a
  config can reproduce.
- 11.4: the phases. The addendum merges together with phase 1.

### 11.1 An "always" approval outranks the lock (needs a ruling)

`Permission.ask` evaluates `evaluate(permission, pattern, ruleset, approved)`
(`permission/index.ts:73`). `approved` holds the "always" replies, and it is **instance-wide**, not
per session (`State.approved`, `:25`, pushed at `:145-151`). It comes **after** the ruleset, and the
last matching rule wins. So appending `VERIFIER_LOCK` last in the ruleset is not last: if anyone has
answered "always" to `edit` or `bash` for a pattern in any session of that directory, the verifier's
ask for that pattern is allowed.

This is not new with the verifier. Today the same order lets an approval given to `build` beat
`plan`'s `edit: deny`, because an agent's deny never asks and so was never the one approved.

Denied tools are hidden from the model (`Permission.disabled`), so this is a second-line hole, not a
first-line one. But `read` is a tool the model does see, and the lock denies some of its patterns:
`*.env` files, and any path outside the workspace other than the archive (`external_directory`).

- **Proposed:** a deny in the ruleset is final, and approvals only lift `ask`. In `ask`, evaluate the
  ruleset alone first, and if it denies, deny. Otherwise evaluate with `approved` as today. This fixes
  `plan` as well. The behavior change: a pattern an agent's ruleset denies can no longer be unlocked
  by an "always" given elsewhere. An agent whose rule is `ask` is unaffected.
- **Alternative:** keep `ask` as it is, and give the lock its own slot evaluated after `approved`
  (a `lock` field on the ask input, set by `Permission.effective`). This is narrower and changes
  nothing for other agents, but it leaves the `plan` hole open.
- Red tests either way: a verifier `read` of `.env` stays denied after an "always" approval of
  `read *.env` in another session, and the same for `plan` with `edit`, if the proposed option is
  taken.

### 11.2 Config can rename or remove the verifier (needs a ruling)

The config loop in `agent.ts:267-294` applies `agent.<key>` to native agents. For the key `verifier`
that includes `disable` (deletes it), `name` (the lock is keyed on `agent.name === "verifier"`, so a
rename drops the lock), `mode`, `hidden`, `prompt` and `permission`. The lock would still beat
`permission`, but a rename or a disable defeats it outright.

- **Proposed:** for the key `verifier`, config may set only `model`, `variant`, `temperature`,
  `top_p` and `steps`. `steps` may lower the cap of 40 but never raise it. Every other field is
  ignored with a logged warning. `disable` is ignored too: the loop's `verify` setting is the way to
  turn verification off. The lock applies to any agent whose name is `verifier`, so a user agent
  renamed to `verifier` gets it, which can only restrict.
- Red tests: `agent.verifier: { name: "x", disable: true, permission: { "*": "allow" } }` still gives
  a `verifier` agent that denies `edit` and `bash`, and `steps: 500` stays at 40.

### 11.3 Bookkeeping

- **Call sites.** Besides the ones listed in section 1, two read `agent.permission` without the
  session rules: `session/system.ts:108` (the skill list) and `cli/cmd/debug/agent.handler.ts:89`.
  Both go through `Permission.effective` too, so the grep test can say "no `agent.permission` read
  outside the helper". `session.ts:197` merges session rules only (a `PATCH`) and stays.
- **Line numbers** in section 1 are updated to dev `463ae65e1a`. The per-session loop ruling has
  been implemented (`825bca40b0`); section 1 now says so.
- **Accuracy D is merged.** `Checkpoint.build` already takes `goal` and `verified`. `compaction.ts`
  passes neither yet. Phase 3 below wires them.

### 11.4 Implementation phases (one branch each, red-first, reviewed separately)

1. **Lock.** The `verifier` agent (11.2), `VERIFIER_LOCK`, `Permission.effective` at every call
   site (11.3), and the ask order from the 11.1 ruling. Server-only. Tests: `permission.test.ts`,
   `agent.test.ts`, the grep test.
2. **Verdict.** `session/verdict.ts` (the pure `Verdict.validate`), the `verdict` tool registered
   for the verifier agent only, with 3 submissions and unsupported PASS → PARTIAL. Tests:
   `verdict.test.ts`.
3. **Records.** The snapshot hash endpoint, the `todo_evidence` table, and the session `goal`
   metadata read by compaction, so the checkpoint shows the goal line and verified marks.
4. **Loop.** The verify branch in `goal-loop.ts`, the phases, the bounds, the feedback builder, the
   app types, and the settings. The default stays off until the UI shows verdicts (section 7).

### 11.5 The verifier session's metadata: the contract Phase 4 writes (ruled 2026-09-23)

The `verdict` tool (`packages/opencode/src/tool/verdict.ts`) reads the goal from the metadata of
the session it runs in, the verifier's child session, never from the prompt, so the verifier cannot
restate or drop it. Phase 4 writes it in exactly this shape:

```ts
// session.metadata of the verifier's session
type VerifierSessionMetadata = {
  verify: {
    /** Snapshot hash from Snapshot.track() at the loop's start. The tool diffs the workspace
     *  against it (Snapshot.diff(base)) for `diff` citations. Absent (track() returns undefined
     *  when git cannot write a snapshot), or a base git cannot diff against: every diff citation
     *  fails with "no host snapshot for this verification; diff citations are unavailable". */
    base?: string
    /** The acceptance criteria the user declared, verbatim. Each must be judged with its text as
     *  written (case and spacing aside), or a PASS is stored as PARTIAL. Absent or []: the
     *  verifier derives its own criteria, as section 2 describes. Non-string entries are ignored. */
    criteria?: string[]
    /** The part ids of the checks the loop ran in this session (the tool parts that
     *  POST /session/:child/shell created). Only these are citable. Absent or []: no check
     *  can be cited. Any other user-run shell part in the session is never evidence, but
     *  one that failed, or did not finish, still blocks a PASS (ruled 2026-09-24). */
    checks?: string[]
  }
}
```

**Written in-process only (ruled 2026-09-24).** The worker being verified has bash and can call
the local HTTP API, so the API refuses any `metadata.verify` on session create and update (400),
and an update of other metadata keeps the existing `verify`. Phase 4 therefore writes it inside
the server (`Session.setMetadata`), for example from a server-side "start verification" step, not
with `PATCH /session/:child`. Write the complete object once, after the checks and before the
verifier's prompt. Example of the stored value:

```json
{
  "metadata": {
    "verify": {
      "base": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "criteria": ["the output is capped at the budget", "the README documents `--budget`"],
      "checks": ["prt_01J8Z3Q4R5S6T7U8V9W0X1Y2Z3", "prt_01J8Z3Q4R5S6T7U8V9W0X1Y2Z4"]
    }
  }
}
```

The tool reads nothing else from the session's metadata. It reads the session's whole history
from storage, not the model's (possibly compacted) context, so a compaction cannot hide a failed
check or an earlier submission. User-run shell parts (`POST /session/:child/shell`) carry
`metadata.ranBy = "user"` from their start and `metadata.exit` once finished; a model's own shell
call is never one. Why the binding: anything that can call the session API (another agent's
plugin, a client) could run a passing command in the verifier's session; only the loop knows
which runs it made.

**Checks must succeed with exit 0 (ruled 2026-09-23).** A PASS cannot stand while any check run for
the verification failed or was aborted, cited or not. A negative check is written so that success
means exit 0: a test that asserts the failure, or `! cmd` where the shell supports it. The expected
exit code is never something the verifier declares. The tool description tells the verifier this,
and the loop's settings UI should tell the user.

### 11.6 Follow-ups (not in Phase 2)

- **Test preload teardown is slow.** `packages/opencode/test/preload.ts`'s `afterAll` disposes the
  whole `AppRuntime`, then retries removing the test data directory up to 30 times. On this machine
  it sometimes takes about 340 s, which bun reports as an `(unnamed)` hook timeout at the start of
  a file (seen on `test/session/verdict.test.ts`, `test/tool/lsp.test.ts`, `test/tool/read.test.ts`).
  Find what `AppRuntime.dispose()` waits on, and bound it.
- **Each test process downloads ripgrep.** The preload points `XDG_CACHE_HOME` at a per-process
  directory (`opencode-test-data-<pid>`), so the first search in every test file fetches the `rg`
  binary again: 20-60 s here, and the usual cause of a 30 s timeout on a file's first grep, glob or
  listing test. Share one cache for the binary across test processes (or seed it from the
  developer's cache), keeping the rest of the data directory per process.

### 11.7 Security notes: accepted risks

- **lsp hover for agents other than the verifier (accepted 2026-09-24).** A hover is shown only
  when the agent may read every file the symbol is defined in. Type information can still flow in
  from elsewhere: an alias or an inferred literal type in a readable file can carry a value defined
  in a denied one. That is accepted for agents a person supervises. The verifier, which nobody
  supervises, is refused hover by its lock (`VERIFIER_LOCK` lsp `hover: "deny"`); it has
  goToDefinition and read, which are filtered by the read rules.

### 11.8 Phase 3 (Records): design note (2026-09-24, for review)

Phase 3 gives the host three records: the goal and the snapshot it started from, the last verdict,
and the todo items a verdict found met. Compaction reads them, so the checkpoint shows the goal
line and the verified marks. Phase 4 (the loop) writes into these records and does not define
them. This note replaces the bullets for Phase 3 in sections 6, 8 and 11.4 where they differ, and
says why below.

**The trust question these records answer.** The goal loop runs in the app and talks to the local
HTTP API. The worker it drives has bash and can call the same API (the ruling in 11.5). The server
cannot tell the two callers apart. So:

- Anything the checkpoint or the verifier presents as a record is **written inside the server**,
  never taken from a request body: the snapshot hash, the last verdict, and the verified todos.
- What only a person can give (the goal text and its criteria) comes in over HTTP. Every change to
  it is kept and shown, so a goal the worker rewrote is visible, not silent.

**1. The goal record, and the snapshot "endpoint".** Section 8 listed an endpoint returning a
snapshot hash for the loop to hold and pass back later. A hash that goes through the client can be
swapped on the way back, so instead the server takes the snapshot and keeps it:

- `POST /experimental/session/:id/goal` with `{ text, criteria? }`. The server calls
  `Snapshot.track()` and writes the session's `metadata.goal` in-process (`Session.setMetadata`):

  ```ts
  goal: {
    id: string            // new per start; a verification names the goal it verifies (below)
    text: string          // verbatim, capped like the checkpoint's other lines
    criteria?: string[]
    base?: string         // Snapshot.track(); absent when git could not write a snapshot
    startedAt: number
    changes?: { text: string; at: number }[]  // earlier goals of this session, newest last, capped at 10
    lastVerdict?: LastVerdict                 // item 2
  }
  ```

  The response is `{ id, base: string | null, startedAt }`, so the loop can warn when `base` is
  null. Its diff citations will then be unavailable (the error ruled in 80acc1bdab).
- `DELETE /experimental/session/:id/goal` ends the goal: it sets `endedAt` and keeps the record.
- The client-metadata filter that refuses `verify` (11.5) refuses `goal` too, on session create and
  update (400). An update of other metadata keeps the existing `goal`, and a fork drops it, as it
  does `verify`.
- Starting a goal while one is active replaces it. The old text moves into `changes`, and the
  checkpoint says the goal was changed and when. Phase 4's server-side "start verification" copies
  `goal.base` and `goal.criteria` into the verifier's `verify`, with a new field
  **`verify.goal = goal.id`** (an addition to the 11.5 contract). The base never goes through the
  client.

**2. The last verdict.** It is written by the `verdict` tool when a verdict is recorded, onto the
worker session: the verifier session's `parentID`. It is written only while that session's
`goal.id` equals the verification's `verify.goal`, so a stale verifier cannot overwrite a newer
goal's result.

```ts
type LastVerdict = {
  verdict: "PASS" | "PARTIAL" | "FAIL"   // as stored, after the PASS -> PARTIAL rule
  at: number
  verifierSessionID: string
  unmet: string[]   // criteria not judged met, verbatim, capped (count kept when cut)
}
```

Section 2 had the loop writing `goal: { text, lastVerdict }` with `PATCH /session/:id`. That is
dropped: the worker could PATCH itself a PASS.

**3. `todo_evidence`.** A new table in `core/src/session/sql.ts`, with a migration:

| column | |
|---|---|
| `session_id` | the worker session; references `session.id`, `on delete cascade` |
| `content_key` | `Checkpoint.contentKey(content)` (sha256, 16 hex) |
| `content` | the todo text, for display |
| `verifier_session_id` | the verification that found it met |
| `evidence` | JSON: the citations that checked out (the stored `Todo.evidence`) |
| `time_created` | |

The primary key is `(session_id, content_key)`. It is written by the `verdict` tool, on a recorded
verdict only, under the same `goal.id` guard as item 2:

- A todo stored as `met` with evidence is upserted, so the latest verification wins.
- A todo the verdict reports as not met deletes the row: the old evidence is no longer current.
- A todo the verdict does not mention is left alone.

A worker that edits a todo's text gets a new key, so the mark does not carry over to text nobody
checked. Reads: `Todo.verified(sessionID)` returns `Map<contentKey, time>`, and a read-only
`GET /experimental/session/:id/todo/evidence` serves the todo dock (accuracy-ui §3).

**4. Compaction.** `writeCheckpoint` passes `goal` and `verified` to `Checkpoint.build`. `Input`
gains `lastVerdict` and `goalChangedAt`, which add, capped, to the goal line:

```
Goal loop: <text>. Last verdict: FAIL 3m ago; unmet: <criterion>, <criterion> (+2).
```

It fails open like the rest of the checkpoint: a record that cannot be read is left out and logged.

**Red-first tests.**

- `session.test.ts` / `httpapi-session.test.ts`: `goal` is refused on create and update, kept on
  update, and dropped on fork. The goal endpoint writes `base` from `track()`; it returns
  `base: null` when `track()` returns undefined. A second start fills `changes`.
- `tool/verdict.test.ts`:
  - a recorded verdict writes `lastVerdict` and the met todos onto the parent;
  - a rejected submission writes nothing;
  - a `verify.goal` that differs from the parent's `goal.id` writes nothing;
  - an unmet todo deletes its row.
- `checkpoint.test.ts` and `compaction.test.ts`: the goal line, the last verdict, the "changed" note,
  and verified marks from the table; a missing record leaves its line out.
- The migration test that the existing tables use.

**Accepted risk, for a ruling.** The worker can still call the goal endpoint itself: it can replace
the goal or end it. That cannot be told apart from the app over the local API. It stays visible,
because every change is kept and the checkpoint shows it. It cannot forge a verdict, a verified
todo or a snapshot. Removing the risk needs a credential the app has and the worker's shell does
not (the server password is read from the server's environment, which shells may inherit). That is
outside Phase 3.

**Needs a ruling:**

1. The goal endpoint in place of a snapshot-hash endpoint.
2. `verify.goal` added to the 11.5 contract.
3. `lastVerdict` written by the tool, not the loop.
4. The latest verification wins, and an unmet report deletes the row.
5. The accepted risk above.
