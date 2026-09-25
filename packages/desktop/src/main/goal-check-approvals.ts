// The user's one-time approvals of proposed goal-loop check commands (accuracy E Phase 4,
// docs/accuracy-e.md §11.9, ruling 1). Check commands come from trusted config (user-level
// or managed). A command proposed any other way (by the worker, or pre-filled from the
// renderer's last input) runs only once the user approved it, for that project and that
// exact command.
//
// Stored host-side, in the app's own store, as HMAC-SHA256(key, directory ‖ command). The
// key is generated once and kept sealed with Electron safeStorage (DPAPI, Keychain,
// libsecret), never in plain text. A process that can write the store but has no key
// cannot compute a valid entry, so a hand-written one is never honored. This raises the
// bar only: a same-user process can call the same OS store; the real boundary is the
// worker sandbox (§11.8).
import { createHmac, randomBytes } from "node:crypto"
import { resolve } from "node:path"
import type { KeyValueStore } from "./goal-loop-store"

const APPROVALS = "goal-check-approvals"
const SEALED_KEY = "goal-check-approval-key"

/** The part of Electron safeStorage this needs. */
export type Sealer = {
  isEncryptionAvailable: () => boolean
  encryptString: (text: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

/**
 * The approval key: generated once, stored sealed. Undefined when the OS offers no
 * encryption (or the sealed key cannot be opened): then no proposal is approved.
 */
export function loadApprovalKey(store: KeyValueStore, sealer: Sealer): Buffer | undefined {
  if (!sealer.isEncryptionAvailable()) return undefined
  const sealed = store.get(SEALED_KEY)
  if (typeof sealed === "string") {
    try {
      const key = Buffer.from(sealer.decryptString(Buffer.from(sealed, "base64")), "hex")
      return key.length === 32 ? key : undefined
    } catch {
      return undefined
    }
  }
  const key = randomBytes(32)
  store.set(SEALED_KEY, sealer.encryptString(key.toString("hex")).toString("base64"))
  return key
}

function entry(key: Buffer, directory: string, command: string) {
  return createHmac("sha256", key).update(`${resolve(directory)}\u0000${command}`).digest("hex")
}

function approvals(store: KeyValueStore): Record<string, number> {
  const value = store.get(APPROVALS)
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, number>) : {}
}

/** Records the user's approval of `command` for the project at `directory`. */
export function approveCheck(store: KeyValueStore, key: Buffer, directory: string, command: string, at = Date.now()) {
  store.set(APPROVALS, { ...approvals(store), [entry(key, directory, command)]: at })
}

/** Whether the user approved exactly `command` for the project at `directory` (a valid keyed entry). */
export function isCheckApproved(store: KeyValueStore, key: Buffer, directory: string, command: string) {
  return typeof approvals(store)[entry(key, directory, command)] === "number"
}
