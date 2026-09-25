// The user's one-time approvals of proposed goal-loop check commands (accuracy E Phase 4,
// docs/accuracy-e.md §11.9, ruling 1). Check commands come from trusted config (user-level
// or managed). A command proposed any other way (by the worker, or pre-filled from the
// renderer's last input) runs only once the user approved it, for that project and that
// exact command. Stored host-side, in the app's own store, as hashes: a key is the
// project's resolved directory plus the command's sha256.
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type { KeyValueStore } from "./goal-loop-store"

const KEY = "goal-check-approvals"

function approvalKey(directory: string, command: string) {
  return createHash("sha256").update(`${resolve(directory)}\u0000${command}`).digest("hex")
}

function approvals(store: KeyValueStore): Record<string, number> {
  const value = store.get(KEY)
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, number>) : {}
}

/** Records the user's approval of `command` for the project at `directory`. */
export function approveCheck(store: KeyValueStore, directory: string, command: string, at = Date.now()) {
  store.set(KEY, { ...approvals(store), [approvalKey(directory, command)]: at })
}

/** Whether the user approved exactly `command` for the project at `directory`. */
export function isCheckApproved(store: KeyValueStore, directory: string, command: string) {
  return typeof approvals(store)[approvalKey(directory, command)] === "number"
}
