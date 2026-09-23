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
  return (
    rulesets
      .flat()
      .findLast(
        (rule) =>
          Wildcard.match(permission, rule.permission) &&
          (Wildcard.match(pattern, rule.pattern) ||
            (rule.action === "deny" && Wildcard.match(pattern.toLowerCase(), rule.pattern.toLowerCase()))),
      ) ?? {
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
  return own.action === "deny" ? own : evaluate(permission, pattern, ruleset, approved)
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

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
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
 * goal loop. effective() appends it after every other rule.
 */
export const VERIFIER_LOCK = fromConfig({
  "*": "deny",
  // MCP resources are asked as read `mcp:<server>:<uri>`: not files in the workspace
  read: { "*": "allow", "mcp:*": "deny", "*.env": "deny", "*.env.*": "deny" },
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

/**
 * The ruleset a request is evaluated against: the agent's rules, then the
 * session's, then, for the verifier, its lock. Every evaluation of an agent's
 * rules goes through here (a test enforces it), so the lock is always last
 * and nothing from config or the session can loosen it.
 */
export function effective(
  agent: { name: string; native?: boolean; permission: PermissionV1.Ruleset },
  session: PermissionV1.Ruleset = [],
): PermissionV1.Rule[] {
  return merge(agent.permission ?? [], session, isVerifier(agent) ? VERIFIER_LOCK : [])
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
