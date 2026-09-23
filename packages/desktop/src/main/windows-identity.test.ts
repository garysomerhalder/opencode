import { describe, expect, test } from "bun:test"
import {
  registerDevWindowsIdentity,
  registryCommands,
  startMenuPrograms,
  strayShortcuts,
  type ShortcutInfo,
  type WindowsIdentityDeps,
} from "./windows-identity"

const APP_ID = "ai.opencode.desktop.dev"
const identity = { appId: APP_ID, displayName: "Legatus Dev", iconPath: "C:\\repo\\resources\\icons\\64x64.png" }
const ELECTRON = "C:\\repo\\node_modules\\electron\\dist\\electron.exe"

function fakeDeps(
  links: Record<string, ShortcutInfo | "throws">,
  reg: (args: string[]) => Promise<void> = async () => {},
) {
  const calls = { reg: [] as string[][], removed: [] as string[], logs: [] as string[] }
  const deps: WindowsIdentityDeps = {
    reg: (args) => {
      calls.reg.push(args)
      return reg(args)
    },
    shortcuts: () => Object.keys(links),
    readShortcut: (path) => {
      const info = links[path]
      if (info === "throws") throw new Error("not a shortcut")
      return info
    },
    removeShortcut: async (path) => {
      calls.removed.push(path)
    },
    log: (message) => calls.logs.push(message),
  }
  return { deps, calls }
}

describe("dev windows identity", () => {
  test("registers the brand name and icon under the app's AUMID, idempotently", () => {
    expect(registryCommands(identity)).toEqual([
      [
        "add",
        `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`,
        "/v",
        "DisplayName",
        "/t",
        "REG_EXPAND_SZ",
        "/d",
        "Legatus Dev",
        "/f",
      ],
      [
        "add",
        `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`,
        "/v",
        "IconUri",
        "/t",
        "REG_EXPAND_SZ",
        "/d",
        identity.iconPath,
        "/f",
      ],
    ])
  })

  test("only a shortcut carrying this AUMID and launching a bare electron.exe is stray", () => {
    const { deps } = fakeDeps({
      "Electron.lnk": { target: ELECTRON, appUserModelId: APP_ID },
      "OpenCode.lnk": { target: "C:\\Program Files\\OpenCode\\OpenCode.exe", appUserModelId: "ai.opencode.desktop" },
      "Other dev app.lnk": { target: ELECTRON, appUserModelId: "com.example.other" },
      "Installed.lnk": { target: "C:\\Program Files\\Legatus\\Legatus.exe", appUserModelId: APP_ID },
      "broken.lnk": "throws",
    })
    expect(
      strayShortcuts(APP_ID, { ...deps, readShortcut: (p) => (p === "broken.lnk" ? undefined : deps.readShortcut(p)) }),
    ).toEqual(["Electron.lnk"])
  })

  test("removes the stray shortcut before registering, and registers both values", async () => {
    const { deps, calls } = fakeDeps({ "Electron.lnk": { target: ELECTRON, appUserModelId: APP_ID } })
    await registerDevWindowsIdentity(identity, deps)
    expect(calls.removed).toEqual(["Electron.lnk"])
    expect(calls.reg).toEqual(registryCommands(identity))
  })

  test("a shortcut with our AUMID but any other target is left alone, and each removal is logged once", async () => {
    const { deps, calls } = fakeDeps({
      "Electron.lnk": { target: ELECTRON, appUserModelId: APP_ID },
      "Legatus Dev.lnk": { target: "C:\repo\launch-legatus.cmd", appUserModelId: APP_ID },
      "Installed.lnk": { target: "C:\Program Files\Legatus\Legatus.exe", appUserModelId: APP_ID },
    })
    await registerDevWindowsIdentity(identity, deps)
    expect(calls.removed).toEqual(["Electron.lnk"])
    expect(calls.logs.filter((line) => line.startsWith("moved stray dev shortcut"))).toHaveLength(1)
  })

  test("a failed move to the Recycle Bin is logged, not reported as removed", async () => {
    const { deps, calls } = fakeDeps({ "Electron.lnk": { target: ELECTRON, appUserModelId: APP_ID } })
    await registerDevWindowsIdentity(identity, {
      ...deps,
      removeShortcut: async () => Promise.reject(new Error("busy")),
    })
    expect(calls.logs).toContain("failed to move stray dev shortcut to the Recycle Bin")
    expect(calls.logs.some((line) => line.startsWith("moved stray dev shortcut"))).toBe(false)
    expect(calls.reg).toEqual(registryCommands(identity))
  })

  test("never throws: a failing scan or reg.exe is logged and startup continues", async () => {
    const { deps, calls } = fakeDeps({ "broken.lnk": "throws" }, async () => {
      throw new Error("reg.exe missing")
    })
    await registerDevWindowsIdentity(identity, deps)
    expect(calls.removed).toEqual([])
    expect(calls.logs).toContain("windows identity step failed")
    expect(calls.logs.filter((line) => line === "failed to register app identity")).toHaveLength(2)
  })

  test("looks in the user's own Start-menu Programs folder", () => {
    expect(startMenuPrograms("C:\\Users\\me\\AppData\\Roaming").replaceAll("\\", "/")).toBe(
      "C:/Users/me/AppData/Roaming/Microsoft/Windows/Start Menu/Programs",
    )
  })
})
