import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { TokenDiet } from "../../src/session/token-diet"
import { Token } from "@/util/token"

let seq = 0
const id = (prefix: string) => `${prefix}_${String(++seq).padStart(6, "0")}`

const user = (text = "go", reminder = false): SessionV1.WithParts => {
  const messageID = id("msg")
  return {
    info: {
      id: messageID,
      role: "user",
      sessionID: "ses_diet",
      time: { created: seq },
      agent: "build",
      model: { providerID: "meta", modelID: "muse-spark-1.3" },
    } as unknown as SessionV1.Info,
    parts: [
      reminder
        ? ({
            id: id("prt"),
            messageID,
            sessionID: "ses_diet",
            type: "reminder",
            kind: "wake",
            text,
          } as unknown as SessionV1.Part)
        : ({ id: id("prt"), messageID, sessionID: "ses_diet", type: "text", text } as unknown as SessionV1.Part),
    ],
  }
}

const tool = (name: string, output: string, compacted?: number): SessionV1.ToolPart =>
  ({
    id: id("prt"),
    messageID: "m",
    sessionID: "ses_diet",
    type: "tool",
    callID: id("call"),
    tool: name,
    state: {
      status: "completed",
      input: {},
      output,
      title: name,
      metadata: {},
      time: { start: 1, end: 2, ...(compacted ? { compacted } : {}) },
    },
  }) as unknown as SessionV1.ToolPart

const assistant = (parts: SessionV1.Part[], summary = false): SessionV1.WithParts => ({
  info: {
    id: id("msg"),
    role: "assistant",
    sessionID: "ses_diet",
    time: { created: seq },
    ...(summary ? { summary: true, finish: "stop" } : {}),
  } as unknown as SessionV1.Info,
  parts,
})

const big = (tokens: number) => "x".repeat(tokens * 4)

/** One autonomous turn: a single user message followed by `n` steps with one tool call each. */
const turn = (sizes: number[]) => [
  user(),
  ...sizes.map((size, i) => assistant([tool(i % 2 ? "read" : "bash", big(size))])),
]

describe("TokenDiet.staleToolParts", () => {
  test("collapses the outputs of the current turn beyond the most recent `keep`", () => {
    // The old prune never touched these: they are all in the last user turn.
    const messages = turn(Array(12).fill(5_000))
    const stale = TokenDiet.staleToolParts({ messages, keep: 8, minTokens: 20_000, estimate: Token.estimate })
    expect(stale.length).toBe(4)
    const all = messages.flatMap((msg) => msg.parts)
    // the oldest four, never the newest eight
    expect(stale.map((part) => part.id).sort()).toEqual(
      all
        .slice(1, 5)
        .map((part) => part.id)
        .sort(),
    )
  })

  test("waits until the stale outputs add up to minTokens, so the prompt is rewritten once per batch", () => {
    const messages = turn(Array(10).fill(5_000))
    // two stale outputs = 10k tokens < 20k: nothing yet
    expect(TokenDiet.staleToolParts({ messages, keep: 8, minTokens: 20_000, estimate: Token.estimate })).toEqual([])
    const more = turn(Array(12).fill(5_000))
    expect(
      TokenDiet.staleToolParts({ messages: more, keep: 8, minTokens: 20_000, estimate: Token.estimate }).length,
    ).toBe(4)
  })

  test("leaves skill output, small outputs and already collapsed outputs alone", () => {
    const messages = [
      user(),
      assistant([tool("skill", big(30_000))]),
      assistant([tool("bash", big(50))]),
      assistant([tool("bash", big(30_000), 123)]),
      ...Array.from({ length: 3 }, () => assistant([tool("bash", big(100))])),
    ]
    expect(TokenDiet.staleToolParts({ messages, keep: 2, minTokens: 1, estimate: Token.estimate })).toEqual([])
  })

  test("stops at the latest compaction summary: what came before it is not sent", () => {
    const before = turn(Array(6).fill(10_000))
    const summary = assistant([], true)
    const after = turn([100, 100])
    const stale = TokenDiet.staleToolParts({
      messages: [...before, summary, ...after],
      keep: 0,
      minTokens: 1,
      estimate: Token.estimate,
    })
    expect(stale).toEqual([])
  })
})

describe("TokenDiet.settings", () => {
  test("on by default, with the measured defaults", () => {
    const s = TokenDiet.settings({} as never)
    expect(s).toEqual({
      pinSystem: true,
      prune: true,
      keep: TokenDiet.DEFAULT_KEEP,
      minTokens: TokenDiet.DEFAULT_MIN_TOKENS,
    })
  })
  test("config overrides, and compaction.auto: false turns pruning off", () => {
    expect(
      TokenDiet.settings({
        experimental: { token_diet: { pin_system_prompt: false, prune_keep: 3, prune_min_tokens: 5 } },
      } as never),
    ).toEqual({ pinSystem: false, prune: true, keep: 3, minTokens: 5 })
    expect(TokenDiet.settings({ compaction: { auto: false } } as never).prune).toBe(false)
  })
})

describe("TokenDiet.pinKey / SystemPin", () => {
  test("a harness note does not change the key; a new user message or a compaction does", () => {
    const first = [user("task"), assistant([tool("bash", "ok")])]
    const key = TokenDiet.pinKey(first)
    expect(TokenDiet.pinKey([...first, user("<wake>", true)])).toBe(key)
    expect(TokenDiet.pinKey([...first, user("next task")])).not.toBe(key)
    expect(TokenDiet.pinKey([...first, assistant([], true)])).not.toBe(key)
  })

  test("serves the pinned value while the key holds, even if the source changed on disk", async () => {
    const pin = new TokenDiet.SystemPin<string>()
    let disk = "CLAUDE.md generated at 09:14"
    const load = Effect.sync(() => disk)
    expect(await Effect.runPromise(pin.get("ses_a", "k1", load))).toBe("CLAUDE.md generated at 09:14")
    disk = "CLAUDE.md generated at 09:15"
    expect(await Effect.runPromise(pin.get("ses_a", "k1", load))).toBe("CLAUDE.md generated at 09:14")
    // another session reads its own
    expect(await Effect.runPromise(pin.get("ses_b", "k1", load))).toBe("CLAUDE.md generated at 09:15")
    // a new turn re-reads
    expect(await Effect.runPromise(pin.get("ses_a", "k2", load))).toBe("CLAUDE.md generated at 09:15")
    expect(pin.size).toBe(2)
  })
})
