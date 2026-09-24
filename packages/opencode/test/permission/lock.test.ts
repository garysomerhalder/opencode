// The verifier's lock as evaluate() and disabled() apply it: it only takes away,
// the divider between the rules and the lock cannot be faked, and nothing after
// the lock is read as part of it. Security review of fix/verifier-lock-denies.
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Exit, Schema } from "effect"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Permission } from "../../src/permission"
import { Truncate } from "../../src/tool/truncate"

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform })
})
/** Wildcard.match folds case for every rule on Windows only; run the rule as each platform would. */
const on = (name: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: name })

const verifier = (rules: Parameters<typeof Permission.fromConfig>[0]) => ({
  name: Permission.VERIFIER,
  native: true,
  permission: Permission.agentRules(Permission.fromConfig(rules)),
})
const build = (rules: Parameters<typeof Permission.fromConfig>[0]) => ({
  name: "build",
  native: true,
  permission: Permission.agentRules(Permission.fromConfig(rules)),
})
const user = { "*": "allow", read: { "*": "allow", "secrets/*": "ask" } } as const

describe("an ask before the lock is a deny, matched like one", () => {
  for (const name of ["darwin", "linux", "win32"] as const)
    test(`${name}: a user's ask on secrets/* holds for the verifier whatever the case of the path`, () => {
      on(name)
      const rules = Permission.effective(verifier(user))
      for (const file of ["secrets/key.txt", "SECRETS/key.txt", "Secrets/KEY.txt"])
        expect([file, Permission.evaluate("read", file, rules).action]).toEqual([file, "deny"])
      expect(Permission.evaluate("read", "src/app.ts", rules).action).toBe("allow")
    })

  test("for any other agent an ask stays an ask, with the platform's case matching", () => {
    on("darwin")
    const rules = Permission.effective(build(user))
    expect(Permission.evaluate("read", "secrets/key.txt", rules).action).toBe("ask")
    expect(Permission.evaluate("read", "SECRETS/key.txt", rules).action).toBe("allow")
    on("win32")
    expect(Permission.evaluate("read", "SECRETS/key.txt", rules).action).toBe("ask")
  })
})

describe("the divider cannot be faked", () => {
  test("fromConfig refuses the divider's name as a permission key", () => {
    expect(() => Permission.fromConfig({ "<verifier-lock>": "deny" })).toThrow("reserved")
    expect(() => Permission.fromConfig({ "<verifier-lock>": { "*": "allow" } })).toThrow("reserved")
  })

  test("a rule named like the divider is an ordinary rule: a later session deny still holds", () => {
    const fake = { permission: "<verifier-lock>", pattern: "*", action: "deny" } as const
    const planted = {
      name: Permission.VERIFIER,
      native: true,
      permission: Permission.agentRules([...Permission.fromConfig({ "*": "allow" }), fake]),
    }
    const session = Permission.fromConfig({ read: { "secrets/*": "deny" } })
    expect(Permission.evaluate("read", "secrets/key.txt", Permission.effective(planted, session)).action).toBe("deny")
    // and for an agent without the lock it changes nothing
    const other = { ...planted, name: "build" }
    const asks = Permission.fromConfig({ read: { "secrets/*": "ask" } })
    expect(Permission.evaluate("read", "secrets/key.txt", Permission.effective(other, asks)).action).toBe("ask")
    expect(Permission.disabled(["read"], Permission.effective(other, asks))).toEqual(new Set())
  })

  test("the divider is recognized by identity: a copy of it is not the divider", () => {
    const rules = Permission.effective(verifier({ "*": "allow" }))
    const copied = JSON.parse(JSON.stringify(rules)) as typeof rules
    // the copy is evaluated as plain last-match rules, and a later allow wins there,
    // but the real ruleset keeps the lock
    expect(Permission.evaluate("edit", "src/app.ts", rules).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/app.ts", [...copied, ...Permission.fromConfig({ edit: "allow" })]).action).toBe(
      "allow",
    )
  })
})

describe("nothing after the lock is read as part of it", () => {
  test("rules evaluated after the lock (such as approvals) count as rules before it", () => {
    const rules = Permission.effective(verifier({ "*": "allow" }))
    expect(Permission.evaluate("edit", "src/app.ts", rules, Permission.fromConfig({ edit: "allow" })).action).toBe(
      "deny",
    )
    expect(Permission.evaluate("bash", "ls", rules, Permission.fromConfig({ bash: "allow" })).action).toBe("deny")
    expect(
      Permission.evaluate("read", "notes.md", rules, Permission.fromConfig({ read: { "notes.md": "deny" } })).action,
    ).toBe("deny")
    expect(
      Permission.evaluate("read", "notes.md", rules, Permission.fromConfig({ read: { "notes.md": "ask" } })).action,
    ).toBe("deny")
    expect(Permission.evaluate("read", "src/app.ts", rules, Permission.fromConfig({ grep: "deny" })).action).toBe(
      "allow",
    )
  })
})

describe("disabled(): what the verifier is not offered", () => {
  test("a tool the user asks about for every pattern is hidden from the verifier, not from build", () => {
    const rules = { "*": "allow", grep: "ask" } as const
    expect(Permission.disabled(["grep", "read"], Permission.effective(verifier(rules)))).toEqual(new Set(["grep"]))
    expect(Permission.disabled(["grep", "read"], Permission.effective(build(rules)))).toEqual(new Set())
  })
})

// Security re-review, 2: rules after the lock are a side of their own under
// "stricter decides": they can take away, never give.
describe("rules after the lock never loosen the rules before it", () => {
  test("an allow after the lock does not lift a user's deny", () => {
    const rules = Permission.effective(verifier({ "*": "allow", read: { "*": "allow", "secrets/*": "deny" } }))
    const lifted = Permission.fromConfig({ read: { "secrets/*": "allow" } })
    expect(Permission.evaluate("read", "secrets/key.txt", rules, lifted).action).toBe("deny")
    expect(Permission.evaluate("read", "src/app.ts", rules, lifted).action).toBe("allow")
  })
})

// Security re-review, 4: a session id is only ses_ and letters and digits, so one
// cannot widen or move the verifier's archive directory.
describe("session ids", () => {
  test("the schema refuses wildcards, dots, slashes and spaces", () => {
    const decode = Schema.decodeUnknownExit(SessionID)
    for (const id of ["ses_0A1b2C", "ses_code-mode", "session_test"])
      expect([id, Exit.isSuccess(decode(id))]).toEqual([id, true])
    for (const id of ["ses*", "ses_*", "ses?", "ses/../..", "ses_a/../../b", "ses\\a", "ses.a", "ses a", "abc"])
      expect([id, Exit.isSuccess(decode(id))]).toEqual([id, false])
  })

  test("the archive directory and the verifier's archive rules refuse a bad id", () => {
    expect(() => Truncate.sessionDir("ses/../..")).toThrow()
    expect(() => Truncate.sessionDir("ses*")).toThrow()
    const own = (id: string) =>
      Permission.evaluate(
        "external_directory",
        path.join(Truncate.DIR, "ses_other", "*"),
        Permission.effective(verifier({ "*": "allow" }), [], id),
      ).action
    expect(own("ses*")).toBe("deny")
    expect(own("ses_other")).toBe("allow")
  })
})
