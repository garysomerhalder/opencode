import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import * as InstanceState from "@/effect/instance-state"
import { installPlugin, patchPluginConfig, readPluginManifest, unpatchPluginConfig } from "@/plugin/install"
import { PluginMeta } from "@/plugin/meta"
import { parsePluginSpecifier, pluginDisplayId, pluginSource } from "@/plugin/shared"
import { errorMessage } from "@/util/error"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  PluginInstallError,
  PluginInstallPayload,
  PluginRemoveError,
  PluginRemovePayload,
  type PluginItem,
} from "../groups/plugin"

function findMeta(spec: string, store: Awaited<ReturnType<typeof PluginMeta.list>>) {
  const direct = Object.values(store).find((entry) => entry.spec === spec)
  if (direct) return direct
  if (pluginSource(spec) === "file") return
  const pkg = parsePluginSpecifier(spec).pkg
  return Object.values(store).find(
    (entry) => entry.source === "npm" && parsePluginSpecifier(entry.spec).pkg === pkg,
  )
}

export const pluginHandlers = HttpApiBuilder.group(InstanceHttpApi, "plugin", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service

    const list = Effect.fn("PluginHttpApi.list")(function* () {
      const info = yield* config.get()
      const store = yield* Effect.promise(() => PluginMeta.list())
      const plugins: Array<typeof PluginItem.Type> = (info.plugin_origins ?? []).map((origin) => {
        const spec = ConfigPlugin.pluginSpecifier(origin.spec)
        const meta = findMeta(spec, store)
        return {
          id: pluginDisplayId(spec),
          spec,
          source: origin.source,
          scope: origin.scope,
          version: meta?.version,
          loadCount: meta?.load_count,
          lastTime: meta?.last_time,
        }
      })
      return { plugins }
    })

    const install = Effect.fn("PluginHttpApi.install")(function* (ctx: {
      payload: typeof PluginInstallPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const spec = ctx.payload.spec.trim()
      if (!spec) {
        return yield* Effect.fail(new PluginInstallError({ message: "Plugin spec is required" }))
      }

      const target = yield* Effect.promise(() => installPlugin(spec))
      if (!target.ok) {
        return yield* Effect.fail(new PluginInstallError({ message: errorMessage(target.error) }))
      }

      const manifest = yield* Effect.promise(() => readPluginManifest(target.target))
      if (!manifest.ok) {
        return yield* Effect.fail(
          new PluginInstallError({
            message:
              manifest.code === "manifest_no_targets"
                ? `"${spec}" does not expose plugin entrypoints in package.json`
                : `Installed "${spec}" but failed to read ${manifest.file}: ${errorMessage(manifest.error)}`,
          }),
        )
      }

      const out = yield* Effect.promise(() =>
        patchPluginConfig({
          spec,
          targets: manifest.targets,
          global: ctx.payload.global,
          vcs: instance.project.vcs,
          worktree: instance.worktree,
          directory: instance.directory,
        }),
      )
      if (!out.ok) {
        return yield* Effect.fail(
          new PluginInstallError({
            message:
              out.code === "invalid_json"
                ? `Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`
                : errorMessage(out.error),
          }),
        )
      }

      yield* config.invalidate()

      return {
        dir: out.dir,
        server: manifest.targets.some((item) => item.kind === "server"),
        tui: manifest.targets.some((item) => item.kind === "tui"),
      }
    })

    const remove = Effect.fn("PluginHttpApi.remove")(function* (ctx: {
      payload: typeof PluginRemovePayload.Type
    }) {
      const instance = yield* InstanceState.context
      const spec = ctx.payload.spec.trim()
      if (!spec) {
        return yield* Effect.fail(new PluginRemoveError({ message: "Plugin spec is required" }))
      }

      const out = yield* Effect.promise(() =>
        unpatchPluginConfig({
          spec,
          global: ctx.payload.global,
          vcs: instance.project.vcs,
          worktree: instance.worktree,
          directory: instance.directory,
        }),
      )
      if (!out.ok) {
        return yield* Effect.fail(
          new PluginRemoveError({
            message:
              out.code === "invalid_json"
                ? `Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`
                : errorMessage(out.error),
          }),
        )
      }

      yield* config.invalidate()

      return {
        removed: out.items.flatMap((item) => item.removed),
        files: out.items.filter((item) => item.mode === "removed").map((item) => item.file),
      }
    })

    return handlers.handle("list", list).handle("install", install).handle("remove", remove)
  }),
)
