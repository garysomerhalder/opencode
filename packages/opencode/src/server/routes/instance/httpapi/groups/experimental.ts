import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionGoal } from "@/session/goal"
import { Todo } from "@/session/todo"
import { VerifierPin } from "@/session/verifier-pin"
import { Worktree } from "@/worktree"
import { PromptPayload } from "./session"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ShellTaskEvent } from "@opencode-ai/schema/shell-task-event"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

// One shape for the list, the stops and the shell.task.updated event.
const ShellTaskInfo = ShellTaskEvent.Info

const ShellTaskList = Schema.Array(ShellTaskInfo).annotate({ identifier: "ShellTasks" })

export const ShellTaskStopQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: SessionID,
})

/**
 * Starting a goal, optionally with the session's first prompt (docs/accuracy-e.md §11.9):
 * one host step, so the task is recorded from the host's own prompt, with no window in
 * which the first message could be edited before the goal records it.
 */
export const GoalStartPayload = Schema.Struct({
  ...SessionGoal.Input.fields,
  prompt: Schema.optional(PromptPayload),
})
export type GoalStartPayload = Schema.Schema.Type<typeof GoalStartPayload>

export const VerifyStarted = Schema.Struct({
  verifierSessionID: SessionID,
  pin: VerifierPin.Pin,
})

export const ShellTaskQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.optional(SessionID),
})

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  sessionGoal: "/experimental/session/:sessionID/goal",
  sessionVerify: "/experimental/session/:sessionID/verify",
  sessionTodoEvidence: "/experimental/session/:sessionID/todo/evidence",
  shellTasks: "/experimental/shell/task",
  shellTasksStop: "/experimental/shell/task/stop",
  shellTaskStop: "/experimental/shell/task/:taskID/stop",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.post("sessionVerify", ExperimentalPaths.sessionVerify, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({}),
          success: described(VerifyStarted, "The verifier session, created pinned and sealed"),
          error: [HttpApiError.Forbidden, HttpApiError.NotFound, HttpApiError.Conflict, HttpApiError.ServiceUnavailable],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.verify",
            summary: "Start a verification of a session's goal",
            description:
              "Create the verifier session for the session's active goal: its verify (goal, base, criteria) is read from the goal record on the server, and the verifier's model is pinned. The session is sealed from birth. Requires the host token. 409 when no goal is active; 503 when the verifier's model cannot be resolved.",
          }),
        ),
        HttpApiEndpoint.post("sessionGoalStart", ExperimentalPaths.sessionGoal, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: GoalStartPayload,
          success: described(SessionGoal.Started, "The goal, and the snapshot it starts from"),
          error: [HttpApiError.NotFound, HttpApiError.Forbidden, SessionGoal.RateLimited],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.goal.start",
            summary: "Set or replace a session's goal",
            description:
              "Set the goal a goal loop drives the session with, replacing the active one. The server takes the snapshot the goal starts from (base is null when it could not) and appends the change to the goal's history. Requires the host token (x-opencode-host-token; 403 without it). At most 10 goal changes a minute per session (429 after that); the history keeps the latest 200 changes and counts the rest.",
          }),
        ),
        HttpApiEndpoint.get("sessionGoal", ExperimentalPaths.sessionGoal, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(SessionGoal.Record, "The session's goal record, active or ended"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.goal.get",
            summary: "Get a session's goal",
            description: "The session's goal record with its full change history. Not found when it has never had one.",
          }),
        ),
        HttpApiEndpoint.delete("sessionGoalEnd", ExperimentalPaths.sessionGoal, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(SessionGoal.Record, "The ended goal record"),
          error: [HttpApiError.NotFound, HttpApiError.Forbidden, SessionGoal.RateLimited],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.goal.end",
            summary: "End a session's goal",
            description:
              "End the session's active goal, keeping its record and appending the change to its history. Requires the host token (403 without it). Not found when no goal is active.",
          }),
        ),
        HttpApiEndpoint.get("sessionTodoEvidence", ExperimentalPaths.sessionTodoEvidence, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Todo.Evidence), "The session's verified todo items"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.todo.evidence",
            summary: "List verified todo items",
            description:
              "The session's todo items an independent verification found met, with the evidence that checked out. Read-only: only the verdict tool writes them.",
          }),
        ),
        HttpApiEndpoint.get("shellTasks", ExperimentalPaths.shellTasks, {
          query: ShellTaskQuery,
          success: described(ShellTaskList, "Background shell tasks"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.shellTask.list",
            summary: "List background shell tasks",
            description: "List the background shell tasks of this instance, or of one session when sessionID is given.",
          }),
        ),
        HttpApiEndpoint.post("shellTasksStop", ExperimentalPaths.shellTasksStop, {
          query: ShellTaskQuery,
          success: described(ShellTaskList, "Stopped background shell tasks"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.shellTask.stopAll",
            summary: "Stop background shell tasks",
            description:
              "Stop every running background shell task and kill its process tree, optionally limited to one session.",
          }),
        ),
        HttpApiEndpoint.post("shellTaskStop", ExperimentalPaths.shellTaskStop, {
          params: { taskID: Schema.String },
          query: ShellTaskStopQuery,
          success: described(ShellTaskInfo, "The stopped background shell task"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.shellTask.stop",
            summary: "Stop one background shell task",
            description:
              "Stop one background shell task of a session and kill its process tree. Stopping a task that already ended returns it unchanged. A task of another session is not found.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
