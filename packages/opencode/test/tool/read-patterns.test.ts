// Security review of the verifier lock, finding 6: the read rules are matched
// against the file the system opens, on every platform.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Permission } from "../../src/permission"
import { Tool } from "../../src/tool/tool"
import { containsPath, type InstanceContext } from "../../src/project/instance-context"

let root = ""
let workspace = ""
let outside = ""

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "read-patterns-")))
  workspace = path.join(root, "workspace")
  outside = path.join(root, "outside")
  fs.mkdirSync(workspace)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(workspace, ".env"), "API_KEY=1\n")
  fs.writeFileSync(path.join(outside, "id_rsa"), "KEY\n")
  fs.symlinkSync(path.join(workspace, ".env"), path.join(workspace, "notes.txt"), "file")
  fs.symlinkSync(outside, path.join(workspace, "vendor"), "junction")
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("Tool.readPatterns and Tool.canonicalPath", () => {
  test("a file link is matched as the file it opens, and as named", () => {
    expect(Tool.readPatterns(workspace, path.join(workspace, "notes.txt")).toSorted()).toEqual([".env", "notes.txt"])
    expect(Tool.absolutePaths(path.join(workspace, "notes.txt")).toSorted()).toEqual(
      [path.join(workspace, ".env"), path.join(workspace, "notes.txt")].toSorted(),
    )
    expect(Tool.canonicalPath(path.join(workspace, "notes.txt"))).toBe(path.join(workspace, ".env"))
  })

  test("a directory link resolves to where it leads, for a file that does not exist yet too", () => {
    expect(Tool.canonicalPath(path.join(workspace, "vendor", "id_rsa"))).toBe(path.join(outside, "id_rsa"))
    expect(Tool.canonicalPath(path.join(workspace, "vendor", "new.txt"))).toBe(path.join(outside, "new.txt"))
    expect(Tool.readPatterns(workspace, path.join(workspace, "vendor", "id_rsa"))).toContain(
      path.join("..", "outside", "id_rsa"),
    )
  })

  test.skipIf(process.platform !== "win32")("an NTFS stream name is matched as the file it opens", () => {
    expect(Tool.readPatterns(workspace, path.join(workspace, ".env::$DATA"))).toContain(".env")
    expect(Tool.canonicalPath(path.join(workspace, ".env:hidden"))).toBe(path.join(workspace, ".env"))
  })
})

// Re-review, item 3: a workspace opened through a link (macOS /tmp is /private/tmp)
// contains the files the system resolves under it.
describe("containsPath resolves the workspace as well as the file", () => {
  test("a file under the workspace's real directory is inside it", () => {
    const linked = { directory: path.join(workspace, "vendor"), worktree: path.join(workspace, "vendor") } as InstanceContext
    expect(containsPath(path.join(outside, "id_rsa"), linked)).toBe(true)
    expect(containsPath(path.join(workspace, "vendor", "id_rsa"), linked)).toBe(true)
    expect(containsPath(path.join(workspace, ".env"), linked)).toBe(false)
  })
})

describe("Permission.evaluate: a deny ignores case", () => {
  const rules = Permission.fromConfig({ read: { "*": "allow", "*.env": "deny", "*.env.example": "allow" } })

  test("prod.ENV is denied by *.env on every platform", () => {
    expect(Permission.evaluate("read", "prod.ENV", rules).action).toBe("deny")
    expect(Permission.evaluate("read", "config/.Env", rules).action).toBe("deny")
  })

  test("a deny never widens to what a later allow names in the same case", () => {
    expect(Permission.evaluate("read", "app.env.example", rules).action).toBe("allow")
    expect(Permission.evaluate("read", "src/app.ts", rules).action).toBe("allow")
  })
})
