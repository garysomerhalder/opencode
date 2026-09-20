import { describe, expect, test } from "bun:test"
import { dict as en } from "./i18n/en"
import { dict as ja } from "./i18n/ja"
import { dict as de } from "./i18n/de"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import { activeBrand, BRANDED_KEYS, brandDictionary, LEGATUS, resolveBrand } from "./brand"

const flat = (value: Record<string, unknown>) => value as Record<string, string>
// Outside the app project, so it is loaded by path (like i18n/parity.test.ts) to keep tsgo -b happy.
const desktopEnPath = "../../desktop/src/renderer/i18n/en.ts"
const desktopEn = flat((await import(desktopEnPath)).dict)

describe("brand constants", () => {
  test("Legatus product identity", () => {
    expect(LEGATUS.productName).toBe("Legatus")
    expect(LEGATUS.appNames).toEqual({ dev: "Legatus Dev", beta: "Legatus Beta", prod: "Legatus" })
    expect(LEGATUS.defaultTheme).toBe("legatus")
    expect(LEGATUS.upstreamName).toBe("OpenCode")
  })

  test("brand switch resolves only known brands", () => {
    expect(resolveBrand("legatus")).toBe(LEGATUS)
    expect(resolveBrand("opencode")).toBeUndefined()
    expect(resolveBrand(undefined)).toBeUndefined()
    expect(resolveBrand("")).toBeUndefined()
  })

  test("brand is inactive outside the desktop build (no define in tests)", () => {
    expect(activeBrand()).toBeUndefined()
  })
})

describe("brandDictionary", () => {
  const base = flat({ ...en, ...uiEn })

  test("rebrands every allow-listed English key that exists", () => {
    const out = brandDictionary(base, LEGATUS)
    expect(out["app.name.desktop"]).toBe("Legatus")
    expect(out["help.tabs.introduction"]).toBe("Legatus is now built around tabs.")
    expect(out["desktop.menu.app"]).toBe("Legatus")
    expect(out["desktop.recovery.unresponsive"]).toBe("Legatus is not responding")
    expect(out["settings.general.row.theme.description"]).toBe("Customise how Legatus is themed.")
    expect(out["provider.connect.apiKey.description"]).toContain("models in Legatus.")
    expect(out["provider.connect.apiKey.description"]).toContain("{{provider}}")
    for (const key of BRANDED_KEYS) {
      if (!(key in base)) continue
      expect(out[key]).not.toContain("OpenCode")
    }
  })

  test("every allow-listed key exists in some English dictionary (no stale entries)", () => {
    const all = { ...base, ...flat(desktopEn) }
    const missing = BRANDED_KEYS.filter((key) => !(key in all))
    expect(missing).toEqual([])
  })

  test("leaves the WSL binary, upstream services and upstream docs alone", () => {
    // Each of these is allow-listed in brand-surface.ts with the reason it stays: someone else's
    // binary, someone else's service, or a link whose destination really is upstream.
    const out = brandDictionary(base, LEGATUS)
    for (const key of [
      "wsl.onboarding.installOpencode",
      "wsl.onboarding.step.opencode",
      "provider.connect.opencodeZen.line1",
      "dialog.model.unpaid.freeModels.title",
      "desktop.menu.documentation",
      "error.page.report.prefix",
      "desktop.wsl.error.installOpencode",
    ]) {
      expect(out[key]).toBe(base[key])
      expect(out[key]).toContain("OpenCode")
    }
    // The project config file the app really reads, named in lower case.
    expect(out["dialog.plugins.empty"]).toBe(base["dialog.plugins.empty"])
    expect(out["dialog.plugins.empty"]).toContain("opencode.json")
  })

  test("rebrands copy that names this app, not a third party", () => {
    const out = brandDictionary(base, LEGATUS)
    // The app's own server, its own MCP support, and the three WSL strings that name the app
    // rather than the binary it installs.
    expect(out["dialog.server.description"]).toBe("Switch which Legatus server this app connects to.")
    expect(out["error.chain.mcpFailed"]).toContain("Legatus does not support MCP authentication yet")
    expect(out["wsl.onboarding.wslUnavailable.description"]).toBe("Legatus could not verify WSL on this machine.")
    expect(out["wsl.onboarding.windowsRestartRequired"]).toContain("reopen Legatus")
    expect(out["wsl.onboarding.wslNotInstalled.description"]).toContain("before Legatus can add a WSL server")
    for (const key of [
      "dialog.server.description",
      "error.chain.mcpFailed",
      "wsl.onboarding.wslUnavailable.description",
      "wsl.onboarding.windowsRestartRequired",
      "wsl.onboarding.wslNotInstalled.description",
    ]) {
      expect(out[key]).not.toContain("OpenCode")
    }
  })

  test("rebrands the same keys in other locales, keeping the translated remainder", () => {
    const outJa = brandDictionary(flat({ ...en, ...ja }), LEGATUS)
    expect(outJa["desktop.recovery.unresponsive"]).toBe("Legatusが応答していません")
    expect(outJa["desktop.menu.documentation"]).toBe("OpenCodeドキュメント")
    const outDe = brandDictionary(flat({ ...en, ...de }), LEGATUS)
    expect(outDe["app.name.desktop"]).toBe("Legatus")
  })

  test("adds the upstream credit", () => {
    expect(brandDictionary(base, LEGATUS)["brand.credit"]).toBe("Built on OpenCode")
  })

  test("desktop renderer updater copy is rebranded", () => {
    const out = brandDictionary(flat(desktopEn), LEGATUS)
    expect(out["desktop.updater.none.message"]).toBe("You are already using the latest version of Legatus")
    expect(out["desktop.updater.downloaded.prompt"]).toContain("of Legatus has been downloaded")
  })

  test("is idempotent and does not mutate its input", () => {
    const snapshot = { ...base }
    const once = brandDictionary(base, LEGATUS)
    expect(brandDictionary(once, LEGATUS)).toEqual(once)
    expect(base).toEqual(snapshot)
  })

  test("returns the input unchanged when no brand is active", () => {
    expect(brandDictionary(base, undefined)).toBe(base)
  })
})
