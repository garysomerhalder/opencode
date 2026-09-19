# Legatus brand layer (desktop)

Branch `feat/legatus-brand`. The OpenCode desktop fork shows itself as **Legatus**.
This changes the brand layer only. No internal identifier changes.

## What does not change

These stay as they are. Two agents' live sessions and the parity oracle depend on them:

- package names (`@opencode-ai/*`), the `opencode` CLI/binary name
- the Electron app id (`ai.opencode.desktop.dev` / `.beta` / `ai.opencode.desktop`) and the
  `setAppUserModelId` value
- the userData folder `%APPDATA%\ai.opencode.desktop.dev`. `src/main/index.ts` sets it
  explicitly from the app id, not from the app name, so renaming the app does not move it.
- `~/.config/opencode`, DB file names, `localStorage` keys (`opencode-theme-id`, ...), the server
  API, and everything under `packages/opencode`
- `electron-builder.config.ts` `productName` / `appId` / protocol. Changing `productName` changes
  the NSIS install folder and the Start-menu entry of a packaged build. That is an identity
  change, not a brand change, so the full-rename shadow build handles it (see `docs/legatus-shadow.md`).
- `LICENSE` (MIT) stays. About shows a "Built on OpenCode" credit.

## Switch

One build-time switch, `OPENCODE_BRAND` (default `legatus`), is read in
`packages/desktop/electron.vite.config.ts`. It is injected as `import.meta.env.VITE_OPENCODE_BRAND`
into both the main and renderer bundles. `OPENCODE_BRAND=opencode bun dev` turns the whole layer
off without reverting code. Code outside the desktop build (the web app, tests, the server) never
sees the define, so it keeps the upstream brand.

## File by file

How each place was found: `grep -rn "OpenCode"` over `packages/desktop/src`,
`packages/app/src` and `packages/ui/src` (i18n dictionaries separately), plus
`grep "getName|getPath(|setName"` in `src/main` to show that no path comes from the app name.

| File | Change | Found by |
|---|---|---|
| `packages/app/src/brand.ts` (new) | The single source of truth: `LEGATUS` constants (product name, app names per channel, default theme id, upstream credit) and `activeBrand()`. `brandDictionary(dict, brand)` rewrites the "OpenCode" **product** mentions in a fixed allow-list of i18n keys (all locales) and adds `brand.credit`. | new |
| `packages/app/src/brand.test.ts` (new) | Tests first: allow-listed keys are rebranded in `en` and in a non-Latin locale, excluded keys (the OpenCode server/CLI, OpenCode Zen/Go, docs, the MCP limitation, WSL install of the `opencode` CLI) are untouched, the function is idempotent, and it does nothing when no brand is active. | new |
| `packages/app/package.json` | Adds the export `"./brand"` so the main process can import it. | exports map |
| `packages/app/src/context/language.tsx` | Passes `base` and each merged locale through `brandDictionary`. Two call sites. | dict loader |
| `packages/app/src/app.tsx` | `ThemeProvider defaultTheme={activeBrand()?.defaultTheme}`. Legatus is the default when no theme was picked. | `ThemeProvider` usage |
| `packages/app/src/context/settings.tsx` | The sans/mono fallback stacks start with `var(--brand-font-sans, …)` / `var(--brand-font-mono, …)`. These are only defined while the Legatus theme is active. A font the user picks still wins. | `--font-family-sans` setter |
| `packages/app/src/components/dialog-settings.tsx`, `settings-v2/dialog-settings-v2.tsx` | Settings footer (the About area on Windows): shows `brand.credit` ("Built on OpenCode") under the version when a brand is active. | `app.name.desktop` usages |
| `packages/app/src/env.d.ts`, `packages/desktop/src/main/env.d.ts` | Types `VITE_OPENCODE_BRAND`. | |
| `packages/ui/src/theme/brand/legatus-tokens.ts` (new) | A snapshot of Brand API v1.0.0 color tokens (`/api/brand.css`, fetched 2026-09-19). | Brand API |
| `packages/ui/src/theme/brand/legatus.ts` (new) + `legatus.test.ts` | `legatusTheme(tokens)` maps tokens to a `DesktopTheme`. Tests: navy `#0A0E14` background, green `#4ADE80` primary/accent, no brand red in the theme, it resolves through `resolveThemeVariant` for v1 and v2, and the committed JSON equals the function output. | theme system read first |
| `packages/ui/src/theme/themes/legatus.json` (new) | Generated output. The `import.meta.glob("./themes/*.json")` registry picks it up with no registry edit. | `context.tsx` glob |
| `packages/ui/src/theme/context.tsx`, `default-themes.ts` | Add the display name "Legatus" and a `legatusTheme` export (one line each, same pattern as the other themes). | name map |
| `packages/desktop/electron.vite.config.ts` | The brand define (main and renderer), and a renderer alias `@opencode-ai/ui/logo` → `src/renderer/brand/logo.tsx`. The upstream logo file is untouched. | Vite config |
| `packages/desktop/src/renderer/brand/logo.tsx` (new) | `Mark`, `Splash` and `Logo`, with the same exports and props as `@opencode-ai/ui/logo`, drawn from the official icon mark (Brand API `logo-icon-svg`) and the flat horizontal lockup. The fill follows the theme icon colors, which gives the official white or black mono variants. This covers the loading splash, the connection-error splash, the session-empty mark, the error page and the legacy home wordmark. | `grep "@opencode-ai/ui/logo"` |
| `packages/desktop/src/renderer/fonts/*` (new) | Space Grotesk (variable 300–700) and Space Mono 400/700, woff2, latin subset, with `OFL.txt`. They are bundled by Vite; nothing is loaded from a CDN at runtime. | |
| `packages/desktop/src/renderer/styles.css` | `@font-face` rules and, under `:root[data-theme="legatus"]`, the `--brand-font-*` and `--v2-font-family-sans` variables. The rule is unlayered, so it beats the `@layer theme` defaults. | empty file, already imported |
| `packages/desktop/src/renderer/index.html` | `<title>Legatus</title>` (Electron uses it as the window title). | grep |
| `packages/desktop/src/main/index.ts` | `APP_NAMES` and the dev `app.setName` value come from `LEGATUS.appNames`. `app.setAboutPanelOptions` sets the name, version and credit (macOS/Linux About). `APP_IDS` and `userData` are unchanged. | grep |
| `packages/desktop/src/main/windows.ts` | `BrowserWindow` `title` = the brand product name. | grep |
| `packages/desktop/src/main/native-translations.ts` | The initial English native bundle (menus and recovery dialogs, before the renderer sends its bundle) goes through `brandDictionary`. | `DESKTOP_NATIVE_ENGLISH` |
| `packages/desktop/src/renderer/i18n/index.ts` | The desktop-renderer dictionary (updater dialogs) goes through `brandDictionary`. | grep |
| `packages/desktop/icons/legatus/*` (new) + `scripts/copy-icons.ts` | App icons generated from the official icon SVG: the white mark on `#0A0E14` with padding, per the Brand API social/favicon spec. Sizes 16–1024 as PNG, `icon.ico` (16/24/32/48/64/128/256), `icon.icns`, and the same file names as `icons/dev`. `copy-icons` uses `icons/legatus` when the brand is active; `icons/{dev,beta,prod}` are untouched. | `predev.ts` → `copy-icons.ts` |
| `packages/desktop/scripts/legatus-icons.ts` + `legatus-icons-lib.ts` + test (new) | Rebuilds the icon set from the SVG. The ICO/ICNS containers are written by the lib, which is tested. `@resvg/resvg-js` is installed on demand outside the repo (`RESVG_MODULE=…`), not added as a dependency. | |
| `packages/ui/script/build-legatus-theme.ts` (new) | Regenerates `themes/legatus.json` from the token snapshot. | |
| `packages/desktop/src/renderer/brand/svg.ts` + `svg.test.ts` (new) | SVG → `{viewBox, inner}` with `currentColor`. The test checks that the flat icon is the official mark shifted by −306 on x, and that `logo.tsx` keeps the same exports as the upstream logo module. | |

As-built notes:
- The credit string lives in `LEGATUS.messages` (added by `brandDictionary`), not in `en.ts`. The
  i18n parity test requires every English key in all 60 locales, and a brand-only key should not
  touch 60 upstream files. Every locale falls back to the English credit.
- `index.html` `<title>` is fixed at "Legatus". It does not follow `OPENCODE_BRAND` (a static file).
- The first frame of a cold start still uses the oc-2 background from `oc-theme-preload.js`
  (#080808 against #0A0E14). The Legatus theme applies once the ThemeProvider mounts, and the
  theme is not written to `opencode-theme-id` until the user picks one.

Kept on purpose, with "OpenCode" left as is: "OpenCode server" (the server really is opencode),
WSL "Install/Update OpenCode" (installs the `opencode` CLI), "OpenCode Zen/Go" (upstream paid
services), "OpenCode Documentation" (links to upstream docs), "report this error to the OpenCode
team", and the "OpenCode does not support MCP authentication" note (server behavior), and the `opencode` theme's name.

## Hot reload vs restart (after this is merged into the live `dev` checkout)

- **Hot-reloads (renderer, Vite HMR / reload):** i18n branding, the theme JSON, the settings
  footer credit, the fonts and styles, and the logo component once the alias exists.
- **Needs a `bun dev` restart (the Vite config is read at startup):** `electron.vite.config.ts`
  (the brand define and the logo alias). Until that restart, `VITE_OPENCODE_BRAND` is undefined,
  so the renderer keeps the OpenCode brand. That is safe.
- **Needs a main-process restart:** `index.ts` (app name, About panel), `windows.ts` (window title
  for new windows), `native-translations.ts`. electron-vite restarts Electron on main-bundle
  changes, which drops the window and interrupts the agents. Do this between agent runs.
- **Needs `predev` (runs at `bun dev` start):** icons, because `copy-icons` fills `resources/icons`.
- The theme default applies only where no theme was ever picked (`opencode-theme-id` is unset in
  that profile's localStorage). If a theme was picked before, choose "Legatus" in Settings → Appearance.

## Keeping it mergeable with upstream

- The logic lives in 3 new modules (`app/src/brand.ts`, `ui/src/theme/brand/*`,
  `desktop/src/renderer/brand/logo.tsx`) and new asset folders. Upstream files get only 1–3
  line hooks, all of which call into those modules.
- No upstream English string, i18n key, logo file or icon file is edited. The rebrand is a
  transform over the dictionaries, so upstream copy changes merge cleanly. A new upstream key
  that says "OpenCode" stays "OpenCode" until someone adds it to the allow-list. That is the safe
  failure: it shows the old name and never mislabels the server.
- The theme is a new JSON file plus one name line, the same shape as the other 37 themes.

## Rollback

- Runtime: build with `OPENCODE_BRAND=opencode` → upstream brand, no code change.
- Code: `git revert` the implementation commit(s) on this branch, or don't merge it. No data
  migration exists to undo, because no path, id, key or file name changed. The only persistent
  side effect is a `localStorage` theme cache (`opencode-theme-css-*`) for the Legatus theme,
  which is ignored once another theme is picked.
