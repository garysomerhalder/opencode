// The host token (docs/accuracy-e.md §11.8, security review of Phase 3): a secret
// generated once per server process and held only in its memory. It is never put
// in the environment (shells the server spawns inherit that) or on disk. The
// server hands it to the process that started it: Server.listen returns it, and
// the desktop sidecar posts it to the Electron main process over the utility
// process's private channel. The routes that write a session's goal require it,
// so an agent's shell, which has at most the server password, cannot call them.
import { randomBytes, timingSafeEqual } from "crypto"

export const HEADER = "x-opencode-host-token"

let token: string | undefined

/** The process's token, generated on first use. */
export function issue() {
  token ??= randomBytes(32).toString("base64url")
  return token
}

/** Whether `given` is the process's token. False before one was issued. */
export function verify(given: string | undefined) {
  if (token === undefined || given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export * as HostToken from "./host-token"
