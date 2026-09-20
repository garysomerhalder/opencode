/**
 * Brand surface gate. It answers one question mechanically: with the brand switch on, can a user
 * still see the upstream name or mark anywhere in the product?
 *
 * The rule is an allow-list, not a spot-check. Every `/opencode/i` that survives branding has to
 * be declared here with a reason, or the gate fails. A declaration without a reason is itself a
 * failure (`brand-surface.test.ts` asserts every entry carries one).
 *
 * Two passes, both driven from `brand-surface.test.ts`:
 *
 *  1. **Dictionaries** — every key of every locale of every shipped dictionary (app, ui, desktop
 *     renderer, desktop native), after `brandDictionary(dict, LEGATUS)`. All locales, not just
 *     English: translators put the product name in places English does not, and only a per-locale
 *     sweep finds them. That pass is what caught `home.providerTip` (German only) and
 *     `settings.updates.toast.latest.title` (four locales) — both invisible to an English read.
 *  2. **Source literals and markup text** — every string literal and every JSX/HTML text node in
 *     the renderer and main-process closure. This catches copy that never went through i18n: a
 *     hard-coded menu label, a title attribute, an asset URL, a file the app writes for the user.
 *
 * Structural exclusions (whole categories the brand layer does not own, each with its reason):
 *
 *  - **Import and export specifiers** (`from "@opencode-ai/ui"`, `await import("…")`). Module
 *    specifiers and package names are not user-visible and are the shadow rename script's job,
 *    not the brand layer's. Excluded by position, so they never need an allow-list entry.
 *  - **Comment lines** — never rendered, and the brand layer discusses upstream by name.
 *  - **Lines that read the brand switch** (`activeBrand()` / `activeUiBrand()`) — the upstream
 *    literal on such a line is the switch-*off* value. "Switch the brand off and the app is
 *    unchanged" is the contract, so flagging those would be backwards.
 *  - **`**\/i18n\/**`** — covered more strictly by pass 1, which reads the values rather than
 *    the file text.
 *  - **`*.test.ts(x)`** — test fixtures and expectations are never rendered.
 *  - **`*.stories.tsx`** — Storybook is a developer tool, not part of the shipped desktop app.
 *  - **`brand.ts` / `brand-surface.ts`** — the brand layer names the upstream brand by design
 *    (`upstreamName`, the credit, this comment).
 *
 * What the gate cannot see, and what covers it instead:
 *
 *  - **Artwork.** A wordmark is letterform paths, not text; no regex can read it. The upstream
 *    wordmark and logo are swapped as whole modules by `electron.vite.config.ts`, and
 *    `brand-surface.test.ts` asserts those aliases exist and point at real files.
 *  - **Text fetched at runtime**, such as the release-notes feed from upstream's changelog. It is
 *    upstream's own release notes, so it names upstream; nothing in this repo can rewrite it.
 */

export const UPSTREAM_PATTERN = /opencode/i

export type Allowance = {
  /** `"<dictionary>:<key>"` for pass 1, `"<repo-relative path>:<literal>"` for pass 2. */
  id: string
  /** Why a user may see the upstream name here. Never empty. */
  reason: string
}

export type Hit = { id: string; value: string }

const group = (reason: string, ids: readonly string[]): Allowance[] => ids.map((id) => ({ id, reason }))

/**
 * Where the user is genuinely looking at upstream, a third party, or a real name on disk or on the
 * wire — and saying "Legatus" instead would be false.
 */
export const ALLOWLIST: readonly Allowance[] = [
  // ---- Upstream attribution --------------------------------------------------------------------
  ...group(
    "The upstream credit itself. Legatus is a fork of an MIT-licensed project and the attribution stays, intact and honest. Rendered in both settings dialogs and in the native About panel's credits.",
    ["app:brand.credit", "ui:brand.credit", "desktop:brand.credit", "native:brand.credit"],
  ),

  // ---- Links whose destination genuinely is upstream --------------------------------------------
  ...group(
    "Menu item that opens the upstream documentation site. The link text names the site it opens, which is truthful; Legatus publishes no docs of its own to point at.",
    ["native:desktop.menu.documentation", "app:desktop.menu.documentation"],
  ),
  ...group(
    "Precedes a button that opens https://opencode.ai/desktop-feedback. The report really does go to the upstream team, so naming them is truthful; sending it to a 'Legatus team' that will not receive it would be a lie.",
    ["app:error.page.report.prefix"],
  ),

  // ---- Third-party services the user connects to ------------------------------------------------
  ...group(
    "Names OpenCode Zen or OpenCode Go, third-party services the user authenticates against and pays. 'Free models provided by Legatus' would be false attribution for someone else's service, and the provider's own name is what the user has to recognise.",
    [
      "app:dialog.model.unpaid.freeModels.title",
      "app:provider.connect.opencodeZen.line1",
      "app:provider.connect.opencodeZen.visit.link",
      "ui:dialog.usageExceeded.freeTier.description",
    ],
  ),

  // ---- The upstream CLI installed inside a WSL distro -------------------------------------------
  // The WSL feature installs and runs the genuine upstream `opencode` binary inside the distro,
  // from upstream's installer, into the distro's own data dir. This app neither builds nor renames
  // that binary, so the onboarding copy names what it really installs. See the report note: if the
  // policy becomes "no upstream name anywhere", the honest fix is to hide the WSL feature in the
  // Legatus build, not to relabel someone else's binary.
  ...group(
    "Names the upstream `opencode` binary this app installs into a WSL distro. The binary really is called that; relabelling it would tell the user to look for a command that does not exist.",
    [
      "app:wsl.onboarding.checkingOpencode",
      "app:wsl.onboarding.checkingOpencodeIn",
      "app:wsl.onboarding.distroStatus.opencodeMissing",
      "app:wsl.onboarding.installOpencode",
      "app:wsl.onboarding.installOpencodeIn",
      "app:wsl.onboarding.opencodeReady",
      "app:wsl.onboarding.opencodeReadyIn",
      "app:wsl.onboarding.step.opencode",
      "app:wsl.onboarding.updateOpencode",
      "app:wsl.onboarding.updateOpencodeIn",
      "app:wsl.onboarding.updatingOpencode",
      "app:wsl.onboarding.updatingOpencodeIn",
      "app:settings.desktop.wsl.description",
      "app:desktop.wsl.error.installOpencode",
      "app:desktop.wsl.error.opencodeCannotRun",
      "app:desktop.wsl.error.opencodeMissing",
      "app:desktop.wsl.error.opencodeNotInstalled",
      "app:desktop.wsl.error.updateVersion",
      "native:desktop.wsl.error.installOpencode",
      "native:desktop.wsl.error.opencodeCannotRun",
      "native:desktop.wsl.error.opencodeMissing",
      "native:desktop.wsl.error.opencodeNotInstalled",
      "native:desktop.wsl.error.updateVersion",
    ],
  ),

  // ---- Real names on disk the user is told about ------------------------------------------------
  ...group(
    "Names `opencode.json`, the project config file this app really reads. Project config is deliberately shared with upstream (docs/legatus-shadow.md), so the filename is correct as written.",
    ["app:dialog.plugins.empty", "app:error.chain.checkConfig"],
  ),
  ...group(
    "Names the CLI binary just written to disk. The binary's name is owned by the shadow rename script (rule R14), not by the brand layer; the message must match whatever was actually installed.",
    ["desktop:desktop.cli.installed.message"],
  ),

  // ---- SWITCH_OFF -------------------------------------------------------------------------------
  ...group(
    "Upstream value used only when the brand switch is off. 'Switch off and the app is unchanged' is the contract, so this literal has to stay exactly as upstream wrote it. (The switch is read a few lines above, out of reach of the per-line rule.)",
    [
      "packages/desktop/src/main/index.ts:OpenCode",
      "packages/desktop/src/main/index.ts:OpenCode Beta",
      "packages/desktop/src/main/index.ts:OpenCode Dev",
    ],
  ),

  // ---- IDENTITY ---------------------------------------------------------------------------------
  ...group(
    "Electron app id / userData folder name. Application identity, not display copy; owned by the shadow rename script (rule R8), not the brand layer.",
    [
      "packages/desktop/src/main/background-cli.ts:ai.opencode.desktop",
      "packages/desktop/src/main/background-cli.ts:ai.opencode.desktop.beta",
      "packages/desktop/src/main/background-cli.ts:ai.opencode.desktop.dev",
      "packages/desktop/src/main/index.ts:ai.opencode.desktop",
      "packages/desktop/src/main/index.ts:ai.opencode.desktop.beta",
      "packages/desktop/src/main/index.ts:ai.opencode.desktop.dev",
      "packages/desktop/src/main/migrate.ts:ai.opencode.desktop",
      "packages/desktop/src/main/migrate.ts:ai.opencode.desktop.beta",
      "packages/desktop/src/main/migrate.ts:ai.opencode.desktop.dev",
    ],
  ),

  // ---- STORAGE ----------------------------------------------------------------------------------
  ...group(
    "Persisted storage key or electron-store file name. Private to this app's own profile, never rendered; renaming it would orphan an existing user's data.",
    [
      "packages/app/src/context/global-sync/bootstrap.ts:opencode-test",
      "packages/app/src/context/language.tsx:opencode.global.dat:language",
      "packages/app/src/entry.tsx:opencode.settings.dat:defaultServerUrl",
      "packages/app/src/utils/draft-store.ts:opencode-drafts",
      "packages/app/src/utils/persist.ts:opencode.",
      "packages/app/src/utils/persist.ts:opencode.draft.${head}.${sum}.dat",
      "packages/app/src/utils/persist.ts:opencode.global.dat",
      "packages/app/src/utils/persist.ts:opencode.window",
      "packages/app/src/utils/persist.ts:opencode.workspace.${head}.${sum}.dat",
      "packages/desktop/src/main/index.ts:opencode-onboarding-${randomUUID()}",
      "packages/desktop/src/main/install-state.ts:opencode.settings",
      "packages/desktop/src/main/migrate.ts:opencode.settings",
      "packages/desktop/src/main/migrate.ts:opencode.settings.dat",
      "packages/desktop/src/main/updater.ts:opencode.updater",
      'packages/desktop/src/main/windows.ts:opencode.window.${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.dat',
      "packages/desktop/src/renderer/index.tsx:opencode.desktop.window.${windowID}.last-active-url",
      "packages/desktop/src/renderer/index.tsx:opencode.global.dat",
      "packages/ui/src/theme/context.tsx:opencode-color-scheme",
      "packages/ui/src/theme/context.tsx:opencode-theme-css-dark",
      "packages/ui/src/theme/context.tsx:opencode-theme-css-light",
      "packages/ui/src/theme/context.tsx:opencode-theme-id",
      "packages/ui/src/theme/loader.ts:opencode-theme",
    ],
  ),

  // ---- MARKUP_ID --------------------------------------------------------------------------------
  ...group("DOM element id or SVG sprite id. A markup identifier used to find a node; never rendered as text.", [
    "packages/app/src/components/session/session-header.tsx:opencode-titlebar-center",
    "packages/app/src/components/titlebar.tsx:opencode-titlebar-center",
    "packages/app/src/components/titlebar.tsx:opencode-titlebar-left",
    "packages/app/src/components/titlebar.tsx:opencode-titlebar-right",
    "packages/ui/src/components/icon.tsx:opencode-icon-${name}",
    "packages/ui/src/components/icon.tsx:opencode-icon-sprite",
    "packages/ui/src/v2/components/icon.tsx:opencode-v2-icon-${name}",
    "packages/ui/src/v2/components/icon.tsx:opencode-v2-icon-sprite",
  ]),

  // ---- WIRE -------------------------------------------------------------------------------------
  ...group(
    "Server wire protocol or provider id: a request header, the basic-auth user, a deep-link scheme, a models.dev provider key matched against server data. A contract with the server, a third party or the OS, not display copy.",
    [
      "packages/app/src/components/dialog-connect-provider.tsx:opencode",
      "packages/app/src/components/dialog-connect-provider.tsx:opencode-desktop",
      "packages/app/src/components/dialog-select-model-unpaid-v2.tsx:opencode",
      "packages/app/src/components/dialog-select-model-unpaid.tsx:opencode",
      "packages/app/src/components/dialog-select-model.tsx:opencode",
      "packages/app/src/components/dialog-select-server.tsx:opencode",
      "packages/app/src/components/settings-providers.tsx:opencode",
      "packages/app/src/components/settings-v2/providers.tsx:opencode",
      "packages/app/src/components/terminal.tsx:opencode",
      "packages/app/src/components/terminal.tsx:x-opencode-ticket",
      "packages/app/src/hooks/use-providers.ts:opencode",
      "packages/app/src/pages/layout/deep-links.ts:opencode://",
      "packages/app/src/pages/session/usage-exceeded-dialogs.tsx:opencode",
      'packages/app/src/utils/server.ts:${input.username ?? "opencode"}:${input.password}',
      "packages/app/src/utils/server.ts:opencode",
      "packages/app/src/wsl/settings-model.ts:opencode:${item.name}",
      "packages/desktop/src/main/background-cli.ts:opencode",
      "packages/desktop/src/main/env.d.ts:virtual:opencode-server",
      'packages/desktop/src/main/goal-loop.ts:${server.username ?? "opencode"}:${server.password ?? ""}',
      "packages/desktop/src/main/goal-loop.ts:x-opencode-directory",
      "packages/desktop/src/main/index.ts:opencode",
      "packages/desktop/src/main/index.ts:opencode://",
      "packages/desktop/src/main/install-state.ts:opencode",
      "packages/desktop/src/main/logging.ts:opencode",
      "packages/desktop/src/main/server.ts:opencode:${password}",
      "packages/desktop/src/main/sidecar.ts:opencode",
      "packages/desktop/src/main/wsl/sidecar.ts:opencode",
      "packages/desktop/src/renderer/index.tsx:opencode:deep-link",
      "packages/ui/src/components/provider-icons/types.ts:opencode",
    ],
  ),
  ...group(
    "models.dev provider id for OpenCode Zen / OpenCode Go, matched against server data. A third party's identifier on the wire.",
    [
      "packages/app/src/components/dialog-connect-provider.tsx:opencode-go",
      "packages/app/src/components/dialog-select-model-unpaid-v2.tsx:opencode-go",
      "packages/app/src/components/dialog-select-model-unpaid.tsx:opencode-go",
      "packages/app/src/components/settings-providers.tsx:opencode-go",
      "packages/app/src/components/settings-v2/providers.tsx:opencode-go",
      "packages/app/src/hooks/use-providers.ts:opencode-go",
      "packages/app/src/pages/session/usage-exceeded-dialogs.tsx:opencode-go",
      "packages/ui/src/components/provider-icons/types.ts:opencode-go",
    ],
  ),

  // ---- IPC --------------------------------------------------------------------------------------
  ...group("Internal IPC channel name between the renderer and the main process. Never rendered.", [
    "packages/app/src/wsl/dialog-add-server.tsx:install-opencode",
    "packages/app/src/wsl/settings-model.ts:install-opencode",
    "packages/app/src/wsl/settings.tsx:install-opencode",
    "packages/app/src/wsl/types.ts:install-opencode",
    "packages/desktop/src/main/wsl/ipc.ts:wsl-servers-install-opencode",
    "packages/desktop/src/main/wsl/servers.ts:install-opencode",
    "packages/desktop/src/preload/index.ts:wsl-servers-install-opencode",
  ]),

  // ---- WSL_BINARY -------------------------------------------------------------------------------
  ...group(
    "Command line, install path or environment variable for the upstream `opencode` binary this app runs inside a WSL distro. Someone else's binary and its own contract; the brand layer cannot rename it.",
    [
      "packages/desktop/src/main/wsl/runtime.ts:curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)}",
      'packages/desktop/src/main/wsl/runtime.ts:if [ -x "$HOME/.opencode/bin/opencode" ]; then printf "%s\\\\n" "$HOME/.opencode/bin/opencode"; fi',
      "packages/desktop/src/main/wsl/servers.ts:wsl opencode check failed",
      'packages/desktop/src/main/wsl/sidecar.ts:exec ${shellEscape(opencode)} --print-logs --log-level ${app.isPackaged ? "WARN" : "INFO"} serve --hostname 0.0.0.0 --port ${port}',
      "packages/desktop/src/main/wsl/sidecar.ts:export OPENCODE_CLIENT=desktop",
      "packages/desktop/src/main/wsl/sidecar.ts:export OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
      "packages/desktop/src/main/wsl/sidecar.ts:export OPENCODE_SERVER_PASSWORD=${shellEscape(password)}",
      "packages/desktop/src/main/wsl/sidecar.ts:export OPENCODE_SERVER_USERNAME=${shellEscape(username)}",
    ],
  ),

  // ---- CLI_BINARY -------------------------------------------------------------------------------
  ...group(
    "Name of the bundled CLI binary on disk. Owned by upstream's build and by the shadow rename script (rule R14), not by the brand layer.",
    [
      "packages/desktop/src/main/background-cli.ts:opencode-cli",
      "packages/desktop/src/main/background-cli.ts:opencode-cli.exe",
    ],
  ),

  // ---- PROCESS_LABEL ----------------------------------------------------------------------------
  ...group(
    "Electron utility-process service name. It appears only in Chromium's own task manager, which this app exposes no way to open, and the same constant is matched against child-process events.",
    ["packages/desktop/src/main/server.ts:opencode server"],
  ),

  // ---- I18N_KEY ---------------------------------------------------------------------------------
  ...group(
    "i18n key naming a third-party provider or the WSL flow. Keys are identifiers; the values behind them are checked by the dictionary pass.",
    [
      "packages/app/src/components/dialog-connect-provider.tsx:dialog.provider.opencode.tagline",
      "packages/app/src/components/dialog-connect-provider.tsx:dialog.provider.opencodeGo.tagline",
      "packages/app/src/components/dialog-connect-provider.tsx:provider.connect.opencodeZen.line1",
      "packages/app/src/components/dialog-connect-provider.tsx:provider.connect.opencodeZen.line2",
      "packages/app/src/components/dialog-connect-provider.tsx:provider.connect.opencodeZen.visit.link",
      "packages/app/src/components/dialog-connect-provider.tsx:provider.connect.opencodeZen.visit.prefix",
      "packages/app/src/components/dialog-connect-provider.tsx:provider.connect.opencodeZen.visit.suffix",
      "packages/app/src/components/dialog-select-model-unpaid-v2.tsx:dialog.provider.opencode.tagline",
      "packages/app/src/components/dialog-select-model-unpaid-v2.tsx:dialog.provider.opencodeGo.tagline",
      "packages/app/src/components/dialog-select-model-unpaid.tsx:dialog.provider.opencode.tagline",
      "packages/app/src/components/dialog-select-model-unpaid.tsx:dialog.provider.opencodeGo.tagline",
      "packages/app/src/components/settings-providers.tsx:dialog.provider.opencode.note",
      "packages/app/src/components/settings-providers.tsx:dialog.provider.opencodeGo.tagline",
      "packages/app/src/components/settings-v2/providers.tsx:dialog.provider.opencode.note",
      "packages/app/src/components/settings-v2/providers.tsx:dialog.provider.opencodeGo.tagline",
      "packages/app/src/wsl/settings-model.ts:wsl.onboarding.distroStatus.opencodeMissing",
      "packages/app/src/wsl/settings-model.ts:wsl.onboarding.installOpencode",
      "packages/app/src/wsl/settings-model.ts:wsl.onboarding.updateOpencode",
      "packages/app/src/wsl/settings-model.ts:wsl.onboarding.updatingOpencode",
      "packages/desktop/src/main/wsl/servers.ts:desktop.wsl.error.installOpencode",
      "packages/desktop/src/main/wsl/servers.ts:desktop.wsl.error.opencodeCannotRun",
      "packages/desktop/src/main/wsl/servers.ts:desktop.wsl.error.opencodeMissing",
      "packages/desktop/src/main/wsl/sidecar.ts:desktop.wsl.error.opencodeNotInstalled",
    ],
  ),

  // ---- HIGHLIGHTER_THEME ------------------------------------------------------------------------
  ...group(
    "Shiki syntax-highlighter theme id, registered and looked up by name inside the markdown renderer. It is not the app's theme list and appears in no picker.",
    [
      "packages/ui/src/context/marked-theme-register.tsx:OpenCode",
      "packages/ui/src/context/marked-theme.tsx:OpenCode",
      "packages/ui/src/context/marked.tsx:OpenCode",
    ],
  ),

  // ---- CONFIG_FILE ------------------------------------------------------------------------------
  ...group(
    "Names `opencode.json`, the project config file this app really reads. Project config is deliberately shared with upstream (docs/legatus-shadow.md), so the filename is correct as written.",
    [
      "packages/app/src/components/status-popover-body.tsx:opencode.json",
      "packages/app/src/utils/server-errors.ts:Check your config (opencode.json) provider/model names",
    ],
  ),

  // ---- UPSTREAM_URL -----------------------------------------------------------------------------
  ...group(
    "A link whose destination genuinely is upstream: their docs, changelog feed, issue tracker, Discord or feedback form. The destination stays truthful, and no link text presents it as this product.",
    [
      "packages/app/src/components/dialog-connect-provider.tsx:https://opencode.ai/zen",
      "packages/app/src/components/dialog-custom-provider.tsx:https://opencode.ai/docs/providers/#custom-provider",
      "packages/app/src/components/settings-general.tsx:https://opencode.ai/docs/themes/",
      "packages/app/src/components/settings-v2/general.tsx:https://opencode.ai/docs/themes/",
      "packages/app/src/context/highlights.tsx:https://opencode.ai/changelog.json",
      "packages/app/src/pages/error.tsx:https://opencode.ai/desktop-feedback",
      "packages/app/src/pages/layout/helpers.ts:https://opencode.ai/favicon.svg",
      "packages/app/src/desktop-menu.ts:https://discord.com/invite/opencode",
      "packages/app/src/desktop-menu.ts:https://github.com/anomalyco/opencode/issues/new?template=bug_report.yml",
      "packages/app/src/desktop-menu.ts:https://github.com/anomalyco/opencode/issues/new?template=feature_request.yml",
      "packages/app/src/desktop-menu.ts:https://opencode.ai/docs",
      "packages/app/src/pages/home/home-projects-controller.tsx:https://opencode.ai/desktop-feedback",
      "packages/app/src/pages/layout.tsx:https://opencode.ai/desktop-feedback",
      "packages/ui/src/theme/brand/legatus.ts:https://opencode.ai/desktop-theme.json",
    ],
  ),

  // ---- HOST / ENV -------------------------------------------------------------------------------
  ...group(
    "Hostname test and build-time environment variable names used to pick a default server URL. Neither the hostname nor the env var names are ever rendered.",
    [
      "packages/app/src/entry.tsx:opencode.ai",
      'packages/app/src/entry.tsx:http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}',
    ],
  ),
]

const ALLOWED = new Map(ALLOWLIST.map((entry) => [entry.id, entry.reason]))

export function isAllowed(id: string) {
  return ALLOWED.has(id)
}

/**
 * Every `/opencode/i` value in `dict`, keyed `"<name>:<key>"`. Allow-listed ids are dropped unless
 * `all` is set, which the stale-entry check uses to see everything the gate would have matched.
 */
export function dictionaryViolations(name: string, dict: Record<string, unknown>, all = false): Hit[] {
  const out: Hit[] = []
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value !== "string") continue
    if (!UPSTREAM_PATTERN.test(value)) continue
    const id = `${name}:${key}`
    if (!all && ALLOWED.has(id)) continue
    out.push({ id, value })
  }
  return out
}

const IMPORT_LINE = /^\s*(?:import|export)\b|\bfrom\s*["'`]|\b(?:require|import)\s*\(/
/** A comment line. Comments are not rendered, and the brand layer discusses upstream by name. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|<!--)/
/**
 * A line that reads the brand switch. Its upstream literal is the switch-*off* value, which is
 * required to stay exactly as upstream wrote it, so flagging it would be backwards.
 */
const BRAND_SWITCHED = /\bactive(?:Ui)?Brand\(\)/
const LITERAL = /"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g
/** JSX/HTML text between tags: `<GroupLabel …>OpenCode</GroupLabel>`, `<title>OpenCode</title>`. */
const MARKUP_TEXT = />([^<>{}"'`]*[A-Za-z][^<>{}"'`]*)</g

/**
 * Every `/opencode/i` string literal **and** rendered markup text in `text`, keyed
 * `"<path>:<literal>"`. Allow-listed ids are dropped unless `all` is set.
 *
 * Markup text matters as much as literals: the hard-coded `OpenCode` in the Windows app menu was a
 * JSX text node, not a string, and a literals-only scan walks straight past it.
 */
export function sourceViolations(path: string, text: string, all = false): Hit[] {
  const out: Hit[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    if (!UPSTREAM_PATTERN.test(value)) return
    const id = `${path}:${value}`
    if (seen.has(id) || (!all && ALLOWED.has(id))) return
    seen.add(id)
    out.push({ id, value })
  }
  for (const line of text.split("\n")) {
    if (COMMENT_LINE.test(line) || BRAND_SWITCHED.test(line)) continue
    for (const match of line.matchAll(MARKUP_TEXT)) add(match[1]!.trim())
    if (IMPORT_LINE.test(line)) continue
    for (const match of line.matchAll(LITERAL)) add(match[1] ?? match[2] ?? match[3] ?? "")
  }
  return out
}

/** Human-readable failure text: what was found and where. */
export function describe(hits: readonly Hit[]) {
  return hits.map((hit) => `  ${hit.id}\n      ${JSON.stringify(hit.value).slice(0, 160)}`).join("\n")
}
