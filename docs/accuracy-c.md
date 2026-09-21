# Accuracy C: tool-output budgets with recoverable receipts

Status: **design only, not implemented.** Branch `docs/accuracy-c-design`. This is technique #5 in
`plans/legatus-harness/plan.md` ("Accuracy features"). No code until the architect approves.

Motivation: see `accuracy-a.md`. Same model, a 27-point harness gap. Tool output is what fills
the context window, and the harness decides how much of it the model sees. Today most of the "archive"
half already exists for single calls. What is missing is a budget across calls, a preview that keeps
the end of a log, a receipt the model can act on, and a receipt for the one path that throws output
away.

## 1. What happens today (evidence)

Every non-exempt tool result passes through one truncation service. When it is over budget, the full
text is written to disk and the model sees a preview and a path. That is the right idea, and this note
keeps it. The problems are around it.

| # | Finding | Where |
|---|---|---|
| 1 | The per-call cap is 2000 lines / 50 KB (`tool_output.max_lines/max_bytes` overrides it). | `packages/opencode/src/tool/truncate.ts:14-15`, `:75-83`; config `packages/core/src/v1/config/config.ts:136-147` |
| 2 | The generic wrapper truncates every tool result unless the tool already set `metadata.truncated`. | `packages/opencode/src/tool/tool.ts:131-144` |
| 3 | MCP and plugin tools go through the same service. | `session/tools.ts:196`, `:279`, `:354`, `:464`; `tool/registry.ts:164` |
| 4 | `read` bounds itself (2000 lines, 50 KB, 2000 chars/line) and pages with `offset`. It sets `truncated`, so the wrapper leaves it alone. | `tool/read.ts:14-16`, `:343-347`, `:363-373` |
| 5 | The shell tool keeps the **tail** and spills to a file itself. | `tool/shell.ts:572-582`, `:645-650` |
| 6 | Everything else keeps the **head** only (`direction` defaults to `"head"`). A compiler or test run through MCP or a plugin loses the summary and the error at the end. The V2 store already does head+tail. | `tool/truncate.ts:89`, `:102-111`; V2: `packages/core/src/tool-output-store.ts:74-104` |
| 7 | The full text is archived (`write`), and the path is in a prose hint. The hint is the whole receipt: nothing structured says how big the output was, what part is shown, or how to page it. | `tool/truncate.ts:127-140` |
| 8 | **There is no budget across calls.** Each call is capped on its own, so ten parallel `grep`/`bash`/MCP calls at 50 KB each put ~500 KB (~125k tokens) into one step. The only guard is after the fact: `isOverflow` reads the *last finished* turn's token count and triggers compaction. | `session/overflow.ts:22-32`; `session/prompt.ts:1238-1245` |
| 9 | **Pruning discards without a receipt.** `prune` marks old tool parts `compacted`, and the model conversion replaces their output with `[Old tool result content cleared]`. No path, no size, no way back, even though the text is still stored on the part. Prune is off by default. | `session/compaction.ts:272-320`; `session/message-v2.ts:301-302`; default `config.ts:154-156` |
| 10 | Archives live in one global directory, named `tool_<ascending id>`, deleted by **file mtime** after 7 days. A session resumed after a week holds receipts that point at nothing. | `tool/truncate.ts:12`, `:53-66`, `truncation-dir.ts` |
| 11 | Reading an archive is already allowed: the truncation directory is whitelisted for `external_directory`. | `agent/agent.ts:108-117` |
| 12 | The conversion already has an unused per-output cap (`toolOutputMaxChars`), used only by a test. | `session/message-v2.ts:49-53`, `:303`; `test/session/message-v2.test.ts:814` |

So "archive, not discard" is 80% true for single calls. The discard paths are #8 (the context
overflows, compaction summarizes, and the head of the session is gone) and #9 (prune).

## 2. Design

Four parts. A and B change what a single result looks like. C adds the budget across calls. D fixes
prune.

### A. One receipt format

Every result that is cut gets the same envelope, whether the per-call cap, the step budget or prune
cut it:

```
<tool-output-archived tool="bash" call="call_…" bytes="812345" lines="20411" shown="lines 1-60, 20352-20411">
…head…
… 20291 lines not shown …
…tail…
Full output: <path>
Read more with read({ filePath: "<path>", offset: 20000, limit: 400 }) or grep on that path.
The command already ran. Do not rerun it to see more output.
</tool-output-archived>
```

- The metadata gets `archive: { path, bytes, lines, shown: [[1,60],[20352,20411]], sha256 }` next to
  the existing `truncated` / `outputPath`, so clients and the checkpoint (accuracy D) can list receipts
  without parsing text.
- The retrieval route is **a path plus the tools that already exist** (`read` with offset/limit,
  `grep`), not a new tool. That matches accuracy-B, which put background-task output in the same
  directory for the same reason: the read permission, the path handling and the retention already
  apply. The existing `hasTaskTool` variant of the hint (delegate to `explore`) stays
  (`truncate.ts:129-131`).
- The shell tool keeps its own tail logic and the background-task receipt. It only adopts the
  envelope's metadata, so the checkpoint can list its archives the same way.

### B. Head and tail by default

`Truncate.output` defaults to a head+tail preview (port `boundedPreview` from the V2 store), with the
marker between the halves. `direction: "head" | "tail"` stays for callers that want one end. Reason:
for the outputs that matter most for accuracy (builds, test runs, linters), the verdict is at the end.

### C. A budget across the calls of one step

- **Where.** At step end in the processor, at the same point where the runaway guard is fed: after
  `cleanup()` has settled every tool part and before the next request (`session/processor.ts:727-737`).
  The inputs are the step's tool parts. The output is a per-part decision.
- **What it decides.** If the sum of the step's non-exempt outputs is over `step_bytes`, it
  lowers the per-part limit **largest first** until the sum fits. No part goes below `floor_bytes`
  (head+tail). A pure function, `OutputBudget.plan(parts, settings) -> Map<callID, maxBytes>`.
- **Stored once, applied at conversion.** The decision is written to the part as
  `metadata.budget = { maxBytes }`. `message-v2.ts` applies it where it already applies
  `toolOutputMaxChars` (`:303`), with the envelope from A. The stored output is never rewritten, so
  the UI still shows what it shows today. The decision is persisted rather than recomputed so that the
  conversion is identical on every later request, which keeps the prompt-cache prefix stable.
- **The archive.** If the part was not already archived by the per-call cap, the budget writes its
  output to the archive first and then records the decision. A budgeted part therefore always has a
  file to point at. This is what makes it "archive, not discard".

**Exempt tools**, the ones "whose full output is the point":

| Tool | Why exempt |
|---|---|
| `read` | The model named the file and the range. It already pages itself (finding 4). Cutting it again only produces a re-read, which is runaway-guard fodder (accuracy A §B). |
| `skill` | Instructions the model loaded on purpose. Prune already protects it (`compaction.ts:32`). |
| `todowrite`, `question`, `StructuredOutput` | Small, and their content is state, not data. |
| `shell_output` | Already bounded, cursor-based (accuracy B §4). |
| any output already carrying an archive envelope | Never budget a receipt. |

If the exempt outputs alone are over the budget, the step goes through unchanged. The overflow path
that exists today (compaction) handles it. The budget never refuses a result.

Settings:

```jsonc
"experimental": { "accuracy": {
  "output_receipts": true,         // A + B + D: the envelope, head+tail, prune receipts
  "output_budget": false,          // C: the budget across calls
  "output_budget_step_bytes": 131072,  // 128 KB per step for non-exempt outputs
  "output_budget_floor_bytes": 4096    // no budgeted part shown smaller than this
} }
```

### D. Prune writes a receipt

In `prune` (`compaction.ts:311-319`), before a part is marked `compacted`, make sure it has an archive:
reuse `metadata.outputPath` / `archive` if the per-call cap made one, otherwise write `state.output`
with `Truncate.write`. The conversion (`message-v2.ts:301-302`) then emits a one-line receipt instead
of `[Old tool result content cleared]`:

```
[Tool output archived: bash, 8.2 KB, <path>. Read it again with read or grep if you need it; do not rerun.]
```

Prune stays off by default. This note only removes its one silent discard.

## 3. What is decidable (red-first unit tests)

All of these are pure functions or single-service calls, and each one is written red first:

- `OutputBudget.plan`
  - under budget: no decisions;
  - over budget: the largest part is lowered first, and the sum ends at or under `step_bytes`;
  - no part goes below `floor_bytes`, even if that means ending over budget;
  - exempt tools are never in the result, and a step of only exempt outputs gets no decisions;
  - a part that already carries an envelope is never lowered again;
  - the result is deterministic for the same input (same order, same numbers).
- `Truncate.output` head+tail: the tail survives (an `error:` on the last line of a 5000-line output
  is in the preview); `direction` keeps the old head or tail behavior; the result is within
  `maxBytes` including the marker.
- The envelope: `bytes`, `lines` and `shown` match the input; the path in the text equals
  `metadata.archive.path`; the text contains the "do not rerun" line.
- Conversion (`message-v2.test.ts`): a part with `metadata.budget` reaches the model as the envelope;
  the same part converts to byte-identical text twice (cache stability); a part without it is
  unchanged.
- Prune: a pruned part without an archive gets one written, and its conversion is the one-line
  receipt with a path that exists; a part archived before is not written twice.
- Secrets: the budget's log record is `{ kind: "output_budget", tool, bytes, shown, archived }`. A
  test asserts that a secret printed by a tool is not in the log record (same rule as accuracy A).

Integration (`accuracy-loop.test.ts` style, scripted LLM): with the budget on, a step whose tool output
is over budget reaches the next request as an envelope, and the archive file holds the full text. With
it off, the request is what it is today. (The scripted LLM merges parallel calls into one, as accuracy A
notes, so the multi-part case stays at unit level.)

## 4. The thin untestable layer

- Whether a model actually uses the receipt (reads the path) instead of rerunning the command. The
  wording is a prompt-engineering guess. The eval measures it (section 7).
- The chosen `step_bytes`. 128 KB is a starting point, not a derived number.

## 5. Failure modes

- **The archive is gone** (7-day mtime retention, finding 10). `read` fails with file-not-found and the
  model probably reruns. Mitigation in this note: a failed `read` on a path inside the truncation
  directory says "archived output expired" rather than a bare not-found, so the model knows why.
  Changing the retention is an open item (section 9).
- **The write fails** (disk full, permissions). The budget then does **not** lower the part (it fails
  open, like the guard). Showing the full output is better than a receipt to nothing.
- **The model reruns anyway.** The runaway guard (accuracy A) sees the repeated action and nudges.
- **Receipts crowd the context.** Each envelope costs ~120 tokens plus its preview; `floor_bytes`
  bounds it.
- **A budgeted part the model needs in full**, for example a `webfetch` of a spec. It is one `read` away
  and was never lost. That is the trade the budget makes, and why it is off by default.

## 6. Interaction with the shipped techniques

- **#1 background shell (accuracy B):** background output already lives in the same directory with a
  receipt. `shell_output` is exempt. The wake note's tail is already bounded (40 lines / 4 KB). No
  change there.
- **#3 runaway guard:** a rerun of a truncated command is exactly an "action repeat". The guard's
  result fingerprint hashes the *stored* output (bounded), which the budget does not rewrite, so the
  budget does not change what the guard sees.
- **#4 todo reminders:** none. `todowrite` is exempt.
- **#6 checkpoints (accuracy D):** the checkpoint lists the session's archives from `metadata.archive`,
  so receipts that scrolled out of the retained tail can still be found after compaction.
- **#7 verifier (accuracy E):** host-run checks are budgeted like any tool output, and the verifier
  can read the archive (the truncation directory is its only external read).

## 7. Default, and how the effect is measured

**Default:** `output_receipts` **on**: it gives the model strictly more than today (the end of the
log, a structured receipt, and a path where prune used to erase). `output_budget` **off**: it removes
text the model would otherwise see, so it has to earn its default in the eval.

### Measurement protocol (shared by accuracy C, D and E)

The accuracy eval in the plan (`plan.md:83`: FrontierHarness tasks through a Harbor adapter, at least 3
runs per configuration, one ablation per feature) **does not exist in this repo yet**. These notes do
not claim an effect. They say what to run once it exists:

- **Configurations.** `baseline` = dev with #1–#4 at their shipped defaults. Then one arm per feature:
  baseline plus the one flag. Then `all` = every candidate feature on. Same model (Kimi K3, as in the
  published run), same task set, same seed policy.
- **Runs.** At least 3 runs per arm. 30 tasks × 3 runs gives each arm 90 attempts. At a ~60% pass rate
  one run's standard error is about 9 points, so a difference of a few points is noise. The analysis
  is **paired by task**: per task, pass rate in the arm minus pass rate at baseline, then a bootstrap
  over tasks for the confidence interval. Report the interval, not only the mean.
- **Decision rule, written before the runs.** A default flips on when the interval's lower bound is
  above −2 points **and** the mechanism metric below moves in the expected direction. A feature that
  helps on average but takes a task from ≥2/3 to 0/3 gets that task read by hand before it ships.
- **Mechanism metrics** (from the harness's own log records, so an effect can be explained, not only
  observed):
  - C: steps where the budget fired; bytes kept out of context; how many receipts were followed by a
    `read`/`grep` of the path vs a rerun of the same command; overflow compactions per task.
  - D, E: listed in their notes.

For this note specifically, the arms are `baseline`, `+output_receipts`, `+output_budget`, and both.

## 8. Files touched (when implemented)

| File | Change |
|---|---|
| `packages/opencode/src/tool/truncate.ts` | head+tail default; the envelope; `archive` metadata |
| `packages/opencode/src/session/output-budget.ts` (new) | pure `plan` + settings |
| `packages/opencode/src/session/processor.ts` | step end: plan, archive, write `metadata.budget` |
| `packages/opencode/src/session/message-v2.ts` | apply `metadata.budget`; the prune receipt |
| `packages/opencode/src/session/compaction.ts` | prune archives before marking |
| `packages/opencode/src/tool/read.ts` | the "archived output expired" message for the truncation directory |
| `packages/opencode/src/session/accuracy.ts`, `packages/core/src/v1/config/config.ts` | the four settings |
| tests | `output-budget.test.ts` (new), `truncation.test.ts`, `message-v2.test.ts`, `compaction.test.ts`, `accuracy-loop.test.ts` |

## 9. Scope and open items

- V1 loop only, like accuracy A and B. The V2 store (`core/src/tool-output-store.ts`) already does
  head+tail. It needs the envelope and the step budget when V2 becomes the default.
- **Retention.** The archive's lifetime should follow the session, not the file's mtime. That means
  either per-session directories (which touches the whitelisted glob in `agent.ts:108-117`) or a
  cleanup that skips files a live session references. This is left open. The expired-archive
  message in section 5 is the stopgap.
- The archive is not redacted, the same as the shell path today (accuracy B §3). Redaction belongs to
  a separate change for all output paths at once.

## 10. Decision requested

**Where the step budget takes effect.** This note stores the budget's decision on the part
(`metadata.budget`) and applies it when converting messages for the model, leaving the stored output
as it is today. The alternative is to rewrite `state.output` at step end, so the DB and the UI hold only
the preview and the archive file is the only full copy. The first keeps the UI and the guard's
fingerprints unchanged and keeps the prompt-cache prefix stable, but it puts one more rule into
`message-v2.ts` that the V2 engine will also need. The second is simpler to port, but it makes the
7-day archive retention (section 9) the only thing between the model and a real loss. The note
proposes the first.
