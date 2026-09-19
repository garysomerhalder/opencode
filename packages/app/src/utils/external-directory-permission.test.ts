import { describe, expect, test } from "bun:test"
import { mergeDeep } from "remeda"
import { externalDirectoryAction, externalDirectoryAsks, externalDirectoryPatch } from "./external-directory-permission"

describe("external directory permission setting", () => {
  test("defaults to asking when the config has no permission", () => {
    expect(externalDirectoryAsks(undefined)).toBe(true)
    expect(externalDirectoryAsks({})).toBe(true)
    expect(externalDirectoryAsks({ bash: "allow" })).toBe(true)
  })

  test("shows off for an existing hand-written allow rule", () => {
    expect(externalDirectoryAsks({ external_directory: "allow" })).toBe(false)
    expect(externalDirectoryAsks({ bash: "ask", external_directory: "allow", edit: "deny" })).toBe(false)
  })

  test("shows on for ask and deny, since only allow stops the prompt from blocking", () => {
    expect(externalDirectoryAsks({ external_directory: "ask" })).toBe(true)
    expect(externalDirectoryAction({ external_directory: "deny" })).toBe("deny")
    expect(externalDirectoryAsks({ external_directory: "deny" })).toBe(true)
  })

  test("follows catch-all rules with the server's last-match-wins order", () => {
    expect(externalDirectoryAsks("allow")).toBe(false)
    expect(externalDirectoryAsks("ask")).toBe(true)
    expect(externalDirectoryAsks({ "*": "allow" })).toBe(false)
    expect(externalDirectoryAsks({ "*": "allow", external_directory: "ask" })).toBe(true)
    expect(externalDirectoryAsks({ external_directory: "ask", "*": "allow" })).toBe(false)
    expect(externalDirectoryAsks({ "external_*": "allow" })).toBe(false)
    expect(externalDirectoryAsks({ "edit*": "allow" })).toBe(true)
  })

  test("reads the catch-all of a per-path rule object", () => {
    expect(externalDirectoryAsks({ external_directory: { "*": "allow", "/secret/*": "deny" } })).toBe(false)
    expect(externalDirectoryAsks({ external_directory: { "/tmp/*": "allow" } })).toBe(true)
  })

  test("maps the toggle to the config value", () => {
    expect(externalDirectoryPatch(undefined, false)).toEqual({ permission: { external_directory: "allow" } })
    expect(externalDirectoryPatch(undefined, true)).toEqual({ permission: { external_directory: "ask" } })
    expect(externalDirectoryPatch({ external_directory: "allow" }, true)).toEqual({
      permission: { external_directory: "ask" },
    })
  })

  test("patch only touches external_directory so other permission keys survive the server merge", () => {
    const existing = { bash: { "git *": "allow", "*": "ask" }, edit: "deny", external_directory: "ask" } as const
    const merged = mergeDeep({ permission: existing }, externalDirectoryPatch(existing, false))
    expect(merged.permission).toEqual({
      bash: { "git *": "allow", "*": "ask" },
      edit: "deny",
      external_directory: "allow",
    })
    expect(externalDirectoryAsks(merged.permission)).toBe(false)

    const back = mergeDeep(merged, externalDirectoryPatch(merged.permission, true))
    expect(back.permission).toEqual(existing)
    expect(externalDirectoryAsks(back.permission)).toBe(true)
  })

  test("keeps per-path rules and only changes their catch-all", () => {
    const existing = { external_directory: { "/secret/*": "deny" as const } }
    const merged = mergeDeep({ permission: existing }, externalDirectoryPatch(existing, false))
    expect(merged.permission).toEqual({ external_directory: { "/secret/*": "deny", "*": "allow" } })
    expect(externalDirectoryAsks(merged.permission)).toBe(false)
  })

  test("expands a bare string permission instead of dropping it", () => {
    const patch = externalDirectoryPatch("ask", false)
    expect(patch).toEqual({ permission: { "*": "ask", external_directory: "allow" } })
    expect(externalDirectoryAsks(patch.permission)).toBe(false)
    expect(externalDirectoryAction(patch.permission)).toBe("allow")
  })
})
