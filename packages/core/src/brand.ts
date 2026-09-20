/**
 * Brand layer for the CLI and the TUI.
 *
 * The desktop app has its own switch (`packages/app/src/brand.ts`, a Vite define). The CLI and the
 * TUI are bundled by Bun, not Vite, and `packages/opencode` deliberately does not depend on
 * `packages/app` — so this is the same switch expressed with the seam those builds already use:
 * a bare global that `script/build.ts` and `script/build-node.ts` define, with an env fallback so
 * `bun dev` behaves the same. It mirrors `InstallationVersion` in ./installation/version.ts.
 *
 * `OPENCODE_BRAND=opencode` turns the brand off and the CLI presents as upstream, unchanged.
 *
 * The identity here is deliberately a small copy of the one in `packages/app/src/brand.ts`
 * (`packages/ui/src/brand.ts` holds a third, because ui depends on neither). Nothing lower than
 * core is shared by all three, so the copies are pinned to each other by
 * `packages/app/src/brand-surface.test.ts` instead, which fails if any of them drifts.
 */

declare global {
  const OPENCODE_BRAND: string
}

export type CoreBrand = {
  id: string
  productName: string
  /**
   * Two-letter form, for places too narrow for the name (the terminal title while a session is
   * open). Upstream's is "OC", an initialism no `/opencode/i` scan can see — the brand-surface gate
   * found the terminal title by its other string, not by this one. Short forms have to be listed.
   */
  short: string
}

export const LEGATUS: CoreBrand = { id: "legatus", productName: "Legatus", short: "LG" }

const KNOWN: Record<string, CoreBrand> = { legatus: LEGATUS }

function configured() {
  if (typeof OPENCODE_BRAND === "string" && OPENCODE_BRAND.length > 0) return OPENCODE_BRAND
  const fromEnv = typeof process === "object" ? process.env["OPENCODE_BRAND"] : undefined
  return fromEnv && fromEnv.length > 0 ? fromEnv : LEGATUS.id
}

export const Brand: CoreBrand | undefined = (() => {
  const id = configured()
  return Object.hasOwn(KNOWN, id) ? KNOWN[id] : undefined
})()

/** Product name for user-facing copy. "OpenCode" when the brand is off. */
export const PRODUCT = Brand?.productName ?? "OpenCode"

/** Two-letter product form. "OC" when the brand is off. */
export const SHORT = Brand?.short ?? "OC"

/**
 * The name this CLI is invoked by, for printed commands the user is meant to type or run.
 *
 * This is **not** a brand value. The brand layer never renames binaries (docs/legatus-brand.md);
 * the binary's name is owned by the shadow rename script (rule R14). Keeping every printed command
 * on this one constant is what makes the two agree: rename the binary and every hint follows, and
 * in a tree where the binary really is `opencode`, the hints still tell the user the truth.
 */
export const CLI = "opencode"
