import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { parseDesktopNativeBundle, type DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"

import type { FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import type { GoalLoopStartInput } from "./goal-loop"
import type { GoalLoops } from "./goal-loops"
import type { ServerState } from "@opencode-ai/app/server-status/view"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import {
  getPinchZoomEnabled,
  getWindowID,
  openExternalURL,
  openLocalFileURL,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { createDesktopDraftStore } from "./draft-store"
import { clearLinearApiKey, createLinearClient, getLinearApiKey, setLinearApiKey } from "./linear"
import { nativeT } from "./native-translations"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: nativeT("desktop.dialog.files"), extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  goalLoops: GoalLoops
  getGoalLoopLast: (sessionID?: string) => GoalLoopStartInput | null
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  setNativeTranslations: (bundle: DesktopNativeBundle) => void
  /** The supervised local server: its state, and a manual restart after it gave up. */
  serverState: () => ServerState | null
  restartServer: () => Promise<void>
}

export function registerIpcHandlers(deps: Deps) {
  const drafts = createDesktopDraftStore(join(app.getPath("userData"), "drafts.sqlite"))
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)
  app.on("before-quit", () => drafts.flush())
  app.once("will-quit", () => drafts.close())
  app.on("browser-window-created", (_event, win) => win.on("session-end", () => drafts.flush()))

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("server-state", () => deps.serverState())
  ipcMain.handle("server-restart", () => deps.restartServer())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  ipcMain.handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  ipcMain.handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) =>
    setForceFocus(event.sender, enabled),
  )
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("set-native-translations", (event: IpcMainInvokeEvent, value: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Invalid native translation sender")
    }
    const bundle = parseDesktopNativeBundle(value)
    if (!bundle) throw new Error("Invalid native translation bundle")
    deps.setNativeTranslations(bundle)
  })
  // Session ids come from the renderer: accept only a non-empty string, else "no session".
  const sessionArg = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)
  ipcMain.handle("goal-loop-start", (_event: IpcMainInvokeEvent, input: GoalLoopStartInput) => {
    if (!input || typeof input !== "object") throw new Error("Invalid goal loop input")
    return deps.goalLoops.start(input)
  })
  ipcMain.handle("goal-loop-stop", (_event: IpcMainInvokeEvent, sessionID: unknown) =>
    deps.goalLoops.stop(sessionArg(sessionID)),
  )
  ipcMain.handle("goal-loop-status", (_event: IpcMainInvokeEvent, sessionID: unknown) =>
    deps.goalLoops.status(sessionArg(sessionID)),
  )
  ipcMain.handle("goal-loop-list", () => deps.goalLoops.list())
  // the user's approval of a proposed check: main approves only a command the session's
  // loop reported as pending (accuracy E §11.9)
  ipcMain.handle("goal-loop-approve-check", (_event: IpcMainInvokeEvent, sessionID: unknown, command: unknown) =>
    typeof sessionID === "string" && typeof command === "string"
      ? deps.goalLoops.approveCheck(sessionID, command)
      : false,
  )
  ipcMain.handle("goal-loop-dismiss", (_event: IpcMainInvokeEvent, sessionID: unknown) => {
    const id = sessionArg(sessionID)
    if (id) deps.goalLoops.dismiss(id)
  })
  ipcMain.handle("goal-loop-last", (_event: IpcMainInvokeEvent, sessionID: unknown) =>
    deps.getGoalLoopLast(sessionArg(sessionID)),
  )
  ipcMain.handle("linear-has-key", async () => (await getLinearApiKey()) !== null)
  ipcMain.handle("linear-set-key", async (_event: IpcMainInvokeEvent, key: unknown) => {
    if (typeof key !== "string" || key.trim().length === 0) throw new Error("linear-invalid-key")
    await setLinearApiKey(key)
  })
  ipcMain.handle("linear-clear-key", () => clearLinearApiKey())
  ipcMain.handle("linear-test", async () => {
    const key = await getLinearApiKey()
    if (!key) throw new Error("linear-not-configured")
    try {
      const viewer = await createLinearClient({ getKey: getLinearApiKey }).viewer()
      return { name: viewer.name, email: viewer.email }
    } catch (error) {
      if (error instanceof Error && error.message === "linear-not-configured") throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Linear authentication failed: ${detail.slice(0, 300)}`)
    }
  })
  ipcMain.handle(
    "linear-assigned",
    async (_event: IpcMainInvokeEvent, args?: { teamKey?: unknown; first?: unknown }) => {
      const key = await getLinearApiKey()
      if (!key) throw new Error("linear-not-configured")
      const teamKey =
        typeof args?.teamKey === "string" && args.teamKey.trim().length > 0 ? args.teamKey.trim() : undefined
      const first =
        typeof args?.first === "number" && Number.isFinite(args.first) && args.first > 0
          ? Math.floor(args.first)
          : undefined
      return createLinearClient({ getKey: getLinearApiKey }).assignedIssues({ teamKey, first })
    },
  )
  ipcMain.handle("linear-issue", async (_event: IpcMainInvokeEvent, args?: { id?: unknown }) => {
    const key = await getLinearApiKey()
    if (!key) throw new Error("linear-not-configured")
    if (!args || typeof args.id !== "string" || args.id.trim().length === 0) {
      throw new Error("linear-invalid-issue-id")
    }
    return createLinearClient({ getKey: getLinearApiKey }).issue(args.id)
  })
  ipcMain.handle("linear-teams", async () => {
    const key = await getLinearApiKey()
    if (!key) throw new Error("linear-not-configured")
    return createLinearClient({ getKey: getLinearApiKey }).teams()
  })
  ipcMain.handle("linear-comment", async (_event: IpcMainInvokeEvent, args?: { issueId?: unknown; body?: unknown }) => {
    const key = await getLinearApiKey()
    if (!key) throw new Error("linear-not-configured")
    if (!args || typeof args.issueId !== "string" || args.issueId.trim().length === 0) {
      throw new Error("linear-invalid-issue-id")
    }
    if (typeof args.body !== "string" || args.body.trim().length === 0) {
      throw new Error("linear-invalid-comment-body")
    }
    return createLinearClient({ getKey: getLinearApiKey }).comment(args.issueId, args.body)
  })
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })
  ipcMain.handle("draft-get", (_event, key: string) => drafts.get(key))
  ipcMain.handle("draft-set", (_event, key: string, value: string) => drafts.set(key, value))
  ipcMain.handle("draft-delete", (_event, key: string) => drafts.set(key, null))
  ipcMain.handle("draft-blob-put", (_event, data: ArrayBuffer) => drafts.putBlob(new Uint8Array(data)))
  ipcMain.handle("draft-blob-get", (_event, id: string) => {
    const data = drafts.getBlob(id)
    return data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null
  })

  ipcMain.handle(
    "open-directory-picker",
    async (event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const picker: Electron.OpenDialogOptions = {
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFolder"),
        defaultPath: opts?.defaultPath,
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = win ? await dialog.showOpenDialog(win, picker) : await dialog.showOpenDialog(picker)
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const picker: Electron.OpenDialogOptions = {
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = win ? await dialog.showOpenDialog(win, picker) : await dialog.showOpenDialog(picker)
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const picker = {
        title: opts?.title ?? nativeT("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = win ? await dialog.showSaveDialog(win, picker) : await dialog.showSaveDialog(picker)
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-external", (_event: IpcMainEvent, url: string) => {
    openExternalURL(url)
  })

  ipcMain.on("open-local-file", (_event: IpcMainEvent, url: string) => {
    openLocalFileURL(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) return false
    shell.showItemInFolder(path)
    return true
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("get-window-fullscreen", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFullScreen() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendToAllWindows(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
