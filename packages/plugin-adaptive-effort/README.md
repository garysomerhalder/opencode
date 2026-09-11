# opencode-adaptive-effort

Automatically picks the reasoning-effort tier for each message, routes
I/O-heavy grunt work to the small model, and shunts large file reads to the
small model for summarization — so the frontier model never ingests content it
doesn't need to reason about.

Inspired by the routing pattern Spotify described for cutting agent token spend
(Portal's `bulk-reader` / `code-writer`), operating at both the message level and
the tool level.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": [
    ["opencode-adaptive-effort", { "classifier": "rules" }]
  ]
}
```

or load from a local directory:

```json
{
  "plugin": [
    ["./packages/plugin-adaptive-effort", { "classifier": "rules" }]
  ]
}
```

## How it works

### 1. Message routing (`chat.message`)

Every new user message runs through the `chat.message` hook:

1. **Classify** the prompt into `trivial | easy | medium | hard` and decide
   whether it is grunt work (summarizing, renaming, formatting, boilerplate,
   many file attachments).
2. **Route**: grunt work swaps the message to `small_model` so the frontier
   model never sees the turn.
3. **Effort**: otherwise, the message's reasoning-effort `variant` is set to
   `low` (trivial/easy) or `high` (hard), leaving `medium` untouched.

An explicitly selected variant (user picked one in the model picker) is always
respected and never overridden.

### 2. Read shunting (`tool.execute.after`)

When the `read` tool returns a file over `minLines` lines, the plugin replaces
the file content with a structured summary produced by the small model, so the
raw file never enters the frontier model's context. This is the mechanism that
produces the bulk of token savings — keeping I/O out of the expensive model.

Targeted reads pass through untouched:

- reads with an explicit `offset`
- reads with an explicit `limit <= minLines`
- small files (<= `minLines` lines)

If the frontier model later needs exact lines to edit, it re-reads the specific
section — the summary only replaces bulk reads.

## Options

| Option       | Type                                     | Default | Description |
| ------------ | ---------------------------------------- | ------- | ----------- |
| `enabled`    | `boolean`                                | `true`  | Master switch. |
| `classifier` | `"rules"` \| `"hybrid"`                  | `"rules"` | `"hybrid"` refines ambiguous `medium` prompts with a one-shot small-model classifier. |
| `smallModel` | `string`                                 | config `small_model` | Explicit `provider/model` to route grunt work and summaries to. Falls back to the configured `small_model`. |
| `read`       | `boolean`                                | `true`  | Enable read shunting. |
| `minLines`   | `number`                                 | `350`   | Files above this line count get summarized instead of loaded raw. |
| `efforts`    | `Partial<Record<"trivial"\|"easy"\|"medium"\|"hard", string \| null>>` | — | Override the effort variant per difficulty. `null` means "leave the default variant". |

### Example

```json
{
  "plugin": [
    ["opencode-adaptive-effort", {
      "classifier": "hybrid",
      "smallModel": "openai/gpt-5-nano",
      "minLines": 500,
      "efforts": { "hard": "max", "easy": null }
    }]
  ]
}
```

## Notes

- Effort switching relies on the model's reasoning-effort `variants`
  (`low` / `medium` / `high`). Models without those variants are unaffected.
- Routing and read shunting require a resolvable `small_model`. If none is
  configured, grunt work falls back to the main model at `low` effort, and
  large reads are left raw.
- The hybrid classifier and the read summarizer run in throwaway sessions and
  are skipped for their own messages, so they cannot recurse.
- Summaries are lossy by design. The frontier model keeps full editing fidelity
  by re-reading specific sections when it needs exact line references.
