import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ReasoningReplay } from "../../src/session/reasoning-replay"

// The 400 a Responses provider returns when it is handed encrypted reasoning that
// another caller (another key, account or org) was issued. Recorded 2026-09-21.
const recorded = () =>
  new SessionV1.APIError({
    message: "reasoning encrypted_content was not issued to this caller",
    statusCode: 400,
    isRetryable: false,
    responseBody: JSON.stringify({
      error: {
        message: "reasoning encrypted_content was not issued to this caller",
        type: "invalid_request_error",
        param: "input",
        code: null,
      },
    }),
  }).toObject()

const history = (): ModelMessage[] => [
  { role: "user", content: [{ type: "text", text: "fix the build" }] },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "look at the error first",
        providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "gAAAA-secret", other: 1 } },
      },
      { type: "text", text: "Reading the log.", providerOptions: { openai: { itemId: "msg_1" } } },
    ],
  },
]

describe("ReasoningReplay.rejected", () => {
  test("recognizes the recorded 400", () => {
    expect(ReasoningReplay.rejected(recorded())).toBe(true)
  })

  test("recognizes it when only the response body carries the text", () => {
    const error = new SessionV1.APIError({
      message: "Bad Request",
      statusCode: 400,
      isRetryable: false,
      responseBody: '{"error":{"message":"reasoning encrypted_content was not issued to this caller"}}',
    }).toObject()
    expect(ReasoningReplay.rejected(error)).toBe(true)
  })

  test("ignores other 400s, other statuses and other errors", () => {
    const other400 = new SessionV1.APIError({
      message: "The request contains invalid parameters.",
      statusCode: 400,
      isRetryable: false,
    }).toObject()
    const as500 = new SessionV1.APIError({
      message: "reasoning encrypted_content was not issued to this caller",
      statusCode: 500,
      isRetryable: true,
    }).toObject()
    expect(ReasoningReplay.rejected(other400)).toBe(false)
    expect(ReasoningReplay.rejected(as500)).toBe(false)
    expect(ReasoningReplay.rejected(new SessionV1.ContextOverflowError({ message: "x" }).toObject())).toBe(false)
  })
})

describe("ReasoningReplay.strip", () => {
  test("drops the encrypted reasoning and its item id, keeps everything else", () => {
    const [user, assistant] = ReasoningReplay.strip(history())
    expect(user).toEqual(history()[0]!)
    const content = assistant!.content as Array<{ type: string; providerOptions?: Record<string, unknown> }>
    expect(content[0]!.providerOptions).toEqual({ openai: { other: 1 } })
    expect(JSON.stringify(content)).not.toContain("gAAAA-secret")
    expect(JSON.stringify(content)).not.toContain("rs_1")
    // a non-reasoning part keeps its item id
    expect(content[1]!.providerOptions).toEqual({ openai: { itemId: "msg_1" } })
  })

  test("strips under any provider key", () => {
    const input: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "t",
            providerOptions: { azure: { itemId: "rs_2", reasoningEncryptedContent: "x" } },
          },
        ],
      },
    ]
    const content = ReasoningReplay.strip(input)[0]!.content as Array<{ providerOptions?: Record<string, unknown> }>
    expect(content[0]!.providerOptions).toEqual({ azure: {} })
  })

  test("does not change the input", () => {
    const input = history()
    ReasoningReplay.strip(input)
    expect(input).toEqual(history())
  })

  test("reports whether there was anything to strip", () => {
    expect(ReasoningReplay.carries(history())).toBe(true)
    expect(ReasoningReplay.carries(ReasoningReplay.strip(history()))).toBe(false)
  })
})
