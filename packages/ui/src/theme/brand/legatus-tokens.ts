import type { HexColor } from "../types"

/**
 * Snapshot of the Legatus Brand API color tokens (v1.0.0), taken on 2026-09-19 from
 * https://legatus-branding-system.manus.space/api/brand.css (the `--lg-*` custom properties).
 * The live API is the source of truth. To update: refetch, edit the values here, then run
 * `bun script/build-legatus-theme.ts` from packages/ui to regenerate themes/legatus.json.
 */
export const LEGATUS_TOKENS = {
  version: "1.0.0",
  bgPrimary: "#0A0E14",
  bgSecondary: "#111827",
  bgCard: "#1C242E",
  bgTerminal: "#0F1419",
  textDisplay: "#FFFFFF",
  textPrimary: "#E2E8F0",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
  textDisabled: "#475569",
  accentGreen: "#4ADE80",
  accentBlue: "#3B82F6",
  accentPurple: "#8B5CF6",
  accentAmber: "#F59E0B",
  accentRed: "#EF4444",
  brandRed: "#D71921",
  accentCyan: "#06B6D4",
} as const

export type LegatusTokens = { [K in keyof typeof LEGATUS_TOKENS]: K extends "version" ? string : HexColor }
