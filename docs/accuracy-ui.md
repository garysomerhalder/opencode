# Harness UI: goal loop, background tasks, todo honesty

Status: **design only, not implemented.** Branch `docs/accuracy-c-design`. Added to this batch by the
architect because it touches #1 and #7 and should be designed with them. No code until the architect
approves.

Why this exists. Gary looked at the goal loop in the running dev app and said "this goal loop UI
sucks". His screenshot shows four problems:

1. A plain-text strip: "Goal loop", a goal cut off with "…", a raw directory, and "Start goal loop" in
   bold with no button styling. It says nothing about state: running or stopped, when it last checked
   or nudged, how many iterations.
2. **The wrong session's goal.** The active tab is "Muse #2 · Legatus Harness". The strip shows Muse
   #1's goal ("In …\servo-engine (branch legatus): the Legatus request list is complete…") and a
   directory from yet another session.
3. The todo dock says "2 of 9 todos completed" with Phase 0 items from days ago. The worker never
   updated them. The dock shows a model-maintained list as if it were current.
4. Muse #2 runs `Start-Sleep 290; bun poll-tmp.ts record` in a foreground shell to wait on a long job.
   That is exactly what background shell (#1, accuracy B) is for, and #1 ships **off** "until there is
   a UI for it". The missing UI is costing us now.

## 1. Goal loop panel

### What is there today (evidence)

- **Why it shows the wrong session: both causes are real.**
  - *The state is global.* The desktop main process holds one loop: `let active` in
    `packages/desktop/src/main/goal-loop.ts:301`, and `start` throws "a goal loop is already running"
    (`:737`). It is persisted under one key (`desktop/src/main/store-keys.ts:6-9`,
    `main/index.ts:332-352`), and the remembered last input is one app-wide key too (`GOAL_LOOP_LAST_KEY`,
    `index.ts:111-119`, `:343`). Muse #2 **cannot** have its own loop while Muse #1's runs.
  - *The strip is not bound to the session.* `session.tsx:2293` renders `<SidebarGoalLoop />` with no
    session id. The component subscribes to the one global loop (`pages/layout/sidebar-goal-loop.tsx:44-57`),
    and when that loop is idle it shows the **app-wide last input** (`:64-76`, via
    `goal-loop/last-input.ts:24-34`): the goal and directory of whatever loop anyone last started, on
    every session's page. That is the Muse #1 goal on the Muse #2 tab.
- **Truncation.** The goal is cut to 140 characters (`last-input.ts:5`, `:16-20`) and then again by CSS
  `truncate` on one line (`sidebar-goal-loop.tsx:165`).
- **No real button.** "Start goal loop" is a bare `<button>` styled as text (`sidebar-goal-loop.tsx:152-159`,
  `:174-181`). The goal manager dialog already uses the library's `Button` with `primary`/`secondary`
  variants (`components/dialog-goal-manager.tsx:166-171`, `:265-272`).
- **No state.** The running line is "Step N of M in <directory>" (`sidebar-goal-loop.tsx:227-243`).
  The loop already records *why* it is still going in `reason` ("working (last progress 40s ago)",
  "recovered from an aborted turn", `goal-loop.ts:708-715`) and `updatedAt`, and the UI shows neither.
  When a loop ends, the strip drops it (`sidebar-goal-loop.tsx:55` keeps only `running`), so
  `completed`, `failed` or `capped` are visible only as a toast.
- It is desktop-only (`sidebar-goal-loop.tsx:129-131`), which stays true.

### Design

**Engine: one loop per session.** `createGoalLoop` stays as is. A thin manager in the main process
holds `Map<sessionID, GoalLoop>`: `start` refuses only when *that* session already has a running loop.
`stop`, `status` and the IPC calls take a `sessionID`. Events already carry the full state, which
includes `sessionID`. Persistence becomes one record per session (`state:<sessionID>`). On first run the
old single `state` record is adopted as that session's record, then `adoptOrphan` runs per record as
today. The remembered last input is kept **per session**, so the "Start" prefill on Muse #2 is Muse
#2's own goal and directory, never another session's. The ticket queue (`goal-loop/queue.ts`) starts
one loop at a time and is unaffected apart from passing the session id.

**Panel: bound to the page's session.** `<GoalPanel sessionID={params.id} />` replaces the strip at
`session.tsx:2293`. It renders only the loop whose `sessionID` equals the page's session. On a session
with no loop it shows one line and a Start button. A loop that belongs to another session is never
shown here.

Layout, top to bottom, in the existing strip position:

```
[status icon]  Goal · Muse #2 · Legatus Harness            [Tag: Running · verifying]   [Stop]
The Legatus request list is complete when every entry in docs/requests.md has … (2 lines)  Show all ▾
Iteration 7 of 20 · checked 3s ago · last nudge 2m ago · C:\…\opencode-wt-accuracy-c
Verifier: [Tag: PARTIAL] 2 of 4 criteria met · 14:02 · C2 "tests pass": check `bun test` exited 1 …   Open ▸
```

- **Which session.** The header names the session ("Goal · <session title>"). The panel lives on
  that session's page and nowhere else, and each session row in the sidebar gets a small goal badge
  next to the existing working spinner (`pages/layout/sidebar-items.tsx:146-168`). That is how you see
  that another session has a loop without its goal showing up on your page.
- **The goal in full.** `Collapsible` (`packages/ui/src/components/collapsible.tsx`) with a two-line
  clamp and "Show all". The text is never cut in the data, only clamped visually. `last-input.ts`'s
  140-character snippet is kept only for the sidebar badge tooltip.
- **State.** A `Tag` (`ui/components/tag.tsx`) with the phase. Phases come from the engine
  (`GoalLoopState.phase`, added in accuracy E):

  | Shown | From | Token |
  |---|---|---|
  | Idle | no loop for this session | neutral (`text-text-weak`) |
  | Running · turn | status `running`, phase `turn` | `info` |
  | Running · waiting | phase `waiting` (continue owed, backoff); `reason` shown as the tooltip | `info` |
  | Running · waiting on tasks | phase `waiting-on-tasks` (accuracy E) | `info` |
  | Running · verifying | phase `verifying` | `info` + `Spinner` |
  | Done | `completed` | `success` |
  | Failed / Unverified | `failed`, `unverified`; `reason` shown inline | `error` / `warning` |
  | Stopped / Capped | `stopped`, `capped` | neutral |

  A finished loop stays in the panel with its end state and reason until you dismiss it or start a
  new one. Today it vanishes.
- **Last check, last nudge, iterations.** The engine exposes `checkedAt` (the last poll) and
  `promptedAt` (the last prompt it sent, today's `track.sentAt`, `goal-loop.ts:448-454`) on the state.
  The panel renders them as relative times that tick. The iteration count exists already.
- **Controls.** `Button` from the library: `primary` "Start" (opens the goal manager prefilled with
  this session's id and directory, `sessionID` is already a start field in
  `goal-loop/types.ts`), `secondary` "Stop". `IconButton` for "Open verifier session".
- **Verdict (once accuracy E exists).** The last verdict as a `Tag` (PASS `success`, PARTIAL
  `warning`, FAIL `error`), the time, the met count, and the first unmet criterion. "Open" expands the
  criteria list with each piece of evidence as a link: a `file` citation opens the file viewer at the
  lines, a `check` opens that tool part in the verifier's child session, a receipt path opens the
  archive. A human can see *why* a loop that the worker called done is still going.

Colors come only from theme tokens (`success`, `warning`, `error`, `info`, `text-*`, `surface-*`),
which the Legatus theme maps from the Brand API (`packages/ui/src/theme/brand/legatus.ts:25-66`:
green `#4ADE80`, amber, red, blue). No raw hex.

## 2. Background tasks panel

This is the UI accuracy B names as the reason #1 is off (`docs/accuracy-b.md` §11).

### What is there today (evidence)

- The registry has everything a list needs: id, session, command, cwd, pid, status, exit code,
  start and end times, bytes, file, reason (`packages/opencode/src/tool/shell/tasks.ts:36-58`).
- There is **no event** when a task changes. The registry only listens for `session.deleted`
  (`tasks.ts:300-316`). A UI would have to poll.
- The endpoints are "list" and "stop **all**" (`server/.../groups/experimental.ts:272-293`). There is
  no way to stop one task.
- The info has no line of output. The rolling tail exists inside the registry (`lastLines`,
  `tasks.ts:252`), it just is not exposed.
- The idle reaper kills without notice (`accuracy-b.md` §11).

### Design

Server (small, all inside the flag):

- a `shell.task.updated` event with the task info, on every status change and at most once a second
  while output grows;
- `POST /experimental/shell/task/:id/stop` (the same session scoping as `shell_stop`);
- `tail` (the last line, 200 characters) and `wake` (`pending` | `suppressed-read` |
  `suppressed-stopped` | `delivered`) on the info.

App: a **background tasks dock** in the composer region, stacked above the todo dock
(`pages/session/composer/session-composer-region.tsx:62-83`), using the same `DockTray` treatment as
the todo dock. It shows when the session has at least one task that is running or ended in the last
10 minutes. It is independent of whether the session is working, because a background task is
exactly the case where the session is *not*.

```
Background tasks · 2 running
● bun test test/tool             6m 10s   ✓ will wake the agent       …ok 412 tests (3 skipped)   [Stop]
● bun run dev                    41m 02s  ✓ will wake the agent       ready on http://localhost:5173 [Stop]
✓ cargo build --release          exited 0 · 3m ago · agent woken                                 [Output]
✕ npm run e2e                    killed: idle 30 min, nobody reading · 1m ago                     [Output]
```

- **Row:** status icon (`Spinner` while running), the command in mono, one line with `Tooltip` for the
  full text; elapsed time, ticking; the wake state in words ("will wake the agent", "agent already
  read it", "stopped, no wake", "agent woken"); the last output line; `IconButton` Stop (running) or
  Output (ended, opens the archived file through the existing file viewer).
- **The idle reaper says so.** A reaped task stays in the list with the reason, and a toast says what
  was killed and why. This is accuracy B's second follow-up.
- **The session header** gets a count badge ("2 tasks") that opens the dock, so the tasks are visible
  when the dock is collapsed.

**With this shipped, #1 turns on by default** (`experimental.background_shell` absent = on). That is
a one-line default change in a separate commit, after the UI is merged, so it can be reverted alone.

## 3. Todo dock honesty

### What is there today (evidence)

- The dock renders the list as the model last wrote it: "{{done}} of {{total}} todos completed"
  (`app/src/i18n/en.ts:889`, `pages/session/composer/session-todo-dock.tsx:58-60`), and checkboxes by
  status (`:233-262`). Nothing says where a status came from or how old it is.
- It reappears whenever the session is working and the list is not all done
  (`session-composer-state.ts:52-67`). A list abandoned days ago therefore shows on every new turn,
  which is the screenshot.
- The data to do better exists but is dropped: the rows have `time_created` (all rows of one write
  share it, because `update` replaces the list, `session/todo.ts:29-50`), and `Todo.get` does not return
  it (`todo.ts:53-66`). The `todo.updated` event has no time either
  (`packages/schema/src/session-todo.ts`).

### Design

- **Age.** `Todo.get` and the `todo.updated` event carry `updatedAt` (the time of the last write). The
  dock header reads "2 of 9 todos completed · updated 3 d ago".
- **Staleness, measured against activity, not only time.** The list is *stale* when the session has
  had at least 20 assistant steps, or 30 minutes of work, since the last write. A list that is old
  because the session was idle is not stale. When it is stale, the header shows a `warning` `Tag`
  "Stale: not updated in 412 steps", and the dock opens collapsed. The pure function decides; the
  thresholds are settings.
- **Provenance per item.** Three levels, never merged:
  - *claimed*: the status the agent wrote with `todowrite` (every item today). Rendered as now.
  - *verified*: the verifier (accuracy E) cited evidence that the item is met. A `success` check icon
    and "verified 12m ago" on hover, with the evidence one click away.
  - *contradicted*: the agent says completed and the verifier says unmet. A `warning` icon and "the
    verifier did not confirm this".
  The counter becomes "2 of 9 completed (1 verified)", so the number the dock leads with is honest
  about what it counts.
- Per-item times would need `Todo.update` to match old and new rows by content. It is not needed for
  the above, and it is left out (accuracy D §9).

## 4. What is decidable (red-first unit tests)

The logic lives in pure view functions, so it is tested without a browser:

- `goalPanelView(loops, sessionID, now)`:
  - **the screenshot bug**: a running loop on session A and page session B gives *no* goal on B (red
    against today's strip, which shows A's);
  - idle on B with a remembered input from A gives B's own last input or none, never A's;
  - every status and phase maps to one label and one token (a table test);
  - the goal text is returned whole; only the view clamps;
  - `checkedAt`/`promptedAt` render as relative times.
- The manager: two sessions can each start a loop; starting a second loop on the *same* session
  still refuses; stop on A leaves B running; the old single persisted record migrates to its session.
- `taskRowView(info, now)`: elapsed time, wake wording for each state, the idle-reaper wording.
- `todoDockView(todos, updatedAt, stepsSince, evidence, now)`: fresh, old-but-idle (not stale), and
  stale; the three provenance levels; the counter wording.
- Server: the task event fires on each status change and is throttled while output grows; the per-task
  stop kills only that tree and refuses another session's task (extends `shell-tasks.test.ts`).

## 5. The thin untestable layer

- Layout and visual polish at the real window sizes. Checked by hand and with CDP screenshots of the
  dev app (the `edge-cdp` flow), at the widths Gary uses, in the Legatus theme, dark and light.
- Whether the badges and docks are noticed. That is the purpose; it is judged by use.

## 6. Failure modes

- **Many loops at once** can overload a small machine (each polls every 2 s). The manager caps running
  loops (default 4) and says so on refusal.
- **Event storms** from a noisy build: the task event is throttled to once a second per task.
- **The stale warning is wrong** when the agent works for a long time without needing to update a list
  that is still correct. It is a warning, not a change of data, and the thresholds are settings.
- **A verified mark outlives the work**: a later edit breaks an item the verifier confirmed. The mark
  carries its time, and the next verification replaces it.

## 7. Interaction with the techniques

- **#1 background shell:** this is the UI it was waiting for. After it ships, #1's default flips on.
- **#4 todo reminders:** the dock and the reminders read the same table. The staleness rule uses the
  same steps-since-write figure that accuracy D's checkpoint prints, so the model and the human see the
  same age.
- **#6 checkpoints (accuracy D):** the checkpoint and the dock use the same provenance words
  ("declared", "verified").
- **#7 verifier (accuracy E):** the panel is where a verdict is shown. Accuracy E stays off by default
  until the panel shows it.
- **#2, #3, #5:** none.

## 8. Default, and how the effect is measured

- **Default: on.** It is UI, and it replaces a strip that shows the wrong session's goal. There is
  nothing to gain by keeping the old one.
- **Accuracy:** the UI has no direct effect on the eval, which runs headless. What it unlocks does:
  turning #1 on by default. That flip is measured as an ablation of `background_shell` under the
  shared protocol (`accuracy-c.md` §7), with its mechanism metric being foreground commands that sleep
  or poll (`Start-Sleep`, `sleep`, `timeout /t`, retry loops) per task, from the shell tool's recorded
  inputs.
- **The UI itself** is checked against the four screenshot problems, each as a before/after CDP
  screenshot of the dev app: the Muse #2 page shows only Muse #2's goal; the Start control is a button;
  the state, check time and iterations are visible; a stale todo list is labeled stale.

## 9. Files touched (when implemented)

| File | Change |
|---|---|
| `packages/desktop/src/main/goal-loop.ts` | `phase`, `checkedAt`, `promptedAt` on the state |
| `packages/desktop/src/main/goal-loops.ts` (new), `main/index.ts`, `ipc.ts`, `store-keys.ts`, `preload/*` | the per-session manager, per-session persistence and IPC |
| `packages/app/src/goal-loop/types.ts` | state fields; `sessionID` on stop/status |
| `packages/app/src/pages/session/goal-panel.tsx` (new) | replaces `pages/layout/sidebar-goal-loop.tsx` at `session.tsx:2293` |
| `packages/app/src/pages/layout/sidebar-items.tsx` | the goal badge on a session row |
| `packages/app/src/pages/session/composer/session-task-dock.tsx` (new), `session-composer-region.tsx` | the background tasks dock |
| `packages/app/src/pages/session/composer/session-todo-dock.tsx`, `session-composer-state.ts` | age, staleness, provenance |
| `packages/opencode/src/tool/shell/tasks.ts`, `server/.../experimental.ts` | the task event, per-task stop, `tail` and `wake` |
| `packages/opencode/src/session/todo.ts`, `packages/schema/src/session-todo.ts` | `updatedAt` on get and on the event |
| `packages/app/src/i18n/en.ts` (other locales fall back) | new strings |
| tests | the view-function tests above, `goal-loop.test.ts`, `shell-tasks.test.ts` |

## 10. Open items

- The web app has no goal loop (desktop only). The task dock and the todo changes work on web too,
  because they read server state.
- The TUI gets none of this in this note. The task list endpoint serves it later.

## 11. Decision requested

**One loop per session, or one loop that is displayed correctly.** This note changes the engine to
hold one loop per session, because Gary runs Muse #1 and Muse #2 side by side and today the second
cannot have a loop at all (`goal-loop.ts:737`). The smaller change keeps a single loop and only fixes
the display: show the loop on its own session's page, and show "a goal loop is running in <other
session>" elsewhere. The per-session engine touches the main process, IPC, preload and persistence.
The display-only fix touches only the app, but it leaves the one-loop limit that caused the confusion
in the first place. The note proposes the per-session engine.
