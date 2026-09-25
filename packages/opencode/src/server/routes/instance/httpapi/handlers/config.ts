import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import { Session } from "@/session/session"
import { requireHostWhileActive } from "../host-guard"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const sessions = yield* Session.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      // config decides the verifier's model and the plugins that load: while a goal or a
      // verification is active, only the host changes it (accuracy E §11.8)
      yield* requireHostWhileActive(sessions, ctx.request, (yield* InstanceState.context).project.id)
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
