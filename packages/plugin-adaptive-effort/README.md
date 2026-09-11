# opencode-adaptive-effort

Automatically picks the reasoning-effort tier for each message and routes
I/O-heavy grunt work to the small model, so the frontier model only spends
reasoning tokens where they actually matter.

Inspired by the routing pattern Spotify described for cutting agent token spend,
but operating at the message level: classify every prompt, then either drop the
effort tier (cheap tasks) or hand the whole turn to `small_model` (grunt work).

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

## Options

| Option       | Type                                     | Default | Description |
| ------------ | ---------------------------------------- | ------- | ----------- |
| `enabled`    | `boolean`                                | `true`  | Master switch. |
| `classifier` | `"rules"` \| `"hybrid"`                  | `"rules"` | `"hybrid"` refines ambiguous `medium` prompts with a one-shot small-model classifier. |
| `smallModel` | `string`                                 | config `small_model` | Explicit `provider/model` to route grunt work to. Falls back to the configured `small_model`. |
| `efforts`    | `Partial<Record<"trivial"\|"easy"\|"medium"\|"hard", string \| null>>` | — | Override the effort variant per difficulty. `null` means "leave the default variant". |

### Example

```json
{
  "plugin": [
    ["opencode-adaptive-effort", {
      "classifier": "hybrid",
      "smallModel": "openai/gpt-5-nano",
      "efforts": { "hard": "max", "easy": null }
    }]
  ]
}
```

## Notes

- Effort switching relies on the model's reasoning-effort `variants`
  (`low` / `medium` / `high`). Models without those variants are unaffected.
- Routing requires a resolvable `small_model`. If none is configured, grunt
  work falls back to the main model at `low` effort.
- The hybrid classifier runs in a throwaway session and is skipped for its own
  messages, so it cannot recurse.
