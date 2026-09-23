import { $ } from "bun"
import { downloadCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// --use-system-ca: the models.dev fetch in build-node fails behind a TLS-intercepting
// proxy (Norton here) with Bun's bundled CA list. MODELS_DEV_API_JSON skips the fetch.
await $`cd ../opencode && bun --use-system-ca script/build-node.ts`
await downloadCliToResources()
