import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONNECTION_FILE_NAME, createConnectionFile, isConnectionFileEnabled } from "./connection-file"

const roots: string[] = []

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "opencode-connection-file-"))
  roots.push(root)
  return root
}

const info = { url: "http://127.0.0.1:51234", username: "opencode", password: "secret-password" }
const startedAt = new Date("2026-09-18T21:20:00.000Z")

function create(dir: string, options: { env?: Record<string, string | undefined>; pid?: number } = {}) {
  const logs: string[] = []
  const file = createConnectionFile({
    dir,
    appVersion: "1.2.3",
    env: options.env ?? {},
    pid: options.pid ?? 4242,
    now: () => startedAt,
    logger: {
      log: (message, meta) => logs.push(JSON.stringify({ message, meta })),
      warn: (message, meta) => logs.push(JSON.stringify({ message, meta })),
    },
  })
  return { file, logs }
}

const read = (dir: string) => JSON.parse(readFileSync(join(dir, CONNECTION_FILE_NAME), "utf8"))

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe("connection file", () => {
  test("writes the connection shape into the directory", () => {
    const dir = tempRoot()
    const { file } = create(dir)

    expect(file.write(info)).toBe(true)

    expect(file.path).toBe(join(dir, "server.json"))
    expect(read(dir)).toEqual({
      version: 1,
      url: info.url,
      username: "opencode",
      password: "secret-password",
      pid: 4242,
      appVersion: "1.2.3",
      startedAt: "2026-09-18T21:20:00.000Z",
    })
  })

  test("creates the directory when it is missing", () => {
    const dir = join(tempRoot(), "nested", "userData")
    const { file } = create(dir)

    expect(file.write(info)).toBe(true)
    expect(read(dir).url).toBe(info.url)
  })

  test("replaces the file atomically and leaves no temp files", () => {
    const dir = tempRoot()
    const { file } = create(dir)
    file.write(info)
    file.write({ ...info, url: "http://127.0.0.1:60000", password: "rotated" })

    expect(readdirSync(dir)).toEqual([CONNECTION_FILE_NAME])
    expect(read(dir)).toMatchObject({ url: "http://127.0.0.1:60000", password: "rotated" })
  })

  test("reports failure without throwing when the directory is unusable", () => {
    const dir = tempRoot()
    // A plain file where the directory should be makes the write fail.
    const { file } = create(dir)
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, "not a directory")

    expect(file.write(info)).toBe(false)
    rmSync(dir, { force: true })
  })

  test.skipIf(process.platform === "win32")("restricts the file to the owner on POSIX", () => {
    const dir = tempRoot()
    const { file } = create(dir)
    file.write(info)

    expect(statSync(join(dir, CONNECTION_FILE_NAME)).mode & 0o777).toBe(0o600)
  })

  test("never logs the password", () => {
    const dir = tempRoot()
    const { file, logs } = create(dir)
    file.write(info)
    file.remove()

    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join("\n")).not.toContain(info.password)
  })

  test("is disabled by OPENCODE_DESKTOP_CONNECTION_FILE=0", () => {
    const dir = tempRoot()
    const { file } = create(dir, { env: { OPENCODE_DESKTOP_CONNECTION_FILE: "0" } })

    expect(file.enabled).toBe(false)
    expect(file.write(info)).toBe(false)
    expect(existsSync(join(dir, CONNECTION_FILE_NAME))).toBe(false)
  })

  test("is enabled by default", () => {
    expect(isConnectionFileEnabled({})).toBe(true)
    expect(isConnectionFileEnabled({ OPENCODE_DESKTOP_CONNECTION_FILE: "1" })).toBe(true)
    expect(isConnectionFileEnabled({ OPENCODE_DESKTOP_CONNECTION_FILE: "0" })).toBe(false)
    expect(isConnectionFileEnabled({ OPENCODE_DESKTOP_CONNECTION_FILE: "false" })).toBe(false)
  })

  test("deletes the file when the server stops", () => {
    const dir = tempRoot()
    const { file } = create(dir)
    file.write(info)

    file.remove("sidecar stopped")

    expect(existsSync(join(dir, CONNECTION_FILE_NAME))).toBe(false)
    // Removing twice is harmless.
    file.remove("quit")
  })

  test("does not delete a file owned by another instance", () => {
    const dir = tempRoot()
    create(dir, { pid: 1111 }).file.write(info)

    create(dir, { pid: 2222 }).file.remove()

    expect(read(dir).pid).toBe(1111)
  })

  test("clears a stale file from a previous instance on startup", () => {
    const dir = tempRoot()
    create(dir, { pid: 1111 }).file.write(info)

    const { file } = create(dir, { pid: 2222 })
    file.clearStale()
    expect(existsSync(file.path)).toBe(false)

    file.write({ ...info, password: "fresh" })
    expect(read(dir)).toMatchObject({ pid: 2222, password: "fresh" })
  })

  test("clears an unreadable file on startup", () => {
    const dir = tempRoot()
    writeFileSync(join(dir, CONNECTION_FILE_NAME), "{not json")

    const { file } = create(dir)
    file.clearStale()

    expect(existsSync(file.path)).toBe(false)
  })
})
