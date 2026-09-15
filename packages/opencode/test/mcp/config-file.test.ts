import { describe, expect, test } from "bun:test"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { addMcpEntry, configBase, removeMcpEntry, resolveConfigFile } from "../../src/mcp/config-file"
import { tmpdir } from "../fixture/fixture"

const local = { type: "local", command: ["bun", "x", "server"] } as { type: "local"; command: string[] }
const remote = { type: "remote", url: "https://example.com/mcp" } as { type: "remote"; url: string }

function scope(dir: string) {
  return { worktree: dir, directory: dir }
}

async function read(file: string) {
  const text = await Filesystem.readText(file)
  return parseJsonc(text) as { mcp?: Record<string, unknown> }
}

describe("mcp.config-file", () => {
  test("add writes a new entry and preserves siblings", async () => {
    await using tmp = await tmpdir()
    const file = await resolveConfigFile(scope(tmp.path))
    expect(file).toBe(path.join(tmp.path, "opencode.json"))
    const out = await addMcpEntry(file, "acme", { ...local })
    expect(out.ok).toBe(true)
    expect((await read(file)).mcp).toEqual({ acme: { ...local } })
  })

  test("add prefers an existing jsonc file", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "opencode.jsonc")
    await Bun.write(target, `{\n  // keep me\n  "mcp": {}\n}\n`)
    const file = await resolveConfigFile(scope(tmp.path))
    expect(file).toBe(target)
    const out = await addMcpEntry(file, "acme", { ...remote })
    expect(out.ok).toBe(true)
    const text = await Filesystem.readText(target)
    expect(text).toContain("// keep me")
    expect((await read(target)).mcp).toEqual({ acme: { ...remote } })
  })

  test("add replaces an existing entry", async () => {
    await using tmp = await tmpdir()
    const file = await resolveConfigFile(scope(tmp.path))
    await addMcpEntry(file, "acme", { ...local })
    await addMcpEntry(file, "acme", { ...remote })
    expect((await read(file)).mcp).toEqual({ acme: { ...remote } })
  })

  test("remove drops the entry and leaves the rest", async () => {
    await using tmp = await tmpdir()
    const file = await resolveConfigFile(scope(tmp.path))
    await addMcpEntry(file, "acme", { ...local })
    await addMcpEntry(file, "other", { ...remote })
    const out = await removeMcpEntry(file, "acme")
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.removed).toBe(true)
    expect((await read(file)).mcp).toEqual({ other: { ...remote } })
  })

  test("remove reports noop for a missing entry or file", async () => {
    await using tmp = await tmpdir()
    const file = await resolveConfigFile(scope(tmp.path))
    const missing = await removeMcpEntry(file, "acme")
    expect(missing.ok).toBe(true)
    if (!missing.ok) return
    expect(missing.removed).toBe(false)
    expect(await Filesystem.exists(file)).toBe(false)

    await addMcpEntry(file, "other", { ...remote })
    const absent = await removeMcpEntry(file, "acme")
    expect(absent.ok).toBe(true)
    if (!absent.ok) return
    expect(absent.removed).toBe(false)
    expect((await read(file)).mcp).toEqual({ other: { ...remote } })
  })

  test("remove returns invalid_json for a broken config", async () => {
    await using tmp = await tmpdir()
    const file = await resolveConfigFile(scope(tmp.path))
    await Bun.write(file, "{ mcp: {")
    const out = await removeMcpEntry(file, "acme")
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe("invalid_json")
  })

  test("configBase prefers worktree for git projects", async () => {
    await using tmp = await tmpdir()
    expect(configBase({ worktree: tmp.path, directory: "/other", vcs: "git" })).toBe(tmp.path)
    expect(configBase({ worktree: "/", directory: "/other", vcs: "git" })).toBe("/other")
    expect(configBase({ worktree: tmp.path, directory: "/other" })).toBe("/other")
  })
})
