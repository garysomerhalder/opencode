#!/usr/bin/env bun
// Builds packages/desktop/icons/legatus from the official Legatus icon mark
// (src/renderer/brand/legatus-icon-official-white.svg, Brand API asset `logo-icon-white-svg`).
// Brand API social/favicon spec: white icon only, on #0A0E14, with padding.
//
// The rasterizer is deliberately not a repo dependency. Install it anywhere and point at it:
//   npm i --prefix "$TMP/resvg" @resvg/resvg-js@2
//   RESVG_MODULE="$TMP/resvg/node_modules/@resvg/resvg-js/index.js" bun scripts/legatus-icons.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { buildIcns, buildIco, iconSvg } from "./legatus-icons-lib"

const { Resvg } = await import(
  process.env.RESVG_MODULE ? pathToFileURL(process.env.RESVG_MODULE).href : "@resvg/resvg-js"
)

const pkg = join(import.meta.dir, "..")
const out = join(pkg, "icons", "legatus")
mkdirSync(out, { recursive: true })
const mark = readFileSync(join(pkg, "src/renderer/brand/legatus-icon-official-white.svg"), "utf8")

const render = (size: number) =>
  Buffer.from(new Resvg(iconSvg(mark, size), { fitTo: { mode: "width", value: size } }).render().asPng())

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const png = new Map(sizes.map((size) => [size, render(size)]))
const write = (name: string, data: Buffer) => {
  writeFileSync(join(out, name), data)
  console.log(`wrote icons/legatus/${name} (${data.length} bytes)`)
}

for (const size of sizes) write(`${size}x${size}.png`, png.get(size)!)
write("128x128@2x.png", png.get(256)!)
write("icon.png", png.get(512)!)
write("dock.png", png.get(256)!)
write("icon.ico", buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png.get(size)! }))))
write("icon.icns", buildIcns([16, 32, 64, 128, 256, 512, 1024].map((size) => ({ size, png: png.get(size)! }))))
