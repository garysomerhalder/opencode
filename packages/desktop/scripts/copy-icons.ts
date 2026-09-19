import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()
// Brand layer (docs/legatus-brand.md): same switch as electron.vite.config.ts. The icon set is shared
// across channels; the channel folders stay untouched for OPENCODE_BRAND=opencode.
const branded = (process.env.OPENCODE_BRAND ?? "legatus") === "legatus"

const src = branded ? "./icons/legatus" : `./icons/${channel}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${branded ? "legatus" : channel} icons from ${src} to ${dest}`)
