import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildIcns, buildIco, ICON_BACKGROUND, iconSvg } from "./legatus-icons-lib"

const pkg = join(import.meta.dir, "..")
const png = (size: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(size)])

describe("legatus icon helpers", () => {
  test("composes the official mark on the navy background, centered with padding", () => {
    const mark = readFileSync(join(pkg, "src/renderer/brand/legatus-icon-official-white.svg"), "utf8")
    const svg = iconSvg(mark, 256)
    expect(svg).toContain(`fill="${ICON_BACKGROUND}"`)
    expect(ICON_BACKGROUND).toBe("#0A0E14")
    expect(svg.match(/<path /g)?.length).toBe(3)
    const scale = Number(/scale\(([\d.]+)\)/.exec(svg)![1])
    expect(370 * scale).toBeCloseTo(256 * 0.7, 3)
  })

  test("ICO directory points at each PNG entry", () => {
    const entries = [16, 32, 256].map((size) => ({ size, png: png(size) }))
    const ico = buildIco(entries)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(3)
    expect(ico.readUInt8(6 + 32)).toBe(0) // 256px is encoded as 0
    const offset = ico.readUInt32LE(6 + 16 * 2 + 12)
    const length = ico.readUInt32LE(6 + 16 * 2 + 8)
    expect(ico.subarray(offset, offset + length)).toEqual(entries[2]!.png)
    expect(ico.length).toBe(6 + 48 + entries.reduce((sum, entry) => sum + entry.png.length, 0))
  })

  test("ICNS header length and chunk types", () => {
    const icns = buildIcns([16, 1024].map((size) => ({ size, png: png(size) })))
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns")
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    expect(icns.subarray(8, 12).toString("ascii")).toBe("icp4")
    expect(() => buildIcns([{ size: 20, png: png(1) }])).toThrow()
  })

  test("generated icon set is committed with the files electron and electron-builder read", () => {
    for (const name of ["icon.ico", "icon.icns", "icon.png", "dock.png", "32x32.png", "128x128.png", "128x128@2x.png"]) {
      expect(existsSync(join(pkg, "icons/legatus", name))).toBe(true)
    }
    const ico = readFileSync(join(pkg, "icons/legatus/icon.ico"))
    expect(ico.readUInt16LE(4)).toBe(7)
  })
})
