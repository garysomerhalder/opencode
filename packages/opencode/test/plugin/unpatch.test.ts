import { describe, expect, test } from "bun:test"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { unpatchPluginConfig, type PatchDeps } from "../../src/plugin/install"
import { tmpdir } from "../fixture/fixture"

function deps(): PatchDeps {
  return {
    readText: (file) => Filesystem.readText(file),
    write: async (file, text) => {
      await Filesystem.write(file, text)
    },
    exists: (file) => Filesystem.exists(file),
    files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
  }
}

function cfg(dir: string, name: "opencode" | "tui") {
  return path.join(dir, ".opencode", `${name}.json`)
}

async function seed(dir: string, name: "opencode" | "tui", plugin: unknown[]) {
  await Bun.write(cfg(dir, name), JSON.stringify({ plugin }, null, 2))
}

async function read(dir: string, name: "opencode" | "tui") {
  return Filesystem.readJson<{ plugin?: unknown[] }>(cfg(dir, name))
}

describe("plugin.unpatch.config", () => {
  test("removes the exact spec entry and leaves the rest", async () => {
    await using tmp = await tmpdir()
    await seed(tmp.path, "opencode", ["acme@1.2.3", "other"])
    const out = await unpatchPluginConfig(
      { spec: "acme@1.2.3", worktree: tmp.path, directory: tmp.path },
      deps(),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const server = out.items.find((item) => item.kind === "server")
    expect(server?.mode).toBe("removed")
    expect(server?.removed).toEqual(["acme@1.2.3"])
    expect((await read(tmp.path, "opencode")).plugin).toEqual(["other"])
  })

  test("removes a versioned entry by package name", async () => {
    await using tmp = await tmpdir()
    await seed(tmp.path, "opencode", ["acme@1.2.3"])
    const out = await unpatchPluginConfig({ spec: "acme", worktree: tmp.path, directory: tmp.path }, deps())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.items.find((item) => item.kind === "server")?.mode).toBe("removed")
    expect((await read(tmp.path, "opencode")).plugin).toEqual([])
  })

  test("removes tuple entries with options", async () => {
    await using tmp = await tmpdir()
    await seed(tmp.path, "opencode", [["acme@1.2.3", { verbose: true }], "other"])
    const out = await unpatchPluginConfig({ spec: "acme", worktree: tmp.path, directory: tmp.path }, deps())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.items.find((item) => item.kind === "server")?.removed).toEqual(["acme@1.2.3"])
    expect((await read(tmp.path, "opencode")).plugin).toEqual(["other"])
  })

  test("removes from both server and tui configs", async () => {
    await using tmp = await tmpdir()
    await seed(tmp.path, "opencode", ["acme@1.2.3"])
    await seed(tmp.path, "tui", ["acme@1.2.3"])
    const out = await unpatchPluginConfig({ spec: "acme", worktree: tmp.path, directory: tmp.path }, deps())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.items.filter((item) => item.mode === "removed")).toHaveLength(2)
    expect((await read(tmp.path, "opencode")).plugin).toEqual([])
    expect((await read(tmp.path, "tui")).plugin).toEqual([])
  })

  test("reports noop when the spec is absent and leaves the file untouched", async () => {
    await using tmp = await tmpdir()
    const before = JSON.stringify({ plugin: ["other"] }, null, 2)
    await Bun.write(cfg(tmp.path, "opencode"), before)
    const out = await unpatchPluginConfig({ spec: "acme", worktree: tmp.path, directory: tmp.path }, deps())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.items.every((item) => item.mode === "noop")).toBe(true)
    expect(await Filesystem.readText(cfg(tmp.path, "opencode"))).toBe(before)
  })

  test("reports noop without creating files when configs are missing", async () => {
    await using tmp = await tmpdir()
    const out = await unpatchPluginConfig({ spec: "acme", worktree: tmp.path, directory: tmp.path }, deps())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.items.every((item) => item.mode === "noop")).toBe(true)
    expect(await Filesystem.exists(cfg(tmp.path, "opencode"))).toBe(false)
    expect(await Filesystem.exists(cfg(tmp.path, "tui"))).toBe(false)
  })

  test("does not remove unrelated file:// entries", async () => {
    await using tmp = await tmpdir()
    await seed(tmp.path, "opencode", ["file:///plugins/acme", "file:///plugins/other"])
    const out = await unpatchPluginConfig(
      { spec: "file:///plugins/acme", worktree: tmp.path, directory: tmp.path },
      deps(),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((await read(tmp.path, "opencode")).plugin).toEqual(["file:///plugins/other"])
  })

  test("returns invalid_json for a broken config", async () => {
    await using tmp = await tmpdir()
    await Bun.write(cfg(tmp.path, "opencode"), "{ plugin: [")
    const out = await unpatchPluginConfig({ spec: "acme", worktree: tmp.path, directory: tmp.path }, deps())
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe("invalid_json")
  })
})
