import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseBrandSvg } from "./svg"

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8")

describe("brand svg assets", () => {
  test("icon mark parses to a 0-origin viewBox with three currentColor paths", () => {
    const icon = parseBrandSvg(read("legatus-icon.svg"))
    expect(icon.viewBox).toBe("0 0 263 364")
    expect(icon.inner.match(/<path /g)?.length).toBe(3)
    expect(icon.inner).not.toContain("#FFFFFF")
    expect(icon.inner).not.toContain("<svg")
    expect(icon.inner.match(/fill="currentColor"/g)?.length).toBe(3)
  })

  test("lockup parses with the icon plus wordmark paths", () => {
    const lockup = parseBrandSvg(read("legatus-lockup.svg"))
    expect(lockup.viewBox).toBe("0 0 1899 364")
    expect(lockup.inner.match(/<path /g)?.length).toBe(10)
    expect(lockup.inner).not.toContain("#FFFFFF")
  })

  test("the flat icon is the official Brand API mark translated by -306 on x", () => {
    const official = read("legatus-icon-official-white.svg")
    const flat = read("legatus-icon.svg")
    const first = (svg: string) => /d="M([\d.]+) ([\d.]+)/.exec(svg)!.slice(1).map(Number)
    const [ox, oy] = first(official)
    const [fx, fy] = first(flat)
    expect(ox! - 306).toBeCloseTo(fx!, 1)
    expect(oy!).toBeCloseTo(fy!, 1)
  })

  test("the logo module has the same exports as @opencode-ai/ui/logo", () => {
    const upstream = readFileSync(join(import.meta.dir, "../../../../ui/src/components/logo.tsx"), "utf8")
    const ours = read("logo.tsx")
    const exports = (src: string) => [...src.matchAll(/export const (\w+)/g)].map((m) => m[1]).sort()
    expect(exports(ours)).toEqual(exports(upstream))
  })
})
