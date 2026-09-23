/**
 * How Windows names and draws the *unpackaged* dev app: the taskbar button and the header of every
 * toast notification. Both come from the app's AppUserModelID (AUMID), not from the window.
 *
 * Windows resolves an AUMID in this order, which was checked on Windows 11 with a probe app:
 *
 *  1. A Start-menu shortcut carrying that AUMID. Its name and icon win, and Windows keeps showing
 *     the shortcut target's identity (for a dev build that is electron.exe: "Electron" and the atom)
 *     even after the shortcut's own icon and description are rewritten.
 *  2. `HKCU\Software\Classes\AppUserModelId\<AUMID>` with `DisplayName` and `IconUri`. Honoured the
 *     moment it is written, needs no admin rights and no installer, and leaves nothing launchable
 *     behind in the Start menu.
 *  3. Otherwise the process: electron.exe's own name ("Electron") on toasts.
 *
 * A packaged build gets (1) from its installer, named and iconed correctly. A dev build has none,
 * so it writes (2), and moves any stray dev shortcut carrying its AUMID, which would otherwise
 * shadow it with electron.exe's identity, to the Recycle Bin (reversible, and logged once per path
 * at info level). Only shortcuts that name *this* dev AUMID *and* launch a bare electron.exe are
 * moved; nothing else in the Start menu is touched. Packaged builds never run this.
 */
import { basename, join } from "node:path"

export type ShortcutInfo = { target?: string; appUserModelId?: string }

export type WindowsIdentityDeps = {
  /** Runs `reg.exe` with these arguments. */
  reg: (args: string[]) => Promise<void>
  /** Absolute paths of the `.lnk` files directly in the user's Start-menu Programs folder. */
  shortcuts: () => string[]
  readShortcut: (path: string) => ShortcutInfo | undefined
  /** Moves the shortcut to the Recycle Bin (`shell.trashItem`), so the removal can be undone. */
  removeShortcut: (path: string) => Promise<void>
  log: (message: string, meta?: Record<string, unknown>) => void
}

export type WindowsIdentity = {
  appId: string
  displayName: string
  /** PNG shown in the toast header. `IconUri` takes an image file, not an `.ico`. */
  iconPath: string
}

export const APP_USER_MODEL_ID_KEY = "HKCU\\Software\\Classes\\AppUserModelId"

/** The two `reg add` calls that register `identity`. `/f` makes each one idempotent. */
export function registryCommands(identity: WindowsIdentity): string[][] {
  const key = `${APP_USER_MODEL_ID_KEY}\\${identity.appId}`
  return [
    ["add", key, "/v", "DisplayName", "/t", "REG_EXPAND_SZ", "/d", identity.displayName, "/f"],
    ["add", key, "/v", "IconUri", "/t", "REG_EXPAND_SZ", "/d", identity.iconPath, "/f"],
  ]
}

/** Stray dev shortcuts: they carry this AUMID and launch a bare electron.exe. */
export function strayShortcuts(appId: string, deps: Pick<WindowsIdentityDeps, "shortcuts" | "readShortcut">) {
  return deps.shortcuts().filter((path) => {
    const info = deps.readShortcut(path)
    if (!info || info.appUserModelId !== appId) return false
    return basename(info.target ?? "").toLowerCase() === "electron.exe"
  })
}

/** Registers the dev app's name and icon with Windows. Never throws; failures are logged. */
export async function registerDevWindowsIdentity(identity: WindowsIdentity, deps: WindowsIdentityDeps) {
  for (const path of safe(() => strayShortcuts(identity.appId, deps), [] as string[], deps)) {
    const removed = await deps.removeShortcut(path).then(
      () => true,
      (error) => {
        deps.log("failed to move stray dev shortcut to the Recycle Bin", { path, error: String(error) })
        return false
      },
    )
    if (removed)
      deps.log("moved stray dev shortcut to the Recycle Bin; it shadowed the app identity", {
        path,
        appId: identity.appId,
      })
  }
  for (const args of registryCommands(identity)) {
    await deps.reg(args).catch((error) => deps.log("failed to register app identity", { args, error: String(error) }))
  }
}

/** The user's Start-menu Programs folder, from `app.getPath("appData")`. */
export function startMenuPrograms(appData: string) {
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs")
}

function safe<T>(fn: () => T, fallback: T, deps: Pick<WindowsIdentityDeps, "log">): T {
  try {
    return fn()
  } catch (error) {
    deps.log("windows identity step failed", { error: String(error) })
    return fallback
  }
}
