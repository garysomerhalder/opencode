import type { Brand, BrandLink } from "./brand"
import type { DesktopNativeKey } from "./i18n/desktop-native"

export type DesktopMenuPlatform = "macos" | "windows"

export type DesktopMenuAction =
  | "app.checkForUpdates"
  | "app.relaunch"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.delete"
  | "edit.selectAll"
  | "view.reload"
  | "view.toggleDevTools"
  | "view.resetZoom"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.toggleFullscreen"
  | "window.new"
  | "window.close"
  | "window.minimize"
  | "window.toggleMaximize"

export type DesktopMenuRole =
  | "about"
  | "close"
  | "copy"
  | "cut"
  | "hide"
  | "hideOthers"
  | "paste"
  | "quit"
  | "redo"
  | "reload"
  | "resetZoom"
  | "selectAll"
  | "toggleDevTools"
  | "togglefullscreen"
  | "undo"
  | "unhide"
  | "windowMenu"
  | "zoomIn"
  | "zoomOut"

export type DesktopMenuItem = {
  type: "item"
  labelKey?: DesktopNativeKey
  command?: string
  action?: DesktopMenuAction
  role?: DesktopMenuRole
  /** Upstream destination, used as-is only when the brand switch is off. */
  href?: string
  /** Which brand destination replaces `href` when the brand is on. Without one the item is hidden. */
  link?: BrandLink
  accelerator?: Partial<Record<DesktopMenuPlatform, string>>
  enabled?: "updater"
  platforms?: DesktopMenuPlatform[]
}

export type DesktopMenuSeparator = {
  type: "separator"
  platforms?: DesktopMenuPlatform[]
}

export type DesktopMenuEntry = DesktopMenuItem | DesktopMenuSeparator

export type DesktopMenu = {
  id: string
  labelKey: DesktopNativeKey
  role?: DesktopMenuRole
  items?: DesktopMenuEntry[]
  platforms?: DesktopMenuPlatform[]
}

export const DESKTOP_MENU: DesktopMenu[] = [
  {
    id: "app",
    labelKey: "desktop.menu.app",
    platforms: ["macos"],
    items: [
      { type: "item", role: "about" },
      {
        type: "item",
        labelKey: "desktop.menu.checkForUpdates",
        action: "app.checkForUpdates",
        enabled: "updater",
      },
      { type: "item", labelKey: "desktop.menu.settings", command: "settings.open", accelerator: { macos: "Cmd+," } },
      { type: "item", labelKey: "desktop.menu.reloadWebview", action: "view.reload" },
      { type: "item", labelKey: "desktop.menu.restart", action: "app.relaunch" },
      { type: "item", labelKey: "desktop.menu.exportLogs", command: "logs.export" },
      { type: "separator" },
      { type: "item", role: "hide" },
      { type: "item", role: "hideOthers" },
      { type: "item", role: "unhide" },
      { type: "separator" },
      { type: "item", role: "quit" },
    ],
  },
  {
    id: "file",
    labelKey: "desktop.menu.file",
    items: [
      {
        type: "item",
        labelKey: "desktop.menu.newSession",
        command: "session.new",
        accelerator: { macos: "Shift+Cmd+S" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.startGoalLoop",
        command: "session.goalLoop",
      },
      {
        type: "item",
        labelKey: "desktop.menu.openProject",
        command: "project.open",
        accelerator: { macos: "Cmd+O" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.settings",
        command: "settings.open",
        accelerator: { windows: "Ctrl+," },
        platforms: ["windows"],
      },
      {
        type: "item",
        labelKey: "desktop.menu.newWindow",
        action: "window.new",
        accelerator: { macos: "Cmd+Shift+N", windows: "Ctrl+Shift+N" },
      },
      { type: "separator" },
      { type: "item", labelKey: "desktop.menu.closeWindow", action: "window.close", role: "close" },
    ],
  },
  {
    id: "edit",
    labelKey: "desktop.menu.edit",
    items: [
      {
        type: "item",
        labelKey: "desktop.menu.undo",
        action: "edit.undo",
        role: "undo",
        accelerator: { windows: "Ctrl+Z" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.redo",
        action: "edit.redo",
        role: "redo",
        accelerator: { windows: "Ctrl+Y" },
      },
      { type: "separator" },
      {
        type: "item",
        labelKey: "desktop.menu.cut",
        action: "edit.cut",
        role: "cut",
        accelerator: { windows: "Ctrl+X" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.copy",
        action: "edit.copy",
        role: "copy",
        accelerator: { windows: "Ctrl+C" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.paste",
        action: "edit.paste",
        role: "paste",
        accelerator: { windows: "Ctrl+V" },
      },
      { type: "item", labelKey: "desktop.menu.delete", action: "edit.delete" },
      {
        type: "item",
        labelKey: "desktop.menu.selectAll",
        action: "edit.selectAll",
        role: "selectAll",
        accelerator: { windows: "Ctrl+A" },
      },
    ],
  },
  {
    id: "view",
    labelKey: "desktop.menu.view",
    items: [
      { type: "item", labelKey: "desktop.menu.toggleSidebar", command: "sidebar.toggle" },
      {
        type: "item",
        labelKey: "desktop.menu.toggleTerminal",
        command: "terminal.toggle",
        accelerator: { macos: "Ctrl+`" },
      },
      { type: "item", labelKey: "desktop.menu.toggleFileTree", command: "fileTree.toggle" },
      { type: "separator" },
      { type: "item", labelKey: "desktop.menu.reload", action: "view.reload", role: "reload" },
      {
        type: "item",
        labelKey: "desktop.menu.toggleDeveloperTools",
        action: "view.toggleDevTools",
        role: "toggleDevTools",
      },
      { type: "separator" },
      {
        type: "item",
        labelKey: "desktop.menu.actualSize",
        action: "view.resetZoom",
        role: "resetZoom",
        accelerator: { windows: "Ctrl+0" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.zoomIn",
        action: "view.zoomIn",
        role: "zoomIn",
        accelerator: { windows: "Ctrl++" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.zoomOut",
        action: "view.zoomOut",
        role: "zoomOut",
        accelerator: { windows: "Ctrl+-" },
      },
      { type: "separator" },
      {
        type: "item",
        labelKey: "desktop.menu.toggleFullScreen",
        action: "view.toggleFullscreen",
        role: "togglefullscreen",
      },
    ],
  },
  {
    id: "go",
    labelKey: "desktop.menu.go",
    items: [
      { type: "item", labelKey: "desktop.menu.back", command: "common.goBack", accelerator: { macos: "Cmd+[" } },
      { type: "item", labelKey: "desktop.menu.forward", command: "common.goForward", accelerator: { macos: "Cmd+]" } },
      { type: "separator" },
      {
        type: "item",
        labelKey: "desktop.menu.previousSession",
        command: "session.previous",
        accelerator: { macos: "Option+Up" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.nextSession",
        command: "session.next",
        accelerator: { macos: "Option+Down" },
      },
      { type: "separator" },
      {
        type: "item",
        labelKey: "desktop.menu.previousProject",
        command: "project.previous",
        accelerator: { macos: "Cmd+Option+Up" },
      },
      {
        type: "item",
        labelKey: "desktop.menu.nextProject",
        command: "project.next",
        accelerator: { macos: "Cmd+Option+Down" },
      },
    ],
  },
  {
    id: "window",
    labelKey: "desktop.menu.window",
    role: "windowMenu",
    items: [
      { type: "item", labelKey: "desktop.menu.minimize", action: "window.minimize" },
      { type: "item", labelKey: "desktop.menu.maximize", action: "window.toggleMaximize" },
      { type: "separator" },
      { type: "item", labelKey: "desktop.menu.closeWindow", action: "window.close" },
    ],
  },
  {
    id: "help",
    labelKey: "desktop.menu.help",
    items: [
      {
        type: "item",
        labelKey: "desktop.menu.documentation",
        href: "https://opencode.ai/docs",
        link: "documentation",
      },
      {
        type: "item",
        labelKey: "desktop.menu.supportForum",
        href: "https://discord.com/invite/opencode",
        link: "supportForum",
      },
      { type: "item", labelKey: "desktop.menu.exportLogs", command: "logs.export" },
      { type: "separator" },
      {
        type: "item",
        labelKey: "desktop.menu.shareFeedback",
        href: "https://github.com/anomalyco/opencode/issues/new?template=feature_request.yml",
        link: "shareFeedback",
      },
      {
        type: "item",
        labelKey: "desktop.menu.reportBug",
        href: "https://github.com/anomalyco/opencode/issues/new?template=bug_report.yml",
        link: "reportBug",
      },
    ],
  },
]

export function desktopMenuVisible(item: { platforms?: DesktopMenuPlatform[] }, platform: DesktopMenuPlatform) {
  return !item.platforms || item.platforms.includes(platform)
}

/**
 * Where a menu link goes. With no brand it is upstream's `href`, unchanged. With a brand it is the
 * brand's own destination for `link`, or `undefined` when the brand has none; the caller hides the
 * item then, so a branded build never sends its users to upstream's forum or tracker.
 */
export function desktopMenuHref(entry: DesktopMenuItem, brand: Brand | undefined): string | undefined {
  if (!brand) return entry.href
  if (!entry.link) return entry.href
  return brand.links[entry.link]
}

/**
 * The menu as a platform renders it: entries for that platform only, link targets resolved for the
 * brand, links with nowhere to go dropped, and separators left stranded by that tidied away. Both
 * the macOS native menu and the Windows titlebar menu render from this, so they cannot disagree.
 */
export function resolveDesktopMenu(platform: DesktopMenuPlatform, brand: Brand | undefined): DesktopMenu[] {
  return DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, platform)).map((menu) => {
    if (!menu.items) return menu
    const entries = menu.items.flatMap((entry): DesktopMenuEntry[] => {
      if (!desktopMenuVisible(entry, platform)) return []
      if (entry.type === "separator" || (!entry.href && !entry.link)) return [entry]
      const href = desktopMenuHref(entry, brand)
      return href ? [{ ...entry, href }] : []
    })
    return { ...menu, items: tidySeparators(entries) }
  })
}

function tidySeparators(entries: DesktopMenuEntry[]) {
  const out: DesktopMenuEntry[] = []
  for (const entry of entries) {
    if (entry.type === "separator" && (out.length === 0 || out[out.length - 1]!.type === "separator")) continue
    out.push(entry)
  }
  while (out.length > 0 && out[out.length - 1]!.type === "separator") out.pop()
  return out
}
