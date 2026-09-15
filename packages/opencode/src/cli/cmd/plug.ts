import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect } from "effect"
import type { Argv } from "yargs"

import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPaths } from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import {
  configurePluginOptions,
  installPlugin,
  patchPluginConfig,
  readPluginManifest,
  unpatchPluginConfig,
} from "../../plugin/install"
import { PluginMeta } from "../../plugin/meta"
import { parsePluginSpecifier, pluginDisplayId, pluginSource, resolvePluginTarget } from "../../plugin/shared"
import { errorMessage } from "../../util/error"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"

type Spin = {
  start: (msg: string) => void
  stop: (msg: string, code?: number) => void
}

export type PlugDeps = {
  spinner: () => Spin
  log: {
    error: (msg: string) => void
    info: (msg: string) => void
    success: (msg: string) => void
  }
  resolve: (spec: string) => Promise<string>
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "opencode" | "tui") => string[]
  global: string
}

export type PlugInput = {
  mod: string
  global?: boolean
  force?: boolean
}

export type PlugCtx = {
  vcs?: string
  worktree: string
  directory: string
}

const defaultPlugDeps: PlugDeps = {
  spinner: () => spinner(),
  log: {
    error: (msg) => log.error(msg),
    info: (msg) => log.info(msg),
    success: (msg) => log.success(msg),
  },
  resolve: (spec) => resolvePluginTarget(spec),
  readText: (file) => Filesystem.readText(file),
  write: async (file, text) => {
    await Filesystem.write(file, text)
  },
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
  global: Global.Path.config,
}

function cause(err: unknown) {
  if (!err || typeof err !== "object") return
  if (!("cause" in err)) return
  return (err as { cause?: unknown }).cause
}

export function createPlugTask(input: PlugInput, dep: PlugDeps = defaultPlugDeps) {
  const mod = input.mod
  const force = Boolean(input.force)
  const global = Boolean(input.global)

  return async (ctx: PlugCtx) => {
    const install = dep.spinner()
    install.start("Installing plugin package...")
    const target = await installPlugin(mod, dep)
    if (!target.ok) {
      install.stop("Install failed", 1)
      dep.log.error(`Could not install "${mod}"`)
      const hit = cause(target.error) ?? target.error
      if (hit instanceof Process.RunFailedError) {
        const lines = hit.stderr
          .toString()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        const errs = lines.filter((line) => line.startsWith("error:")).map((line) => line.replace(/^error:\s*/, ""))
        const detail = errs[0] ?? lines.at(-1)
        if (detail) dep.log.error(detail)
        if (lines.some((line) => line.includes("No version matching"))) {
          dep.log.info("This package depends on a version that is not available in your npm registry.")
          dep.log.info("Check npm registry/auth settings and try again.")
        }
      }
      if (!(hit instanceof Process.RunFailedError)) {
        dep.log.error(errorMessage(hit))
      }
      return false
    }
    install.stop("Plugin package ready")

    const inspect = dep.spinner()
    inspect.start("Reading plugin manifest...")
    const manifest = await readPluginManifest(target.target)
    if (!manifest.ok) {
      if (manifest.code === "manifest_read_failed") {
        inspect.stop("Manifest read failed", 1)
        dep.log.error(`Installed "${mod}" but failed to read ${manifest.file}`)
        dep.log.error(errorMessage(cause(manifest.error) ?? manifest.error))
        return false
      }

      if (manifest.code === "manifest_no_targets") {
        inspect.stop("No plugin targets found", 1)
        dep.log.error(`"${mod}" does not expose plugin entrypoints in package.json`)
        dep.log.info(
          'Expected one of: exports["./tui"], exports["./server"], package.json main for server, or package.json["oc-themes"] for tui themes.',
        )
        return false
      }

      inspect.stop("Manifest read failed", 1)
      return false
    }

    inspect.stop(
      `Detected ${manifest.targets.map((item) => item.kind).join(" + ")} target${manifest.targets.length === 1 ? "" : "s"}`,
    )

    const patch = dep.spinner()
    patch.start("Updating plugin config...")
    const out = await patchPluginConfig(
      {
        spec: mod,
        targets: manifest.targets,
        force,
        global,
        vcs: ctx.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
        config: dep.global,
      },
      dep,
    )
    if (!out.ok) {
      if (out.code === "invalid_json") {
        patch.stop(`Failed updating ${out.kind} config`, 1)
        dep.log.error(`Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`)
        dep.log.info("Fix the config file and run the command again.")
        return false
      }

      patch.stop("Failed updating plugin config", 1)
      dep.log.error(errorMessage(out.error))
      return false
    }
    patch.stop("Plugin config updated")
    for (const item of out.items) {
      if (item.mode === "noop") {
        dep.log.info(`Already configured in ${item.file}`)
        continue
      }
      if (item.mode === "replace") {
        dep.log.info(`Replaced in ${item.file}`)
        continue
      }
      dep.log.info(`Added to ${item.file}`)
    }

    dep.log.success(`Installed ${mod}`)
    dep.log.info(global ? `Scope: global (${out.dir})` : `Scope: local (${out.dir})`)
    return true
  }
}

function installOptions<T>(yargs: Argv<T>) {
  return yargs
    .positional("module", {
      type: "string",
      describe: "npm module name, path, or URL",
    })
    .option("global", {
      alias: ["g"],
      type: "boolean",
      default: false,
      describe: "install in global config",
    })
    .option("force", {
      alias: ["f"],
      type: "boolean",
      default: false,
      describe: "replace existing plugin version",
    })
}

function runInstall(mod: string, global: boolean, force: boolean) {
  return Effect.fn("Cli.plug.install")(function* () {
    UI.empty()
    intro(`Install plugin ${mod}`)

    const run = createPlugTask({ mod, global, force })

    const ctx = yield* InstanceRef
    if (!ctx) return
    const ok = yield* Effect.promise(() =>
      run({
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    outro("Done")
    if (!ok) process.exitCode = 1
  })
}

function findMeta(spec: string, store: Awaited<ReturnType<typeof PluginMeta.list>>) {
  const direct = Object.values(store).find((entry) => entry.spec === spec)
  if (direct) return direct
  if (pluginSource(spec) === "file") return
  const pkg = parsePluginSpecifier(spec).pkg
  return Object.values(store).find(
    (entry) => entry.source === "npm" && parsePluginSpecifier(entry.spec).pkg === pkg,
  )
}

export const PluginAddCommand = effectCmd({
  command: "add <module>",
  aliases: ["install"],
  describe: "install plugin and update config",
  builder: (yargs) => installOptions(yargs),
  handler: Effect.fn("Cli.plugin.add")(function* (args) {
    const mod = String(args.module ?? "").trim()
    if (!mod) {
      UI.error("module is required")
      process.exitCode = 1
      return
    }
    yield* runInstall(mod, Boolean(args.global), Boolean(args.force))()
  }),
})

export const PluginListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list installed plugins",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.plugin.list")(function* () {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const store = yield* Effect.promise(() => PluginMeta.list())
    const origins = config.plugin_origins ?? []

    UI.empty()
    intro("Plugins")

    if (!origins.length) {
      log.warn("No plugins configured")
      outro("Add plugins with: opencode plugin add <module>")
      return
    }

    for (const origin of origins) {
      const spec = ConfigPlugin.pluginSpecifier(origin.spec)
      const meta = findMeta(spec, store)
      const version = meta?.version ? ` v${meta.version}` : ""
      log.info(
        `${pluginDisplayId(spec)} ${UI.Style.TEXT_DIM}(${origin.scope})${version}\n    ${UI.Style.TEXT_DIM}${spec} · ${origin.source}`,
      )
    }

    outro(`${origins.length} plugin(s)`)
  }),
})

export const PluginRemoveCommand = effectCmd({
  command: "remove <module>",
  aliases: ["rm", "uninstall"],
  describe: "remove plugin and update config",
  builder: (yargs) =>
    yargs
      .positional("module", {
        type: "string",
        describe: "npm module name, path, or URL",
        demandOption: true,
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: "remove from global config",
      }),
  handler: Effect.fn("Cli.plugin.remove")(function* (args) {
    const mod = String(args.module ?? "").trim()
    if (!mod) {
      UI.error("module is required")
      process.exitCode = 1
      return
    }

    UI.empty()
    intro(`Remove plugin ${mod}`)

    const ctx = yield* InstanceRef
    if (!ctx) return
    const out = yield* Effect.promise(() =>
      unpatchPluginConfig({
        spec: mod,
        global: Boolean(args.global),
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    if (!out.ok) {
      if (out.code === "invalid_json") {
        log.error(`Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`)
        log.info("Fix the config file and run the command again.")
      } else {
        log.error(errorMessage(out.error))
      }
      process.exitCode = 1
      outro("Done")
      return
    }

    let removed = 0
    for (const item of out.items) {
      if (item.mode === "removed") {
        removed += item.removed.length
        log.info(`Removed ${item.removed.join(", ")} from ${item.file}`)
        continue
      }
      log.info(`Not configured in ${item.file}`)
    }
    if (!removed) {
      log.warn(`"${mod}" is not configured (${out.dir})`)
      process.exitCode = 1
    } else {
      log.success(`Removed ${mod}`)
    }
    outro("Done")
  }),
})

export const PluginConfigureCommand = effectCmd({
  command: "configure <module>",
  aliases: ["config"],
  describe: "set or clear a plugin's options",
  builder: (yargs) =>
    yargs
      .positional("module", {
        describe: "npm module name, path, or URL",
        type: "string",
        demandOption: true,
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: "configure in global config",
      })
      .option("set", {
        alias: ["s"],
        type: "string",
        array: true,
        describe: "option override as KEY=JSON (repeatable)",
      })
      .option("clear", {
        type: "boolean",
        default: false,
        describe: "clear options back to a bare spec",
      }),
  handler: Effect.fn("Cli.plugin.configure")(function* (args) {
    const mod = String(args.module ?? "").trim()
    if (!mod) {
      UI.error("module is required")
      process.exitCode = 1
      return
    }

    let options: Record<string, unknown> | undefined
    if (!args.clear) {
      options = {}
      for (const entry of args.set ?? []) {
        const index = entry.indexOf("=")
        if (index < 1) {
          UI.error(`Invalid --set ${entry}. Expected KEY=JSON`)
          process.exitCode = 1
          return
        }
        const key = entry.slice(0, index)
        try {
          options[key] = JSON.parse(entry.slice(index + 1))
        } catch {
          UI.error(`Invalid JSON value for --set ${key}`)
          process.exitCode = 1
          return
        }
      }
    }

    const ctx = yield* InstanceRef
    if (!ctx) return
    const out = yield* Effect.promise(() =>
      configurePluginOptions({
        spec: mod,
        options,
        global: Boolean(args.global),
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    UI.empty()
    intro(`Configure plugin ${mod}`)
    if (!out.ok) {
      if (out.code === "invalid_json") {
        log.error(`Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`)
        log.info("Fix the config file and run the command again.")
      } else {
        log.error(errorMessage(out.error))
      }
      process.exitCode = 1
      outro("Done")
      return
    }
    const updated = out.items.filter((item) => item.mode === "updated")
    if (!updated.length) {
      log.warn(`"${mod}" is not configured (${out.dir})`)
      process.exitCode = 1
    } else {
      for (const item of updated) {
        log.success(`Updated ${item.updated.join(", ")} in ${item.file}`)
      }
    }
    outro("Done")
  }),
})

export const PluginInstallDefaultCommand = effectCmd({
  command: "$0 <module>",
  describe: "install plugin and update config",
  builder: (yargs) => installOptions(yargs),
  handler: Effect.fn("Cli.plug")(function* (args) {
    // Bare `plugin <module>` keeps the historical install behavior.
    const mod = String(args.module ?? "").trim()
    if (!mod) {
      UI.error("module is required")
      process.exitCode = 1
      return
    }
    yield* runInstall(mod, Boolean(args.global), Boolean(args.force))()
  }),
})

export const PluginCommand = effectCmd({
  command: "plugin",
  aliases: ["plug"],
  describe: "manage plugins",
  builder: (yargs) =>
    yargs
      .command(PluginAddCommand)
      .command(PluginListCommand)
      .command(PluginRemoveCommand)
      .command(PluginConfigureCommand)
      .command(PluginInstallDefaultCommand),
  handler: Effect.fn("Cli.plugin")(function* () {
    // Unreachable: `$0 <module>` catches every invocation the named
    // subcommands don't. Kept so the dispatcher always has a handler.
    UI.error("module is required")
    process.exitCode = 1
  }),
})
