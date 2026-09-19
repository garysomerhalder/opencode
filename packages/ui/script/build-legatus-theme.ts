#!/usr/bin/env bun
// Regenerates src/theme/themes/legatus.json from the Legatus Brand API token snapshot.
// Usage (from packages/ui): bun script/build-legatus-theme.ts
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { LEGATUS_THEME } from "../src/theme/brand/legatus"

const out = join(import.meta.dir, "../src/theme/themes/legatus.json")
writeFileSync(out, JSON.stringify(LEGATUS_THEME, null, 2) + "\n")
console.log(`wrote ${out}`)
