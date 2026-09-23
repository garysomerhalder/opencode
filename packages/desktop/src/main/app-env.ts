// Environment defaults the desktop sets for itself and its local server.
// Pure (no electron import) so it can be tested and ported as-is.

// On Windows the native file watcher is off entirely. The sidecar crashed on
// 2026-09-21 15:59:48 with a null read (c0000005 at 0x30) on a native thread of
// @parcel/watcher-win32-x64 2.5.1, watcher.node+0x2d888 (Crashpad dump
// b6c182f3-29a8-4644-a897-8484037f5a82). The dump cannot say whether the
// working-tree or the .git subscription crashed, so neither runs:
// OPENCODE_EXPERIMENTAL_FILEWATCHER is not set, and
// OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER turns off the .git subscription too.
// Cost on Windows: files changed outside the agent (editor, git, scripts) and
// the branch label no longer update live; they show on reload. Edits made by
// the agent's own tools still refresh, because those tools publish the update
// themselves. A value already in the environment wins, so setting
// OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=false and
// OPENCODE_EXPERIMENTAL_FILEWATCHER=true turns the watcher back on.
// Reversible guard until @parcel/watcher is upgraded and soaked (#43, #46).

export function appEnvDefaults(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const watcher: Record<string, string> =
    platform === "win32"
      ? { OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER ?? "true" }
      : { OPENCODE_EXPERIMENTAL_FILEWATCHER: "true" }
  return {
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    ...watcher,
    OPENCODE_CLIENT: "desktop",
  }
}
