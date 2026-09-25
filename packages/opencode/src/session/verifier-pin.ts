// The verifier's model, pinned when its session is created (docs/accuracy-e.md
// §11.8, final check of Phase 3). Config decides which model and provider the
// verifier agent runs on; a worker that could change it could point the verifier
// at a model of its own and have it say anything. The pin records what the
// verifier resolved to at creation, and the verdict tool refuses to record
// anything once the live resolution differs.
import { createHash } from "crypto"
import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"

export const Pin = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  /** The endpoint requests go to: the provider's baseURL option, else the model's API URL. */
  baseURL: Schema.optional(Schema.String),
  /** sha256 of the provider's effective config (options, key, source) and the model's API. */
  configHash: Schema.String,
})
export type Pin = Schema.Schema.Type<typeof Pin>

/** JSON with object keys sorted, so a hash does not depend on key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

/** What the verifier agent resolves to now; undefined when it cannot be resolved. */
export const resolve = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const agent = yield* agents.get(Permission.VERIFIER)
  const ref = agent.model ?? (yield* provider.defaultModel())
  const info = yield* provider.getProvider(ref.providerID)
  const model = yield* provider.getModel(ref.providerID, ref.modelID)
  const baseURL = typeof info.options?.baseURL === "string" ? info.options.baseURL : model.api.url
  const configHash = createHash("sha256")
    .update(stable({ source: info.source, key: info.key ?? null, options: info.options, api: model.api }))
    .digest("hex")
  return {
    providerID: String(ref.providerID),
    modelID: String(ref.modelID),
    ...(baseURL ? { baseURL } : {}),
    configHash,
  } satisfies Pin
}).pipe(
  Effect.catchCause(() => Effect.succeed(undefined)),
  Effect.withSpan("VerifierPin.resolve"),
)

/** Why `live` is not the pinned resolution; undefined when it is. */
export function differs(pinned: Pin, live: Pin | undefined) {
  if (live === undefined) return "the verifier's model can no longer be resolved"
  const changed = [
    pinned.providerID !== live.providerID ? "provider" : undefined,
    pinned.modelID !== live.modelID ? "model" : undefined,
    pinned.baseURL !== live.baseURL ? "endpoint" : undefined,
    pinned.configHash !== live.configHash ? "provider config" : undefined,
  ].filter(Boolean)
  return changed.length ? `its ${changed.join(", ")} changed` : undefined
}

/** The error the verdict tool refuses with. */
export function refused(reason: string) {
  return `the verifier's model or provider changed since this verification was created (${reason}); the verdict is not recorded`
}

export * as VerifierPin from "./verifier-pin"
