// Environment defaults the desktop sets for itself and its local server.
// Pure (no electron import) so it can be tested and ported as-is.

export function appEnvDefaults(platform: NodeJS.Platform): Record<string, string> {
  return {
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    // The experimental working-tree watcher stays off on Windows: the sidecar
    // crashed on 2026-09-21 15:59:48 with a null read (c0000005 at 0x30) on a
    // native thread of @parcel/watcher-win32-x64 2.5.1, watcher.node+0x2d888
    // (Crashpad dump b6c182f3-29a8-4644-a897-8484037f5a82). A reversible guard
    // until the watcher is upgraded or replaced (#43, #46).
    ...(platform === "win32" ? {} : { OPENCODE_EXPERIMENTAL_FILEWATCHER: "true" }),
    OPENCODE_CLIENT: "desktop",
  }
}
