/**
 * Brand switch for packages/ui.
 *
 * `packages/app/src/brand.ts` is the source of truth for the brand. `packages/ui` cannot import it
 * — app depends on ui, not the other way round — so this is a deliberately minimal copy: the id,
 * the product name, and the two labels ui itself renders. `brand-surface.test.ts` asserts the two
 * files agree, so the copy cannot drift.
 *
 * The switch is the same one: `packages/desktop/electron.vite.config.ts` defines
 * `import.meta.env.VITE_OPENCODE_BRAND` for the whole renderer bundle, ui included. Unset or
 * unknown means no brand, and every caller keeps upstream's value unchanged.
 */

export type UiBrand = {
  id: string
  productName: string
  /** Label for upstream's default palette in the theme picker, which is named after upstream. */
  upstreamThemeName: string
}

export const LEGATUS_UI: UiBrand = {
  id: "legatus",
  productName: "Legatus",
  upstreamThemeName: "Classic",
}

const KNOWN: Record<string, UiBrand> = { legatus: LEGATUS_UI }

export function resolveUiBrand(value: string | undefined): UiBrand | undefined {
  if (!value) return undefined
  return Object.hasOwn(KNOWN, value) ? KNOWN[value] : undefined
}

export function activeUiBrand(): UiBrand | undefined {
  return resolveUiBrand(import.meta.env?.VITE_OPENCODE_BRAND)
}
