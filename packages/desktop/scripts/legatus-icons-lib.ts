// Pure helpers for scripts/legatus-icons.ts (and its test): SVG composition plus ICO/ICNS containers.

export const ICON_BACKGROUND = "#0A0E14"

/**
 * Puts the official mark on a navy rounded square. The mark is scaled to 70% of the canvas
 * height and centered, which leaves 15% padding (about 27px at 180px) and matches the Brand
 * API apple-touch spec of "20px padding at 180" once the mark's own side bearing is included.
 */
export function iconSvg(mark: string, size: number) {
  const viewBox = /viewBox="([^"]+)"/.exec(mark)?.[1]?.split(/\s+/).map(Number) ?? [0, 0, 1, 1]
  const [vx, vy, vw, vh] = viewBox as [number, number, number, number]
  const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
  const height = size * 0.7
  const scale = height / vh
  const width = vw * scale
  const x = (size - width) / 2 - vx * scale
  const y = (size - height) / 2 - vy * scale
  const radius = size * 0.18
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${ICON_BACKGROUND}"/>
<g transform="translate(${x} ${y}) scale(${scale})">${inner}</g>
</svg>`
}

type Entry = { size: number; png: Buffer }

/** ICO with PNG-compressed entries (Windows Vista+). A 256px entry is written as width/height 0. */
export function buildIco(entries: Entry[]) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  const offset = { value: 6 + dir.length }
  entries.forEach((entry, i) => {
    const at = i * 16
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at)
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1)
    dir.writeUInt8(0, at + 2)
    dir.writeUInt8(0, at + 3)
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset.value, at + 12)
    offset.value += entry.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((entry) => entry.png)])
}

const ICNS_TYPES: Record<number, string> = {
  16: "icp4",
  32: "icp5",
  64: "icp6",
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
}

/** ICNS with PNG payloads (the OSTypes icp4…ic10 accept PNG data). */
export function buildIcns(entries: Entry[]) {
  const chunks = entries.map((entry) => {
    const type = ICNS_TYPES[entry.size]
    if (!type) throw new Error(`no ICNS type for ${entry.size}px`)
    const head = Buffer.alloc(8)
    head.write(type, 0, "ascii")
    head.writeUInt32BE(entry.png.length + 8, 4)
    return Buffer.concat([head, entry.png])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write("icns", 0, "ascii")
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}
