import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { brandDictionary, feedbackHref, LEGATUS, UPSTREAM_FEEDBACK_URL } from "./brand"
import { resolveDesktopMenu } from "./desktop-menu"
import {
  ALLOWLIST,
  describe as describeHits,
  dictionaryViolations,
  RUNTIME_ALLOWLIST,
  runtimeViolations,
  sourceViolations,
  type Hit,
} from "./brand-surface"

// packages/app/src -> repo root
const ROOT = join(import.meta.dir, "..", "..", "..")
const rel = (path: string) => relative(ROOT, path).split(sep).join("/")
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

const DICTIONARIES = [
  { name: "app", dir: join(ROOT, "packages/app/src/i18n") },
  { name: "ui", dir: join(ROOT, "packages/ui/src/i18n") },
  { name: "desktop", dir: join(ROOT, "packages/desktop/src/renderer/i18n") },
] as const

const SOURCE_ROOTS = [
  join(ROOT, "packages/app/src"),
  join(ROOT, "packages/ui/src"),
  join(ROOT, "packages/desktop/src"),
  // The CLI and the TUI are a product surface too, and they are reachable without ever leaving the
  // desktop app: it embeds a terminal. A user who has never seen a shell can still be told to run
  // `opencode auth login`.
  join(ROOT, "packages/opencode/src/cli"),
  join(ROOT, "packages/cli/src"),
  join(ROOT, "packages/tui/src"),
] as const

const SOURCE_FILES = [join(ROOT, "packages/desktop/src/renderer/index.html")] as const

/** See the structural exclusions in brand-surface.ts; each one is documented there with its reason. */
const skipped = (path: string) =>
  path.includes("/i18n/") ||
  path.endsWith(".test.ts") ||
  path.endsWith(".test.tsx") ||
  path.endsWith(".stories.tsx") ||
  path.endsWith("/brand.ts") ||
  path.endsWith("/brand-surface.ts")

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue
      yield* walk(path)
      continue
    }
    if (/\.(ts|tsx|html)$/.test(entry)) yield path
  }
}

const localeDicts = (dir: string) =>
  readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.includes(".test.") && file !== "index.ts")

async function scanDictionaries(all: boolean) {
  const hits: Hit[] = []
  for (const { name, dir } of DICTIONARIES) {
    for (const file of localeDicts(dir)) {
      const mod = (await import(join(dir, file))) as { dict?: Record<string, unknown> }
      if (!mod.dict) continue
      const branded = brandDictionary(mod.dict as Record<string, string>, LEGATUS)
      hits.push(...dictionaryViolations(name, branded, all).map((hit) => ({ ...hit, value: `${file}: ${hit.value}` })))
    }
  }
  // Outside the app project, so it is loaded by path (like i18n/parity.test.ts) to keep tsgo -b happy.
  const nativePath = "./i18n/desktop-native"
  const native = (await import(nativePath)) as { DESKTOP_NATIVE_ENGLISH: Record<string, string> }
  hits.push(...dictionaryViolations("native", brandDictionary(native.DESKTOP_NATIVE_ENGLISH, LEGATUS), all))
  return hits
}

function scanSource(all: boolean) {
  const hits: Hit[] = []
  for (const path of [...SOURCE_ROOTS.flatMap((root) => [...walk(root)]), ...SOURCE_FILES]) {
    const id = rel(path)
    if (skipped(`/${id}`)) continue
    hits.push(...sourceViolations(id, readFileSync(path, "utf8"), all))
  }
  return hits
}

describe("brand surface: nothing a user can see still says OpenCode", () => {
  test("every key of every locale of every shipped dictionary", async () => {
    const hits = await scanDictionaries(false)
    expect(hits.length === 0 ? "" : `\n${describeHits(hits)}\n`).toBe("")
  })

  test("every string literal and markup text in the renderer and main-process closure", () => {
    const hits = scanSource(false)
    expect(hits.length === 0 ? "" : `\n${describeHits(hits)}\n`).toBe("")
  })
})

function scanRuntime(all: boolean) {
  const hits: Hit[] = []
  for (const path of [...walk(join(ROOT, "packages/desktop/src")), ...SOURCE_FILES]) {
    const id = rel(path)
    if (skipped(`/${id}`)) continue
    hits.push(...runtimeViolations(id, readFileSync(path, "utf8"), all))
  }
  return hits
}

describe("brand surface: nothing a user can see says Electron", () => {
  test("every string literal and markup text in the desktop main process, preload and renderer", () => {
    const hits = scanRuntime(false)
    expect(
      hits.length === 0
        ? ""
        : `
${describeHits(hits)}
`,
    ).toBe("")
  })

  test("every runtime allowance carries a reason and still matches something", () => {
    expect(RUNTIME_ALLOWLIST.filter((entry) => entry.reason.trim().length < 20).map((entry) => entry.id)).toEqual([])
    const seen = new Set(scanRuntime(true).map((hit) => hit.id))
    expect(RUNTIME_ALLOWLIST.map((entry) => entry.id).filter((id) => !seen.has(id))).toEqual([])
  })

  // Windows draws the taskbar button and the toast header from the app's identity, not from any
  // string, so no scan sees them. These assert the seams that set that identity.
  test("every app window is created with the brand icon and the brand title", () => {
    const source = read("packages/desktop/src/main/windows.ts")
    const options = source.slice(source.indexOf("new BrowserWindow({"), source.indexOf("webPreferences:"))
    expect(options).toContain("icon: iconPath(),")
    expect(options).toContain("title: activeBrand()?.productName")
    // …and the icon set copied into resources/icons is the brand's when the brand is on.
    expect(read("packages/desktop/scripts/copy-icons.ts")).toContain('"./icons/legatus"')
  })

  test("the dev build registers its Windows identity under the brand's dev name", () => {
    const source = read("packages/desktop/src/main/index.ts")
    expect(source).toContain('if (process.platform === "win32" && !app.isPackaged) registerDevIdentity(appId)')
    expect(source).toContain("displayName: APP_NAMES.dev, iconPath: iconPngPath()")
    // APP_NAMES comes from the brand when it is on.
    expect(source).toContain("BRAND?.appNames ??")
  })
})

describe("brand surface: no branded link leads to upstream's support channels", () => {
  test("the brand's own destinations are not upstream's", () => {
    expect(
      Object.values(LEGATUS.links).filter((href) => /opencode\.ai|anomalyco|invite\/opencode/i.test(href ?? "")),
    ).toEqual([])
  })

  test("feedback buttons and Help-menu links resolve to nothing upstream with the brand on", () => {
    expect(feedbackHref(LEGATUS)).toBeUndefined()
    expect(feedbackHref(undefined)).toBe(UPSTREAM_FEEDBACK_URL)
    for (const platform of ["macos", "windows"] as const) {
      const hrefs = resolveDesktopMenu(platform, LEGATUS).flatMap((menu) =>
        (menu.items ?? []).flatMap((entry) => (entry.type === "item" && entry.href ? [entry.href] : [])),
      )
      expect(hrefs.filter((href) => /opencode|anomalyco/i.test(href))).toEqual([])
    }
  })

  test("upstream's feedback page is named only in the brand module, behind feedbackHref()", () => {
    const offenders = SOURCE_ROOTS.flatMap((root) => [...walk(root)])
      .filter((path) => !skipped(`/${rel(path)}`))
      .filter((path) => readFileSync(path, "utf8").includes("opencode.ai/desktop-feedback"))
      .map(rel)
    expect(offenders).toEqual([])
  })
})

describe("brand surface: the mark", () => {
  // Artwork is letterform paths, so no text scan can see it. These assert the seam instead: the
  // desktop build swaps the whole module, and the module it swaps in draws the Legatus lockup.
  const config = read("packages/desktop/electron.vite.config.ts")

  test("the desktop build aliases both upstream brand modules when the brand is on", () => {
    for (const specifier of ["@opencode-ai/ui/logo", "@opencode-ai/ui/v2/wordmark-v2"]) {
      expect({ specifier, aliased: config.includes(`"${specifier}":`) }).toEqual({ specifier, aliased: true })
    }
    // …and to nothing at all when it is off, so the upstream modules load untouched.
    expect(config).toContain(": undefined")
  })

  test("each replacement exists and keeps the exports its upstream module has", () => {
    const cases = [
      { file: "packages/desktop/src/renderer/brand/logo.tsx", exports: ["Mark", "Splash", "Logo"] },
      { file: "packages/desktop/src/renderer/brand/wordmark-v2.tsx", exports: ["WordmarkV2"] },
    ]
    for (const { file, exports } of cases) {
      expect({ file, exists: existsSync(join(ROOT, file)) }).toEqual({ file, exists: true })
      const source = read(file)
      for (const name of exports) {
        expect({ file, name, exported: new RegExp(`export (?:const|function) ${name}\\b`).test(source) }).toEqual({
          file,
          name,
          exported: true,
        })
      }
    }
  })

  test("the CLI and TUI wordmarks follow the brand, and there is only one copy of the art", () => {
    // Four things spell the product name in half-block glyphs: the TUI home screen, the CLI's TTY
    // logo, the CLI's piped banner, and the session epilogue. A fourth copy of the art used to be
    // inline in util/presentation.ts, where it stayed on "opencode" while everything around it was
    // branded. They all come from one module now, and that module reads the brand.
    const art = read("packages/tui/src/logo.ts")
    expect(art).toContain('import { Brand } from "@opencode-ai/core/brand"')
    for (const name of ["logo", "wordmark", "initial"]) {
      expect({ name, switched: art.includes(`export const ${name} = Brand?.id === "legatus"`) }).toEqual({
        name,
        switched: true,
      })
    }
    // Upstream's glyphs are still there, for the brand-off build.
    expect(art).toContain("█▀▀█ █▀▀█ █▀▀█ █▀▀▄")
    // …and nobody re-inlines their own copy.
    for (const file of [
      "packages/tui/src/util/presentation.ts",
      "packages/opencode/src/cli/ui.ts",
      "packages/opencode/src/cli/cmd/run/splash.ts",
    ]) {
      expect({ file, inlined: /["'`]█[▀▄_^~ █]{3}/.test(read(file)) }).toEqual({ file, inlined: false })
    }
  })

  test("the product's initial is the splash badge, not the OpenCode Go 'O'", () => {
    const splash = read("packages/opencode/src/cli/cmd/run/splash.ts")
    expect(splash).toContain("initial.slice(1)")
    expect(splash).not.toContain("go.right.slice(1)")
  })

  test("the new-session hero draws the Legatus lockup, not letterforms of its own", () => {
    const source = read("packages/desktop/src/renderer/brand/wordmark-v2.tsx")
    expect(source).toContain("legatus-lockup.svg")
    // The lockup is the Brand API artwork, unmodified apart from the fill becoming currentColor.
    const lockup = read("packages/desktop/src/renderer/brand/legatus-lockup.svg")
    expect(lockup).toContain('viewBox="0 0 1899 364"')
    expect((lockup.match(/<path/g) ?? []).length).toBe(10) // 3 mark + 7 LEGATUS letterforms
  })

  test("upstream's wordmark is left exactly as it was, for the brand-off build", () => {
    const upstream = read("packages/ui/src/v2/components/wordmark-v2.tsx")
    expect(upstream).toContain('viewBox="0 0 720 129"')
    expect(upstream).toContain("export function WordmarkV2")
  })
})

describe("brand surface: the allow-list itself", () => {
  test("every entry carries a reason", () => {
    expect(ALLOWLIST.filter((entry) => entry.reason.trim().length < 20).map((entry) => entry.id)).toEqual([])
  })

  test("no duplicate entries", () => {
    const ids = ALLOWLIST.map((entry) => entry.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })

  // The shadow build (docs/legatus-shadow.md) renames most of these identifiers out of existence,
  // so on that tree the allow-list is legitimately a superset of what is left — the shadow is
  // strictly cleaner, not dirtier. Staleness is a brand-layer invariant, asserted on the tree the
  // rename has not been applied to.
  const renamed = read("packages/desktop/electron.vite.config.ts").includes("VITE_LEGATUS_BRAND")

  test.if(!renamed)("no stale entries: every allowance still matches something", async () => {
    const seen = new Set([...(await scanDictionaries(true)), ...scanSource(true)].map((hit) => hit.id))
    expect(ALLOWLIST.map((entry) => entry.id).filter((id) => !seen.has(id))).toEqual([])
  })
})

describe("brand switch: the three copies of the brand cannot drift", () => {
  // Three packages need the brand and no package is a dependency of all three: app depends on ui
  // and core, ui depends on neither, core depends on nothing. So each has a small copy of the
  // identity, and this is what keeps them the same.
  //
  // Both are outside the app project, so they are loaded by path (like i18n/parity.test.ts and the
  // desktop dictionary in brand.test.ts) to keep `tsgo -b` happy. A literal specifier here is
  // resolved statically and roots the file in app's program, which composite build mode then
  // rejects with TS6307.
  const uiBrandPath = "../../ui/src/brand"
  const coreBrandPath = "../../core/src/brand"

  test("packages/ui/src/brand.ts agrees with packages/app/src/brand.ts", async () => {
    const { LEGATUS_UI, resolveUiBrand } = (await import(uiBrandPath)) as {
      LEGATUS_UI: { id: string; productName: string }
      resolveUiBrand: (value: string | undefined) => unknown
    }
    expect(LEGATUS_UI.id).toBe(LEGATUS.id)
    expect(LEGATUS_UI.productName).toBe(LEGATUS.productName)
    expect(resolveUiBrand("opencode")).toBeUndefined()
    expect(resolveUiBrand(undefined)).toBeUndefined()
  })

  test("packages/core/src/brand.ts agrees too, and serves the CLI and the TUI", async () => {
    const core = (await import(coreBrandPath)) as {
      LEGATUS: { id: string; productName: string; short: string }
      PRODUCT: string
      SHORT: string
      CLI: string
    }
    expect(core.LEGATUS.id).toBe(LEGATUS.id)
    expect(core.LEGATUS.productName).toBe(LEGATUS.productName)
    // No build define and no OPENCODE_BRAND in the environment: the CLI defaults to the brand, the
    // same way electron.vite.config.ts defaults the desktop build to it.
    expect(core.PRODUCT).toBe(LEGATUS.productName)
    expect(core.SHORT).toBe(LEGATUS.short)
    // The binary's name is NOT a brand value — the brand layer never renames binaries, the shadow
    // rename script does (R14). So rather than pinning it to a literal, pin it to the truth: every
    // command this app prints for the user to type has to name the binary that actually exists.
    // This holds in both trees and fails if either side is renamed without the other.
    const bin = Object.keys(JSON.parse(read("packages/opencode/package.json")).bin ?? {})
    expect(bin).toContain(core.CLI)
  })

  test("both CLI builds define the brand, so a packaged binary carries the switch", () => {
    for (const script of ["packages/opencode/script/build.ts", "packages/opencode/script/build-node.ts"]) {
      expect({ script, defined: read(script).includes("OPENCODE_BRAND:") }).toEqual({ script, defined: true })
    }
  })
})
