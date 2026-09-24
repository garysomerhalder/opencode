import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import path from "path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { EventV2Bridge } from "@/event-v2-bridge"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  /**
   * What ask() would do, without asking: "deny" when any pattern is denied,
   * "ask" when any would need an answer, else "allow". For tools that return
   * many paths or file contents and must leave out what the agent may not read.
   */
  readonly check: (input: {
    permission: string
    patterns: ReadonlyArray<string>
    ruleset: PermissionV1.Ruleset
  }) => Effect.Effect<PermissionV1.Action>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

/**
 * The last rule matching the request. A deny matches its pattern ignoring
 * case on every platform: file systems that ignore case (APFS, NTFS) open
 * `prod.ENV` for `*.env`, and a deny should never be narrower than the file
 * system. Allow and ask keep the platform's matching.
 */
export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  const rules = rulesets.flat()
  const locked = split(rules)
  if (!locked) return last(permission, pattern, rules)
  // A locked ruleset (effective() for the verifier): the lock only takes away.
  // The stricter of the other rules and the lock decides. Nobody answers inside
  // a goal loop, so an ask among the other rules is a deny, and is matched as
  // one (ignoring case), before any matching: an ask that would miss `SECRETS/`
  // on a case-sensitive match must not become an allow.
  const other = last(permission, pattern, locked.other)
  const lock = last(permission, pattern, VERIFIER_LOCK)
  if (other.action !== "allow") return { ...other, action: "deny" }
  if (lock.action !== "allow") return { ...lock, action: "deny" }
  // rules after the lock (a caller's extra ruleset, such as approvals) are a side
  // of their own: a deny or an ask there denies, an allow never lifts anything
  const extra = locked.after.findLast((rule) => matches(rule, permission, pattern))
  if (extra && extra.action !== "allow") return { ...extra, action: "deny" }
  return lock
}

/**
 * For a ruleset from effective() for the verifier: the rules other than the lock,
 * with every ask as a deny. The divider is found by identity (the frozen
 * LOCK_MARK, the last one), so a rule that only carries its name, from config or
 * a session, is an ordinary rule. The lock is always VERIFIER_LOCK itself; rules
 * after its slice (approvals, a caller's extra ruleset) are returned as `after`,
 * a side of their own that can take away but never give, with every ask as a
 * deny too. Undefined for any other ruleset.
 */
function split(rules: PermissionV1.Ruleset) {
  const mark = rules.findLastIndex((rule) => rule === LOCK_MARK)
  if (mark === -1) return undefined
  const asDeny = (rule: PermissionV1.Rule): PermissionV1.Rule => (rule.action === "ask" ? { ...rule, action: "deny" } : rule)
  return {
    other: rules.slice(0, mark).map(asDeny),
    after: rules.slice(mark + 1 + VERIFIER_LOCK.length).map(asDeny),
  }
}

function matches(rule: PermissionV1.Rule, permission: string, pattern: string) {
  return (
    Wildcard.match(permission, rule.permission) &&
    (Wildcard.match(pattern, rule.pattern) ||
      (rule.action === "deny" && Wildcard.match(pattern.toLowerCase(), rule.pattern.toLowerCase())))
  )
}

function last(permission: string, pattern: string, rules: PermissionV1.Ruleset): PermissionV1.Rule {
  return (
    rules.findLast((rule) => matches(rule, permission, pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

/**
 * The rule that decides a request. An explicit deny in the ruleset is final;
 * "always" approvals only lift an ask. Approvals are shared by every session
 * of the directory, and a denied pattern is never asked about, so an approval
 * that reaches a deny was given under another agent.
 */
function decide(
  permission: string,
  pattern: string,
  ruleset: PermissionV1.Ruleset,
  approved: PermissionV1.Ruleset,
): PermissionV1.Rule {
  const own = evaluate(permission, pattern, ruleset)
  return own.action === "ask" ? evaluate(permission, pattern, ruleset, approved) : own
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const check = Effect.fn("Permission.check")(function* (input: {
      permission: string
      patterns: ReadonlyArray<string>
      ruleset: PermissionV1.Ruleset
    }) {
      const { approved } = yield* InstanceState.get(state)
      const actions = input.patterns.map((pattern) => decide(input.permission, pattern, input.ruleset, approved).action)
      if (actions.includes("deny")) return "deny" as const
      if (actions.includes("ask")) return "ask" as const
      return "allow" as const
    })

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = decide(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list, check })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

/**
 * The divider's permission name (see LOCK_MARK). No tool or request uses it, and
 * config and session rules may not: fromConfig() throws, and the session API
 * refuses a ruleset that names it (reserved()).
 */
export const LOCK_NAME = "<verifier-lock>"

/** Why a ruleset from outside (config, a client) may not be used, or undefined. */
export function reserved(ruleset: PermissionV1.Ruleset) {
  return ruleset.some((rule) => rule.permission === LOCK_NAME)
    ? `the permission name "${LOCK_NAME}" is reserved`
    : undefined
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (key === LOCK_NAME) throw new Error(`permission: the key "${LOCK_NAME}" is reserved`)
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

/** The built-in read-only verifier (accuracy E, docs/accuracy-e.md). */
export const VERIFIER = "verifier"

/**
 * The verifier's fixed ruleset: reads and lookups, the verdict tool, archived
 * tool output, nothing else. Nothing is `ask`, since nobody answers inside a
 * goal loop. effective() appends it after every other rule, behind a mark, and
 * the stricter of it and those rules decides: it takes away, never gives.
 */
export const VERIFIER_LOCK = fromConfig({
  "*": "deny",
  // MCP resources are asked as read `mcp:<server>:<uri>`: not files in the workspace.
  // .env.example holds no secrets and is allowed, as in the default rules; the read
  // rules also match the file opened, so a name ending in it cannot open .env.
  read: { "*": "allow", "mcp:*": "deny", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
  grep: "allow",
  glob: "allow",
  lsp: "allow",
  verdict: "allow",
  external_directory: { "*": "deny", [path.join(TRUNCATION_DIR, "*")]: "allow" },
})

/**
 * The built-in verifier, by identity: a native agent (config cannot make one)
 * under the name the agent service reserves for it. agent.ts keeps config from
 * renaming it or giving another agent its name.
 */
export function isVerifier(agent: { name: string; native?: boolean }) {
  return agent.native === true && agent.name === VERIFIER
}

declare const agentRulesBrand: unique symbol

/**
 * An agent's own rules (Agent.Info.permission), opaque to the compiler: they can
 * be built with agentRules(), and read only through effective(), which appends
 * the session's rules and, for the verifier, its lock. At run time the value is
 * the plain array, so the API and the SDK see the same shape as before.
 */
export type AgentRules = { readonly [agentRulesBrand]: "AgentRules" }

/** Wraps rules as an agent's own. agent.ts builds agents with it. */
export function agentRules(rules: PermissionV1.Ruleset): AgentRules {
  return rules as unknown as AgentRules
}

/**
 * Separates the other rules from the verifier's lock in an effective ruleset.
 * evaluate() and disabled() find it by identity (this frozen object), never by
 * name, and take the stricter of the two sides, so the lock only ever takes
 * away: its allows (read, grep, ...) cannot lift a deny or an ask from the
 * user's config or the session.
 */
const LOCK_MARK: PermissionV1.Rule = Object.freeze({ permission: LOCK_NAME, pattern: "*", action: "deny" })

/**
 * The ruleset a request is evaluated against: the agent's rules, then the
 * session's, then, for the verifier, its lock. It is the only way to read an
 * agent's rules (AgentRules is opaque everywhere else, and the compiler
 * enforces it). The lock comes after a mark, so it is always applied and
 * nothing from config or the session can loosen it, and it cannot loosen them.
 */
export function effective(
  agent: { name: string; native?: boolean; permission: AgentRules },
  session: PermissionV1.Ruleset = [],
  sessionID?: string,
): PermissionV1.Rule[] {
  const own = agent.permission as unknown as PermissionV1.Ruleset | undefined
  if (!isVerifier(agent)) return merge(own ?? [], session)
  return merge(own ?? [], session, archiveScope(sessionID), [LOCK_MARK, ...VERIFIER_LOCK])
}

/**
 * The archive of cut tool output is shared by every session and project for 7
 * days. The verifier reaches only its own session's directory in it (see
 * Truncate.sessionDir), and none of it when the caller does not say which
 * session it runs in.
 */
/** A session id as the schema accepts it (SessionID): no wildcard, dot, slash or space. */
export const SESSION_ID = /^ses[A-Za-z0-9_-]*$/

function archiveScope(sessionID: string | undefined): PermissionV1.Rule[] {
  return [
    { permission: "external_directory", pattern: path.join(TRUNCATION_DIR, "*"), action: "deny" },
    // only a well-formed id: a wildcard or a path in it would widen or move the directory
    ...(sessionID && SESSION_ID.test(sessionID)
      ? [{ permission: "external_directory", pattern: path.join(TRUNCATION_DIR, sessionID, "*"), action: "allow" as const }]
      : []),
  ]
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  // for the verifier, the other rules (an ask counts as a deny) and the lock
  const locked = split(ruleset)
  const sides = locked ? [locked.other, VERIFIER_LOCK, locked.after] : [ruleset]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      // hidden when either side's last rule for the tool denies all of it
      return sides.some((side) => {
        const rule = side.findLast((rule) => Wildcard.match(permission, rule.permission))
        return rule?.pattern === "*" && rule.action === "deny"
      })
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
