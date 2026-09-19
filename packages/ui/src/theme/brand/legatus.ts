import { darken } from "../color"
import type { DesktopTheme, HexColor } from "../types"
import { LEGATUS_TOKENS, type LegatusTokens } from "./legatus-tokens"

/**
 * Maps the Legatus Brand API color tokens onto the desktop theme schema.
 *
 * - Dark is the canonical brand surface: Navy Black background and Signal Green accent/CTA.
 *   Surfaces and text use the brand ramps.
 * - Light is derived from dark. It has a near-white neutral and the navy as ink, and the green is
 *   darkened so it stays readable on white.
 * - Brand red (#D71921) is left out on purpose. It is only for brand moments (logo lockups,
 *   splash marketing), not UI state. Errors use the brand's Error Red.
 *
 * `themes/legatus.json` is this function's output (the test checks it). Regenerate with
 * `bun script/build-legatus-theme.ts` from packages/ui.
 */
export function legatusTheme(t: LegatusTokens): DesktopTheme {
  const hex = (value: string) => value as HexColor
  const lightGreen = darken(hex(t.accentGreen), 0.3)
  return {
    $schema: "https://opencode.ai/desktop-theme.json",
    name: "Legatus",
    id: "legatus",
    light: {
      palette: {
        neutral: hex("#F8FAFC"),
        ink: hex(t.bgPrimary),
        primary: lightGreen,
        accent: lightGreen,
        success: lightGreen,
        warning: darken(hex(t.accentAmber), 0.12),
        error: hex(t.accentRed),
        info: hex(t.accentBlue),
        interactive: lightGreen,
        diffAdd: hex(t.accentGreen),
        diffDelete: hex(t.accentRed),
      },
      overrides: {
        "text-strong": hex(t.bgPrimary),
        "text-base": hex(t.bgCard),
        "text-weak": hex(t.textMuted),
        "syntax-comment": hex(t.textMuted),
        "syntax-keyword": hex(t.accentPurple),
        "syntax-string": lightGreen,
        "syntax-primitive": hex(t.accentBlue),
        "syntax-property": darken(hex(t.accentCyan), 0.12),
        "syntax-type": darken(hex(t.accentAmber), 0.12),
        "syntax-constant": darken(hex(t.accentAmber), 0.12),
      },
    },
    dark: {
      palette: {
        neutral: hex(t.bgPrimary),
        ink: hex(t.textPrimary),
        primary: hex(t.accentGreen),
        accent: hex(t.accentGreen),
        success: hex(t.accentGreen),
        warning: hex(t.accentAmber),
        error: hex(t.accentRed),
        info: hex(t.accentBlue),
        interactive: hex(t.accentGreen),
        diffAdd: hex(t.accentGreen),
        diffDelete: hex(t.accentRed),
      },
      overrides: {
        "background-base": hex(t.bgPrimary),
        "background-weak": hex(t.bgSecondary),
        "text-strong": hex(t.textDisplay),
        "text-base": hex(t.textPrimary),
        "text-weak": hex(t.textSecondary),
        "text-weaker": hex(t.textMuted),
        "syntax-comment": hex(t.textMuted),
        "syntax-keyword": hex(t.accentPurple),
        "syntax-string": hex(t.accentGreen),
        "syntax-primitive": hex(t.accentBlue),
        "syntax-property": hex(t.accentCyan),
        "syntax-type": hex(t.accentAmber),
        "syntax-constant": hex(t.accentAmber),
      },
      v2Overrides: {
        "v2-background-bg-base": t.bgPrimary,
        "v2-background-bg-deep": t.bgTerminal,
        "v2-background-bg-layer-01": t.bgSecondary,
        "v2-background-bg-layer-02": t.bgCard,
        "v2-text-text-accent": t.accentGreen,
        "v2-border-border-focus": t.accentGreen,
      },
    },
  }
}

export const LEGATUS_THEME = legatusTheme(LEGATUS_TOKENS)
