import path from "path"
import { realpathSync } from "fs"
import { FSUtil } from "@opencode-ai/core/fs-util"

/**
 * The file the system opens for a path, on every platform: symbolic links and
 * junctions resolved (for a path that does not exist yet, its nearest existing
 * parent), and on Windows a `name:stream` suffix removed, since `.env::$DATA`
 * opens `.env`. Permission checks compare these, never paths as written.
 */
export function resolve(file: string): string {
  const target = path.resolve(process.platform === "win32" ? FSUtil.windowsPath(file) : file)
  const base = path.basename(target)
  const colon = process.platform === "win32" ? base.indexOf(":") : -1
  const plain = colon > 0 ? path.join(path.dirname(target), base.slice(0, colon)) : target
  try {
    return realpathSync.native(plain)
  } catch {
    const parent = path.dirname(plain)
    if (parent === plain) return plain
    return path.join(resolve(parent), path.basename(plain))
  }
}

export * as CanonicalPath from "./canonical-path"
