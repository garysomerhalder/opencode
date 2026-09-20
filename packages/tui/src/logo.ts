import { Brand } from "@opencode-ai/core/brand"

// The wordmarks are letterform art, not text: they spell the product name in half-block glyphs.
// No string scan can read them, which is exactly how the desktop hero kept saying "opencode" after
// the rest of the app was branded (docs/legatus-brand.md, "What the gate cannot see"). They are
// swapped as a whole, like the desktop wordmark component.
//
// Consumers: the TUI home screen (component/logo.tsx), the session epilogue
// (util/presentation.ts), and the CLI, which re-exports this module as src/cli/logo.ts and uses
// `logo` for TTY output, `wordmark` for piped output and `initial` for the run-mode splash badge.
//
// Mark characters in `logo` are rendered by component/logo.tsx, not printed literally:
//   _  shadowed space (enclosed interior)   ^  shadowed ▀ (crossbar)
//   ~  shadow-coloured ▀                    ,  shadow-coloured ▄
// `wordmark` is plain text for a non-TTY stream, so it uses no marks.

/** Upstream: "open" | "code". Untouched — this is what the brand-off build renders. */
const opencodeLogo = {
  left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█__█ █__█ █^^^ █__█", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

/**
 * Legatus: "LEGA" | "TUS", drawn in the same half-block font so the two-tone split, the shadow
 * marks and the line count all still work.
 *
 * The Brand API publishes no ASCII form of the wordmark, so unlike the desktop lockup this is our
 * own rendition of the letterforms rather than official artwork.
 */
const legatusLogo = {
  left: ["                   ", "█    █▀▀▀ █▀▀▀ █▀▀█", "█    █^^^ █_▀█ █^^█", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀~~▀"],
  right: ["              ", "▀▀▀▀ █  █ █▀▀▀", " █   █__█ ▀▀▀█", " ▀   ▀▀▀▀ ▀▀▀▀"],
}

export const logo = Brand?.id === "legatus" ? legatusLogo : opencodeLogo

/** Single block, plain text, for a piped (non-TTY) stream: `--help`, CI logs. */
const opencodeWordmark = [
  "⠀                                ▄     ",
  "█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
  "█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀",
  "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
]

const legatusWordmark = [
  "                                  ",
  "█    █▀▀▀ █▀▀▀ █▀▀█ ▀▀▀▀ █  █ █▀▀▀",
  "█    █▀▀▀ █ ▀█ █▀▀█  █   █  █ ▀▀▀█",
  "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀  ▀  ▀   ▀▀▀▀ ▀▀▀▀",
]

export const wordmark = Brand?.id === "legatus" ? legatusWordmark : opencodeWordmark

/**
 * The product's initial as a block glyph — the compact badge on the CLI's entry/exit splash.
 *
 * It used to borrow the "O" from the `go` badge below, which made the splash quietly render
 * OpenCode's initial in a branded build. A single letter is art *and* an initialism, so neither a
 * string scan nor an `/opencode/i` scan can see it.
 */
const opencodeInitial = ["    ", "█▀▀█", "█__█", "▀▀▀▀"]
const legatusInitial = ["    ", "█   ", "█   ", "▀▀▀▀"]

export const initial = Brand?.id === "legatus" ? legatusInitial : opencodeInitial

/** OpenCode Go's badge. A third party's mark, so it is not rebranded. */
export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
