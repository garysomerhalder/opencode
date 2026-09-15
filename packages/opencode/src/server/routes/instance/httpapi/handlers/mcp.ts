import { MCP } from "@/mcp"
import { addMcpEntry, removeMcpEntry, resolveConfigFile } from "@/mcp/config-file"
import * as InstanceState from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { McpServerNotFoundError } from "../errors"
import {
  AddPayload,
  AuthCallbackPayload,
  InstallPayload,
  McpInstallError,
  McpRemoveError,
  RemovePayload,
  StatusMap,
  UnsupportedOAuthError,
} from "../groups/mcp"

export const mcpHandlers = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* mcp.status()
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      const result = (yield* mcp.add(ctx.payload.name, ctx.payload.config)).status
      return yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [ctx.payload.name]: result } : result,
      ).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const install = Effect.fn("McpHttpApi.install")(function* (ctx: {
      payload: typeof InstallPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const name = ctx.payload.name.trim()
      if (!name) {
        return yield* Effect.fail(new McpInstallError({ message: "MCP server name is required" }))
      }

      const file = yield* Effect.promise(() =>
        resolveConfigFile({
          global: ctx.payload.global,
          vcs: instance.project.vcs,
          worktree: instance.worktree,
          directory: instance.directory,
        }),
      )
      const patched = yield* Effect.promise(() => addMcpEntry(file, name, ctx.payload.config))
      if (!patched.ok) {
        return yield* Effect.fail(
          new McpInstallError({
            message:
              patched.code === "invalid_json"
                ? `Invalid JSON in ${patched.file} (${patched.parse} at line ${patched.line}, column ${patched.col})`
                : errorMessage(patched.error),
          }),
        )
      }

      const result = (yield* mcp.add(name, ctx.payload.config)).status
      return yield* Schema.decodeUnknownEffect(StatusMap)("status" in result ? { [name]: result } : result).pipe(
        Effect.mapError((error) => new McpInstallError({ message: errorMessage(error) })),
      )
    })

    const remove = Effect.fn("McpHttpApi.remove")(function* (ctx: { payload: typeof RemovePayload.Type }) {
      const instance = yield* InstanceState.context
      const name = ctx.payload.name.trim()
      if (!name) {
        return yield* Effect.fail(new McpRemoveError({ message: "MCP server name is required" }))
      }

      const file = yield* Effect.promise(() =>
        resolveConfigFile({
          global: ctx.payload.global,
          vcs: instance.project.vcs,
          worktree: instance.worktree,
          directory: instance.directory,
        }),
      )
      const patched = yield* Effect.promise(() => removeMcpEntry(file, name))
      if (!patched.ok) {
        return yield* Effect.fail(
          new McpRemoveError({
            message:
              patched.code === "invalid_json"
                ? `Invalid JSON in ${patched.file} (${patched.parse} at line ${patched.line}, column ${patched.col})`
                : errorMessage(patched.error),
          }),
        )
      }

      yield* mcp.remove(name)
      let logout = false
      if (ctx.payload.logout) {
        yield* mcp.removeAuth(name)
        logout = true
      }
      return { removed: patched.removed, logout }
    })

    const authStart = Effect.fn("McpHttpApi.authStart")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.startAuth(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      return yield* mcp
        .finishAuth(ctx.params.name, ctx.payload.code)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.authenticate(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      const status = yield* mcp.status()
      if (!(ctx.params.name in status))
        return yield* new McpServerNotFoundError({
          name: ctx.params.name,
          message: `MCP server not found: ${ctx.params.name}`,
        })
      yield* mcp.removeAuth(ctx.params.name)
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .connect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .disconnect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    return handlers
      .handle("status", status)
      .handle("add", add)
      .handle("install", install)
      .handle("remove", remove)
      .handle("authStart", authStart)
      .handle("authCallback", authCallback)
      .handle("authAuthenticate", authAuthenticate)
      .handle("authRemove", authRemove)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
  }),
)
