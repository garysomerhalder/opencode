interface ImportMetaEnv {
  /** Brand layer switch, defined by packages/desktop/electron.vite.config.ts. See src/brand.ts. */
  readonly VITE_OPENCODE_BRAND?: string
}

interface ImportMeta {
  readonly env?: ImportMetaEnv
}
