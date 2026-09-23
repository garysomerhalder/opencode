import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, shell } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { createConnectionFile, type ConnectionFile } from "./connection-file"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendToAllWindows } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import { getDefaultServerUrl, preferAppEnv, setDefaultServerUrl, spawnLocalServer } from "./server"
import {
  createSidecarSupervisor,
  type SidecarConnection,
  type SidecarState,
  type SidecarSupervisor,
  type StartedSidecar,
} from "./sidecar-supervisor"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
  iconPngPath,
} from "./windows"
import { registerDevWindowsIdentity, startMenuPrograms } from "./windows-identity"
import { createWslServersController } from "./wsl/servers"
import { createGoalLoop } from "./goal-loop"
import { createGoalLoops } from "./goal-loops"
import { readLast, saveLast, saveState, takeOrphans, type KeyValueStore } from "./goal-loop-store"
import { getStore } from "./store"
import { GOAL_LOOP_STORE } from "./store-keys"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { cleanupStoreFiles } from "./store-cleanup"
import { startBackgroundCli } from "./background-cli"
import { setNativeTranslations } from "./native-translations"
import { activeBrand } from "@opencode-ai/app/brand"

// Display names only (brand layer). APP_IDS and the userData path below are identity and do not change.
const BRAND = activeBrand()
const APP_NAMES: Record<string, string> = BRAND?.appNames ?? {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const SIDECAR_VERSION = process.env.OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let sidecar: SidecarSupervisor | null = null
let connectionFile: ConnectionFile | null = null

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar() {
  if (!sidecar) return
  const current = sidecar
  sidecar = null
  connectionFile?.remove("sidecar stopped")
  await current.stop()
}

/** The supervisor's state without the credentials, for the renderer. */
function publicState(state: SidecarState) {
  const { connection: _connection, ...rest } = state
  return rest
}

async function freeLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const socket = createServer()
    socket.on("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      if (typeof address !== "object" || !address) {
        socket.close()
        reject(new Error("Failed to get port"))
        return
      }
      socket.close(() => resolve(address.port))
    })
  })
}

/**
 * Starts the sidecar and waits until it answers health checks. A restart reuses
 * the previous port and password, so the renderer and anything holding
 * server.json keep working; if that port is taken, it falls back to a new one.
 */
async function startLocalSidecar(previous: SidecarConnection | undefined): Promise<StartedSidecar> {
  const fixed = process.env.OPENCODE_PORT ? Number.parseInt(process.env.OPENCODE_PORT, 10) : Number.NaN
  const port = previous ? Number(new URL(previous.url).port) : Number.isNaN(fixed) ? await freeLoopbackPort() : fixed
  const password = previous?.password ?? randomUUID()
  const attempt = async (port: number) => {
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    let exit!: (code: number) => void
    const exited = new Promise<number>((resolve) => (exit = resolve))
    logger.log("spawning sidecar", { url, restart: previous !== undefined })
    const { listener, health } = await spawnLocalServer(hostname, port, password, {
      userDataPath: app.getPath("userData"),
      onStdout: (message) => writeLog("server", "stdout", { message }),
      onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
      onExit: (code) => {
        writeLog("utility", "sidecar exited", { code }, "warn")
        exit(code)
      },
    })
    await Promise.race([health.wait, new Promise((resolve) => setTimeout(resolve, 30_000))]).catch((error) =>
      logger.error("sidecar health check failed", String(error)),
    )
    return {
      connection: { url, username: "opencode", password },
      exited,
      stop: () => listener.stop(),
    } satisfies StartedSidecar
  }
  if (!previous) return attempt(port)
  return attempt(port).catch(async (error) => {
    logger.warn("sidecar restart on the previous port failed; trying a new port", String(error))
    return attempt(await freeLoopbackPort())
  })
}

// Unpackaged dev on Windows has no installer shortcut, so without this the taskbar and every toast
// header show electron.exe's identity ("Electron", the atom). See windows-identity.ts.
function registerDevIdentity(appId: string) {
  const programs = startMenuPrograms(app.getPath("appData"))
  void registerDevWindowsIdentity(
    { appId, displayName: APP_NAMES.dev, iconPath: iconPngPath() },
    {
      reg: (args) =>
        new Promise<void>((resolve, reject) =>
          execFile("reg.exe", args, { windowsHide: true }, (error) => (error ? reject(error) : resolve())),
        ),
      shortcuts: () =>
        readdirSync(programs)
          .filter((name) => name.toLowerCase().endsWith(".lnk"))
          .map((name) => join(programs, name)),
      readShortcut: (path) => {
        try {
          return shell.readShortcutLink(path)
        } catch {
          return undefined
        }
      },
      removeShortcut: (path) => shell.trashItem(path),
      log: (message, meta) => writeLog("main", message, meta),
    },
  )
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : APP_NAMES.dev)
  if (BRAND) {
    app.setAboutPanelOptions({
      applicationName: BRAND.productName,
      applicationVersion: app.getVersion(),
      credits: BRAND.messages["brand.credit"],
    })
  }
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()
  if (process.platform === "win32" && !app.isPackaged) registerDevIdentity(appId)

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().finally(() => {
      app.relaunch()
      app.quit()
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  // We hold the single-instance lock, so an existing connection file belongs to a dead
  // instance (crash, hard kill, dev hot reload) and must not be served to local tools.
  connectionFile = createConnectionFile({
    dir: app.getPath("userData"),
    appVersion: app.getVersion(),
    logger: {
      log: (message, meta) => logger.log(message, meta),
      warn: (message, meta) => logger.warn(message, meta),
    },
  })
  connectionFile.clearStale()

  const shellEnv = preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setAppQuitting()
    connectionFile?.remove("quit")
    void stopSidecars()
  })

  app.on("will-quit", () => {
    setAppQuitting()
    connectionFile?.remove("quit")
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      connectionFile?.remove("signal")
      void stopSidecars().finally(() => app.quit())
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  const menuDeps = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    relaunch,
  }
  const goalLoopStore = getStore(GOAL_LOOP_STORE) as unknown as KeyValueStore
  const goalLoops = createGoalLoops({
    create: (hooks) => createGoalLoop({ getServer: () => Effect.runPromise(Deferred.await(serverReady)), ...hooks }),
    persist: (sessionID, state) => saveState(goalLoopStore, sessionID, state),
    persistLast: (sessionID, input) => saveLast(goalLoopStore, sessionID, input),
    onEvent: (event) => {
      sendToAllWindows("goal-loop-event", event)
      if (event.type !== "started" && event.type !== "iteration" && event.type !== "progress") {
        logger.log("goal loop ended", {
          type: event.type,
          loopID: event.loopID,
          sessionID: event.state.sessionID,
          reason: event.state.reason,
        })
      }
    },
  })
  goalLoops.adoptOrphans(takeOrphans(goalLoopStore))
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    goalLoops,
    getGoalLoopLast: (sessionID) => readLast(goalLoopStore, sessionID),
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        // after a supervised restart on a new port, a reloaded window gets the new one
        const current = sidecar?.connection() ?? res
        logger.log("server ready", { url: current.url })
        return current
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    isOldLayoutEligible,
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setNativeTranslations: (bundle) => {
      if (setNativeTranslations(bundle)) createMenu(menuDeps)
    },
    serverState: () => (sidecar ? publicState(sidecar.state()) : null),
    restartServer: async () => {
      if (!sidecar) return
      await sidecar.restart()
    },
  })
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { version: SIDECAR_VERSION })

    ensureLoopbackNoProxy()
    useEnvProxy()

    if (SIDECAR_VERSION === "v2") {
      logger.log("spawning v2 sidecar")
      const sidecar = yield* Effect.promise(() => startBackgroundCli(logger, shellEnv?.XDG_STATE_HOME))
      yield* Deferred.succeed(serverReady, {
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })
      connectionFile?.write({ url: sidecar.url, username: sidecar.username, password: sidecar.password })

      if (process.platform === "win32") {
        void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
      }

      logger.log("loading task finished")
      return
    }

    // The sidecar is supervised: a crash restarts it with a backoff, and too many
    // crashes in a short window stop it with a visible "failed" state (#43).
    let firstUrl: string | undefined
    sidecar = createSidecarSupervisor({
      start: startLocalSidecar,
      onState: (state) => {
        writeLog(
          "utility",
          "sidecar state",
          { status: state.status, restarts: state.restarts, lastExit: state.lastExit, error: state.error },
          state.status === "failed" ? "error" : "info",
        )
        if (state.status === "running" && state.connection) {
          // atomic (temp file + rename), with the current port and credentials
          connectionFile?.write(state.connection)
          firstUrl ??= state.connection.url
          // a restart that had to move to a new port: windows reload to reconnect
          if (state.connection.url !== firstUrl) {
            firstUrl = state.connection.url
            for (const win of BrowserWindow.getAllWindows()) win.reload()
          }
        }
        if (state.status === "restarting" || state.status === "failed")
          connectionFile?.remove(`sidecar ${state.status}`)
        sendToAllWindows("server-state", publicState(state))
      },
    })
    const connection = yield* Effect.promise(() => sidecar!.start())
    yield* Deferred.succeed(serverReady, connection)

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) createMenu(menuDeps)
})

Effect.runFork(main)
