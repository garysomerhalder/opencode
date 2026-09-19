import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Discovery file for local tools (CLI scripts, other agents) that want to talk to the
// Desktop app's embedded server over its normal HTTP API. It lives in the app's
// userData directory and holds the loopback URL plus the Basic-auth credentials.
//
// Permissions: on POSIX the file is created with mode 0o600 (owner read/write only).
// On Windows `mode` is ignored; the file inherits the ACL of userData, which lives under
// %APPDATA% (the user's roaming profile) and is already restricted to the current user,
// SYSTEM and Administrators. Do not loosen that ACL or move the file somewhere shared.
//
// This module must stay free of `electron` imports so it can be unit tested with bun.

export const CONNECTION_FILE_NAME = "server.json"
export const CONNECTION_FILE_ENV = "OPENCODE_DESKTOP_CONNECTION_FILE"

export type ConnectionInfo = {
  url: string
  username: string
  password: string
}

export type ConnectionFileContent = ConnectionInfo & {
  version: 1
  pid: number
  appVersion: string
  startedAt: string
}

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export type ConnectionFileOptions = {
  dir: string
  appVersion: string
  env?: Record<string, string | undefined>
  pid?: number
  now?: () => Date
  logger?: Logger
}

export function isConnectionFileEnabled(env: Record<string, string | undefined> = process.env) {
  const value = env[CONNECTION_FILE_ENV]?.trim().toLowerCase()
  return value !== "0" && value !== "false"
}

export function createConnectionFile(options: ConnectionFileOptions) {
  const path = join(options.dir, CONNECTION_FILE_NAME)
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => new Date())
  const enabled = isConnectionFileEnabled(options.env ?? process.env)

  const readOwner = (): number | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }
      return typeof parsed.pid === "number" ? parsed.pid : undefined
    } catch {
      return undefined
    }
  }

  const unlink = (reason: string) => {
    try {
      rmSync(path, { force: true })
      options.logger?.log("connection file removed", { path, reason })
    } catch (error) {
      options.logger?.warn("failed to remove connection file", { path, reason, error: message(error) })
    }
  }

  return {
    path,
    enabled,

    /**
     * Remove a file left behind by a previous instance (crash, hard kill, dev hot reload).
     * Only call this after the single-instance lock is held, so no live owner can exist.
     */
    clearStale() {
      if (!enabled) return
      const owner = readOwner()
      if (owner === pid) return
      unlink("stale")
    },

    /** Atomically (re)write the file with the current server credentials. */
    write(info: ConnectionInfo) {
      if (!enabled) return false
      const content: ConnectionFileContent = {
        version: 1,
        url: info.url,
        username: info.username,
        password: info.password,
        pid,
        appVersion: options.appVersion,
        startedAt: now().toISOString(),
      }
      const temp = join(options.dir, `.${CONNECTION_FILE_NAME}.${pid}.${randomBytes(4).toString("hex")}.tmp`)
      try {
        mkdirSync(options.dir, { recursive: true })
        // "wx": fail if the temp name somehow exists, so we never write through a pre-planted file.
        writeFileSync(temp, JSON.stringify(content, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" })
        replace(temp, path)
        options.logger?.log("connection file written", { path, url: info.url })
        return true
      } catch (error) {
        rmSync(temp, { force: true })
        options.logger?.warn("failed to write connection file", { path, error: message(error) })
        return false
      }
    },

    /** Remove the file if this process owns it. Synchronous so it is safe during quit. */
    remove(reason = "stopped") {
      if (!enabled) return
      const owner = readOwner()
      if (owner !== undefined && owner !== pid) return
      unlink(reason)
    },
  }
}

export type ConnectionFile = ReturnType<typeof createConnectionFile>

function replace(temp: string, target: string) {
  try {
    renameSync(temp, target)
  } catch (error) {
    // On Windows a rename over a file another process has open can fail with EPERM/EBUSY.
    // Retry once after removing the target; the window where it is missing is tiny.
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error
    rmSync(target, { force: true })
    renameSync(temp, target)
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
