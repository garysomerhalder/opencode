import { describe, expect, test } from "bun:test"
import { LEGATUS } from "./brand"
import { DESKTOP_MENU, resolveDesktopMenu, type DesktopMenuEntry } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.labelKey === "desktop.menu.exportLogs",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("provides translated labels for role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role && item.labelKey,
    )

    expect(windowMenu?.labelKey).toBe("desktop.menu.window")
    expect(roleItems.length).toBeGreaterThan(0)
  })

  const links = (entries: DesktopMenuEntry[]) =>
    entries.flatMap((entry) => (entry.type === "item" && entry.href ? [entry.href] : []))

  for (const platform of ["macos", "windows"] as const) {
    test(`${platform}: a branded menu sends nobody to upstream's docs, forum or tracker`, () => {
      const menus = resolveDesktopMenu(platform, LEGATUS)
      const hrefs = menus.flatMap((menu) => links(menu.items ?? []))
      expect(hrefs.filter((href) => /opencode|anomalyco/i.test(href))).toEqual([])
      // Legatus supplies none of these destinations yet, so the items are hidden, not repointed.
      const labels = menus.flatMap((menu) =>
        (menu.items ?? []).map((entry) => (entry.type === "item" ? entry.labelKey : "-")),
      )
      for (const key of [
        "desktop.menu.documentation",
        "desktop.menu.supportForum",
        "desktop.menu.shareFeedback",
        "desktop.menu.reportBug",
      ] as const) {
        expect({ key, shown: labels.includes(key) }).toEqual({ key, shown: false })
      }
    })

    test(`${platform}: hiding items leaves no stranded separators`, () => {
      for (const menu of resolveDesktopMenu(platform, LEGATUS)) {
        const items = menu.items ?? []
        if (items.length === 0) continue
        expect({ menu: menu.id, first: items[0]!.type }).toEqual({ menu: menu.id, first: "item" })
        expect({ menu: menu.id, last: items[items.length - 1]!.type }).toEqual({ menu: menu.id, last: "item" })
        items.forEach((entry, i) => {
          if (entry.type === "separator") expect(items[i - 1]?.type).toBe("item")
        })
      }
    })

    test(`${platform}: a brand's own destination replaces the upstream one`, () => {
      const brand = { ...LEGATUS, links: { documentation: "https://docs.example.test/" } }
      const help = resolveDesktopMenu(platform, brand).find((menu) => menu.id === "help")
      expect(links(help?.items ?? [])).toEqual(["https://docs.example.test/"])
    })

    test(`${platform}: with the brand off the upstream menu is unchanged`, () => {
      const help = resolveDesktopMenu(platform, undefined).find((menu) => menu.id === "help")
      const upstream = DESKTOP_MENU.find((menu) => menu.id === "help")
      expect(links(help?.items ?? [])).toEqual(links(upstream?.items ?? []))
      expect(links(help?.items ?? [])).toHaveLength(4)
    })
  }
})
