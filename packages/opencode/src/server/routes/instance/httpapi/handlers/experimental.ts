import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { Todo } from "@/session/todo"
import { HostToken } from "@/server/host-token"
import type { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { ShellTasks } from "@/tool/shell/tasks"
import { Worktree } from "@/worktree"
import { Effect, Option, Scope } from "effect"
import { Provider } from "@/provider/provider"
import { SessionPrompt } from "@/session/prompt"
import { VerifierPin } from "@/session/verifier-pin"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  ConsoleSwitchPayload,
  type GoalStartPayload,
  SessionListQuery,
  ToolListQuery,
  WorktreeApiError,
} from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const tasks = yield* ShellTasks.Service
    const flags = yield* RuntimeFlags.Service
    const goals = yield* SessionGoal.Service
    const providers = yield* Provider.Service
    const promptSvc = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope
    const todos = yield* Todo.Service

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: flags.experimentalBackgroundSubagents }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    // The goal record (docs/accuracy-e.md §11.8). A session that does not exist,
    // and a goal that is not there, are both not found; too many changes, 429.
    const notFound = Effect.mapError(() => new HttpApiError.NotFound({}))
    const changeErrors = Effect.mapError((error: Session.NotFound | SessionGoal.RateLimited) =>
      error instanceof SessionGoal.RateLimited ? error : new HttpApiError.NotFound({}),
    )
    // Goal writes are the host's: they take the host token, which an agent's shell
    // does not have (it has at most the server password). Reads do not.
    const requireHost = (request: HttpServerRequest.HttpServerRequest) =>
      HostToken.verify(request.headers[HostToken.HEADER]) ? Effect.void : Effect.fail(new HttpApiError.Forbidden({}))
    // A verifier session is no worker: no goal on it, and no verifier of it (409).
    const requireWorker = Effect.fn("ExperimentalHttpApi.requireWorker")(function* (sessionID: SessionID) {
      const info = yield* sessions.get(sessionID).pipe(notFound)
      if (info.metadata?.verify !== undefined) return yield* new HttpApiError.Conflict({})
    })

    const sessionGoalStart = Effect.fn("ExperimentalHttpApi.sessionGoalStart")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: GoalStartPayload
      request: HttpServerRequest.HttpServerRequest
    }) {
      yield* requireHost(ctx.request)
      yield* requireWorker(ctx.params.sessionID)
      const { prompt, ...input } = ctx.payload
      // With a first prompt (§11.9): the goal is started first, recording the prompt as
      // the task, so the session holds a goal (and refuses client edits of its user
      // messages) before the message exists; then the prompt is sent, as prompt_async.
      const task = prompt?.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim()
      const started = yield* goals
        .start(ctx.params.sessionID, input, task ? { task } : undefined)
        .pipe(changeErrors)
      if (prompt)
        yield* promptSvc.prompt({ ...prompt, sessionID: ctx.params.sessionID }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("goal first prompt failed", { sessionID: ctx.params.sessionID, cause }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      return started
    })

    // Phase 4 (§11.9): the verifier session for the worker's active goal. Its verify is
    // read from the goal record here, never taken from the request, and its model is
    // pinned; Session.createVerifier writes both at birth, so it is sealed from the start.
    const sessionVerify = Effect.fn("ExperimentalHttpApi.sessionVerify")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      yield* requireHost(ctx.request)
      yield* requireWorker(ctx.params.sessionID)
      const goal = yield* goals.get(ctx.params.sessionID).pipe(notFound)
      if (!goal || goal.endedAt !== undefined) return yield* new HttpApiError.Conflict({})
      const pin = yield* VerifierPin.resolve.pipe(
        Effect.provideService(Agent.Service, agents),
        Effect.provideService(Provider.Service, providers),
      )
      if (!pin) return yield* new HttpApiError.ServiceUnavailable({})
      const child = yield* sessions.createVerifier({
        parentID: ctx.params.sessionID,
        verify: {
          goal: goal.id,
          ...(goal.base ? { base: goal.base } : {}),
          ...(goal.criteria ? { criteria: [...goal.criteria] } : {}),
        },
        pin,
      })
      return { verifierSessionID: child.id, pin }
    })
    const sessionGoal = Effect.fn("ExperimentalHttpApi.sessionGoal")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const goal = yield* goals.get(ctx.params.sessionID).pipe(notFound)
      if (!goal) return yield* new HttpApiError.NotFound({})
      return goal
    })
    const sessionGoalEnd = Effect.fn("ExperimentalHttpApi.sessionGoalEnd")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      yield* requireHost(ctx.request)
      const goal = yield* goals.end(ctx.params.sessionID).pipe(changeErrors)
      if (!goal) return yield* new HttpApiError.NotFound({})
      return goal
    })

    const sessionTodoEvidence = Effect.fn("ExperimentalHttpApi.sessionTodoEvidence")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* sessions.get(ctx.params.sessionID).pipe(notFound)
      return yield* todos.evidence(ctx.params.sessionID)
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!flags.experimentalBackgroundSubagents) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const shellTaskInfo = ShellTasks.clientInfo

    const shellTasks = Effect.fn("ExperimentalHttpApi.shellTasks")(function* (ctx: {
      query: { sessionID?: SessionID }
    }) {
      return (yield* tasks.list(ctx.query.sessionID)).map(shellTaskInfo)
    })

    const shellTasksStop = Effect.fn("ExperimentalHttpApi.shellTasksStop")(function* (ctx: {
      query: { sessionID?: SessionID }
    }) {
      const stopped = yield* tasks.stopAll(ctx.query.sessionID ? { sessionID: ctx.query.sessionID } : {})
      return stopped.map(shellTaskInfo)
    })

    const shellTaskStop = Effect.fn("ExperimentalHttpApi.shellTaskStop")(function* (ctx: {
      params: { taskID: string }
      query: { sessionID: SessionID }
    }) {
      const stopped = yield* tasks.stop(ctx.query.sessionID, ctx.params.taskID)
      if (!stopped) return yield* new HttpApiError.NotFound({})
      return shellTaskInfo(stopped)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("sessionGoalStart", sessionGoalStart)
      .handle("sessionVerify", sessionVerify)
      .handle("sessionGoal", sessionGoal)
      .handle("sessionGoalEnd", sessionGoalEnd)
      .handle("sessionTodoEvidence", sessionTodoEvidence)
      .handle("shellTasks", shellTasks)
      .handle("shellTasksStop", shellTasksStop)
      .handle("shellTaskStop", shellTaskStop)
      .handle("resource", resource)
  }),
)
