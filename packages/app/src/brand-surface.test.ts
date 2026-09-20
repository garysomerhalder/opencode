import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { brandDictionary, LEGATUS } from "./brand"
import { ALLOWLIST, describe as describeHits, dictionaryViolations, sourceViolations, type Hit } from "./brand-surface"

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
      hits.push(
        ...dictionaryViolations(name, branded, all).map((hit) => ({ ...hit, value: `${file}: ${hit.value}` })),
      )
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

describe("brand switch: the ui copy of the brand cannot drift", () => {
  test("packages/ui/src/brand.ts agrees with packages/app/src/brand.ts", async () => {
    const { LEGATUS_UI, resolveUiBrand } = await import("../../ui/src/brand")
    expect(LEGATUS_UI.id).toBe(LEGATUS.id)
    expect(LEGATUS_UI.productName).toBe(LEGATUS.productName)
    expect(resolveUiBrand("opencode")).toBeUndefined()
    expect(resolveUiBrand(undefined)).toBeUndefined()
  })
})
