// Recovery for a provider that refuses replayed encrypted reasoning.
//
// Responses providers return encrypted reasoning with each turn, and the harness
// replays it on the next request so the model keeps its chain of thought. The
// provider only accepts encrypted reasoning it issued to the same caller. When the
// caller changes (another key, account or org behind a gateway), it answers every
// request of the session with a non-retryable 400, "reasoning encrypted_content
// was not issued to this caller", and the session is dead.
//
// On that exact error the request is sent once more without the encrypted
// reasoning and the reasoning item ids tied to it. It is never stripped up front:
// encrypted reasoning the provider accepts is kept.
//
// Pure, so the rule is unit-tested and ports as-is.

import type { ModelMessage } from "ai"
import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"

type Err = ReturnType<NamedError["toObject"]>

const REJECTED = /encrypted_content was not issued to this caller/i

/** True for the provider's refusal of replayed encrypted reasoning, and nothing else. */
export function rejected(error: Err) {
  if (!SessionV1.APIError.isInstance(error)) return false
  if (error.data.statusCode !== 400) return false
  return REJECTED.test(error.data.message) || REJECTED.test(error.data.responseBody ?? "")
}

/** The same messages with encrypted reasoning and reasoning item ids removed from reasoning parts. */
export function strip(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "reasoning" && part.providerOptions
          ? { ...part, providerOptions: withoutEncrypted(part.providerOptions) }
          : part,
      ),
    }
  })
}

/** Whether any reasoning part still carries encrypted reasoning, so a retry would change the request. */
export function carries(messages: ModelMessage[]) {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "reasoning" &&
          Object.values(part.providerOptions ?? {}).some(
            (options) => options !== null && typeof options === "object" && "reasoningEncryptedContent" in options,
          ),
      ),
  )
}

function withoutEncrypted(options: NonNullable<ModelMessage["providerOptions"]>) {
  return Object.fromEntries(
    Object.entries(options).map(([provider, value]) => {
      if (value === null || typeof value !== "object") return [provider, value]
      const { reasoningEncryptedContent: _content, itemId: _id, ...rest } = value as Record<string, unknown>
      return [provider, rest]
    }),
  ) as NonNullable<ModelMessage["providerOptions"]>
}

export * as ReasoningReplay from "./reasoning-replay"
