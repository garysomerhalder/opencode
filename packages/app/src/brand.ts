/**
 * Legatus brand layer. It is the single source of truth for the product name, per-channel app
 * names, the default theme and the upstream credit.
 *
 * Only the desktop build turns it on. `packages/desktop/electron.vite.config.ts` injects
 * `import.meta.env.VITE_OPENCODE_BRAND` (default "legatus", `OPENCODE_BRAND=opencode` turns it off).
 * Everything else (the web app, tests, the server) runs with no brand, so it keeps upstream copy.
 *
 * This is a brand layer only: it never touches app ids, data paths, storage keys, package or
 * CLI names. See docs/legatus-brand.md.
 *
 * `brand-surface.ts` is the gate that keeps it honest: it fails the build if any user-visible
 * surface still says OpenCode with the brand on, unless the case is allow-listed with a reason.
 */
import { LEGATUS_ICON_DATA_URI } from "./brand-icon"

export type Brand = {
  id: string
  productName: string
  appNames: { dev: string; beta: string; prod: string }
  defaultTheme: string
  upstreamName: string
  /** Two-letter form for places too narrow for the name. Upstream's is "OC". */
  short: string
  /** Image URL for OS notifications, and anywhere else that needs the mark as a URL. */
  notificationIcon: string
  /** Prefix for files the app writes into the user's folders (the debug-log export). */
  filePrefix: string
  messages: Record<string, string>
}

export const LEGATUS: Brand = {
  id: "legatus",
  productName: "Legatus",
  appNames: { dev: "Legatus Dev", beta: "Legatus Beta", prod: "Legatus" },
  defaultTheme: "legatus",
  upstreamName: "OpenCode",
  short: "LG",
  notificationIcon: LEGATUS_ICON_DATA_URI,
  filePrefix: "legatus",
  messages: {
    "brand.credit": "Built on OpenCode",
  },
}

export type BrandMessages = { "brand.credit": string }

/**
 * i18n keys where "OpenCode" names *this app*. Every key not listed here is left alone on
 * purpose: the `opencode` CLI installed into WSL, the OpenCode Zen/Go services, `opencode.json`,
 * upstream docs and upstream bug reports. Those are third parties, real filenames or truthful
 * links, and `brand-surface.ts` holds the reason for each one.
 *
 * A new upstream key therefore shows "OpenCode" until it is added here — the safe way to fail,
 * and `brand-surface.test.ts` turns it into a failing test rather than a silent leak.
 */
export const BRANDED_KEYS: readonly string[] = [
  // app (packages/app/src/i18n)
  "app.name.desktop",
  "help.tabs.introduction",
  "home.providerTip",
  "provider.connect.apiKey.description",
  "provider.connect.oauth.code.visit.suffix",
  "provider.connect.oauth.auto.visit.suffix",
  "sidebar.gettingStarted.line1",
  "settings.general.row.language.description",
  "settings.general.row.appearance.description",
  "settings.general.row.colorScheme.description",
  "settings.general.row.theme.description",
  "settings.updates.row.startup.description",
  "settings.updates.toast.latest.description",
  "settings.updates.toast.latest.title",
  "toast.update.description",
  "dialog.server.description",
  "error.chain.mcpFailed",
  // The WSL feature installs the upstream `opencode` binary into a distro; those strings name
  // that binary and stay (see brand-surface.ts). These three name *this app* instead.
  "wsl.onboarding.wslNotInstalled.description",
  "wsl.onboarding.wslUnavailable.description",
  "wsl.onboarding.windowsRestartRequired",
  // native menus and dialogs (packages/app/src/i18n/desktop-native.ts)
  "desktop.menu.app",
  "desktop.menu.ariaLabel",
  "desktop.recovery.loadFailed",
  "desktop.recovery.terminated",
  "desktop.recovery.unresponsive",
  // desktop renderer (packages/desktop/src/renderer/i18n)
  "desktop.updater.none.message",
  "desktop.updater.downloaded.prompt",
]

const BRANDED = new Set(BRANDED_KEYS)

const KNOWN: Record<string, Brand> = { legatus: LEGATUS }

export function resolveBrand(value: string | undefined): Brand | undefined {
  if (!value) return undefined
  return Object.hasOwn(KNOWN, value) ? KNOWN[value] : undefined
}

export function activeBrand(): Brand | undefined {
  return resolveBrand(import.meta.env.VITE_OPENCODE_BRAND)
}

function rebrand(value: string, brand: Brand) {
  return value
    .replaceAll(`${brand.upstreamName} Desktop`, brand.productName)
    .replaceAll(brand.upstreamName, brand.productName)
}

/**
 * Returns a copy of `dict` with the allow-listed product mentions rebranded and the brand's
 * own messages added. When there is no brand it returns `dict` itself (same reference).
 * The function is pure and idempotent.
 */
export function brandDictionary<T extends Record<string, string>>(dict: T, brand: Brand | undefined): T {
  if (!brand) return dict
  const out: Record<string, string> = { ...dict }
  for (const key of Object.keys(out)) {
    if (!BRANDED.has(key)) continue
    const value = out[key]
    if (typeof value === "string") out[key] = rebrand(value, brand)
  }
  for (const [key, value] of Object.entries(brand.messages)) {
    if (!(key in out)) out[key] = value
  }
  return out as T
}
