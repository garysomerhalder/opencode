import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveThemeVariant } from "../resolve"
import { resolveThemeVariantV2 } from "../v2/resolve"
import { contrastRatio } from "../color"
import type { HexColor } from "../types"
import { LEGATUS_TOKENS } from "./legatus-tokens"
import { legatusTheme } from "./legatus"

const theme = legatusTheme(LEGATUS_TOKENS)
const json = JSON.stringify(theme).toLowerCase()

describe("legatus theme mapping", () => {
  test("identity", () => {
    expect(theme.id).toBe("legatus")
    expect(theme.name).toBe("Legatus")
  })

  test("dark variant: canonical navy background and green accent", () => {
    const dark = theme.dark
    if (!dark.palette) throw new Error("expected palette")
    expect(dark.palette.neutral).toBe("#0A0E14")
    expect(dark.palette.primary).toBe("#4ADE80")
    expect(dark.palette.accent).toBe("#4ADE80")
    expect(dark.palette.success).toBe("#4ADE80")
    expect(dark.overrides?.["background-base"]).toBe("#0A0E14")
    expect(dark.v2Overrides?.["v2-background-bg-base"]).toBe("#0A0E14")
  })

  test("brand red is reserved for brand moments, never a theme color", () => {
    expect(json).not.toContain(LEGATUS_TOKENS.brandRed.toLowerCase())
  })

  test("resolves through the v1 and v2 pipelines in both modes", () => {
    const v1dark = resolveThemeVariant(theme.dark, true)
    expect(v1dark["background-base"]).toBe("#0A0E14")
    const v1light = resolveThemeVariant(theme.light, false)
    expect(Object.keys(v1light).length).toBeGreaterThan(50)
    const v2dark = resolveThemeVariantV2(theme.dark, true)
    expect(v2dark["v2-background-bg-base"]).toBe("#0A0E14")
    const v2light = resolveThemeVariantV2(theme.light, false)
    expect(Object.keys(v2light).length).toBeGreaterThan(50)
  })

  test("light variant keeps a readable (darkened) green accent", () => {
    const light = theme.light
    if (!light.palette) throw new Error("expected palette")
    expect(contrastRatio(light.palette.primary as HexColor, light.palette.neutral as HexColor)).toBeGreaterThan(3)
  })

  test("committed themes/legatus.json is exactly the generated output", () => {
    const file = JSON.parse(readFileSync(join(import.meta.dir, "../themes/legatus.json"), "utf8"))
    expect(file).toEqual(theme)
  })
})
