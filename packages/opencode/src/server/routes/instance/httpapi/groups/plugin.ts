import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const PluginItem = Schema.Struct({
  id: Schema.String,
  spec: Schema.String,
  source: Schema.String,
  scope: Schema.Union([Schema.Literal("global"), Schema.Literal("local")]),
  version: Schema.optional(Schema.String),
  loadCount: Schema.optional(Schema.Number),
  lastTime: Schema.optional(Schema.Number),
})

export const PluginListResponse = Schema.Struct({
  plugins: Schema.Array(PluginItem),
})

export const PluginInstallPayload = Schema.Struct({
  spec: Schema.String,
  global: Schema.optional(Schema.Boolean),
})

export const PluginInstallResponse = Schema.Struct({
  dir: Schema.String,
  server: Schema.Boolean,
  tui: Schema.Boolean,
})

export class PluginInstallError extends Schema.ErrorClass<PluginInstallError>("PluginInstallError")(
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export const PluginRemovePayload = Schema.Struct({
  spec: Schema.String,
  global: Schema.optional(Schema.Boolean),
})

export const PluginRemoveResponse = Schema.Struct({
  removed: Schema.Array(Schema.String),
})

export class PluginRemoveError extends Schema.ErrorClass<PluginRemoveError>("PluginRemoveError")(
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

const root = "/plugin"

export const PluginApi = HttpApi.make("plugin")
  .add(
    HttpApiGroup.make("plugin")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(PluginListResponse, "Installed plugins"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "plugin.list",
            summary: "List plugins",
            description: "List all configured plugins with their source, scope, and load metadata.",
          }),
        ),
        HttpApiEndpoint.post("install", root, {
          query: WorkspaceRoutingQuery,
          payload: described(PluginInstallPayload, "Plugin install request"),
          success: described(PluginInstallResponse, "Plugin installed successfully"),
          error: PluginInstallError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "plugin.install",
            summary: "Install plugin",
            description: "Install a plugin from an npm spec or local path and register it in config.",
          }),
        ),
        HttpApiEndpoint.post("remove", `${root}/remove`, {
          query: WorkspaceRoutingQuery,
          payload: described(PluginRemovePayload, "Plugin remove request"),
          success: described(PluginRemoveResponse, "Plugin removed successfully"),
          error: PluginRemoveError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "plugin.remove",
            summary: "Remove plugin",
            description: "Remove a plugin spec from config. The spec stays recoverable from plugin metadata.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "plugin",
          description: "Experimental HttpApi plugin routes.",
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
