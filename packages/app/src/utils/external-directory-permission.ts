import type { Config } from "@opencode-ai/sdk/v2/client"

type Permission = Config["permission"]
type Action = "ask" | "allow" | "deny"

const KEY = "external_directory"

function matches(key: string) {
  if (key === KEY) return true
  if (!key.includes("*") && !key.includes("?")) return false
  const escaped = key
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`).test(KEY)
}

/**
 * The action the server applies to `external_directory` for any path, derived
 * from a config `permission` value. Mirrors the server's rule order: config keys
 * become rules in order and the last matching catch-all (`"*"` pattern) wins,
 * falling back to the built-in default of "ask".
 */
export function externalDirectoryAction(permission: Permission): Action {
  if (permission === undefined) return "ask"
  if (typeof permission === "string") return permission
  let result: Action = "ask"
  for (const [key, value] of Object.entries(permission)) {
    if (value === undefined || !matches(key)) continue
    if (typeof value === "string") {
      result = value
      continue
    }
    const wildcard = value["*"]
    if (wildcard) result = wildcard
  }
  return result
}

/** Toggle state: on means OpenCode asks before touching folders outside the project. */
export function externalDirectoryAsks(permission: Permission) {
  return externalDirectoryAction(permission) !== "allow"
}

/**
 * The global config patch for the toggle. The server deep-merges it into the
 * global config file, so only `external_directory` is sent and every other
 * permission key is left as-is. A bare string permission (e.g. `"ask"`) has no
 * keys to merge into, so it is expanded to its object form `{ "*": value }`
 * first. When `external_directory` already holds per-path rules, only its
 * catch-all `"*"` rule is set so the specific paths survive.
 */
export function externalDirectoryPatch(permission: Permission, ask: boolean): Config {
  const action: Action = ask ? "ask" : "allow"
  if (typeof permission === "string") return { permission: { "*": permission, [KEY]: action } }
  const current = permission?.[KEY]
  if (current && typeof current === "object") return { permission: { [KEY]: { ...current, "*": action } } }
  return { permission: { [KEY]: action } }
}
