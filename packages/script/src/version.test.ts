import { describe, expect, test } from "bun:test"
import semver from "semver"
import { isPreviewVersion, previewVersion } from "./version"

const now = new Date("2026-09-23T06:15:42.000Z")

describe("previewVersion", () => {
  test("a dev build carries the package version with a -dev prerelease suffix", () => {
    expect(previewVersion({ base: "1.18.30", channel: "dev", now })).toBe("1.18.30-dev.202609230615")
  })

  test("it is valid semver and satisfies a minimum-version check on the base version's line", () => {
    const version = previewVersion({ base: "1.18.30", channel: "dev", now })
    expect(semver.valid(version)).toBe(version)
    // "OpenCode 1.18.0 or newer is required": a 0.0.0-dev-* build failed this
    expect(semver.gte(version, "1.18.0")).toBe(true)
    expect(semver.gte("0.0.0-dev-202609230615", "1.18.0")).toBe(false)
  })

  test("a branch name with slashes or other characters still gives valid semver", () => {
    const version = previewVersion({ base: "1.18.30", channel: "feat/goal loop_2", now })
    expect(version).toBe("1.18.30-feat-goal-loop-2.202609230615")
    expect(semver.valid(version)).toBe(version)
  })

  test("an empty channel falls back to dev", () => {
    expect(previewVersion({ base: "1.18.30", channel: "", now })).toBe("1.18.30-dev.202609230615")
  })
})

describe("isPreviewVersion", () => {
  test("a prerelease is a preview, a release is not", () => {
    expect(isPreviewVersion("0.0.0-dev-202609230615")).toBe(true)
    expect(isPreviewVersion("1.18.30-dev.202609230615")).toBe(true)
    expect(isPreviewVersion("1.18.30")).toBe(false)
  })
})
