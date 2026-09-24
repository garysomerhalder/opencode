import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./lsp.txt"
import { InstanceState } from "@/effect/instance-state"
import { fileURLToPath, pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const Parameters = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The character offset (1-based, as shown in editors)",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
})

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(instance.directory, args.filePath)
          yield* assertExternalDirectoryEffect(ctx, file)
          const meta =
            args.operation === "workspaceSymbol"
              ? { operation: args.operation }
              : args.operation === "documentSymbol"
                ? { operation: args.operation, filePath: file }
                : { operation: args.operation, filePath: file, line: args.line, character: args.character }
          yield* ctx.ask({
            permission: "lsp",
            // the operation, so rules can allow some and not others (the verifier's
            // lock refuses hover)
            patterns: [args.operation],
            always: ["*"],
            metadata: meta,
          })
          // hover and symbols carry the file's content: the read rules apply to it
          if (args.operation !== "workspaceSymbol")
            yield* ctx.ask({
              permission: "read",
              patterns: Tool.readPatterns(instance.worktree, file),
              always: ["*"],
              metadata: {},
            })

          const uri = pathToFileURL(file).href
          const position = { file, line: args.line - 1, character: args.character - 1 }
          const relPath = path.relative(instance.worktree, file)
          const detail =
            args.operation === "workspaceSymbol"
              ? ""
              : args.operation === "documentSymbol"
                ? relPath
                : `${relPath}:${args.line}:${args.character}`
          const title = detail ? `${args.operation} ${detail}` : args.operation

          const exists = yield* fs.existsSafe(file)
          if (!exists) throw new Error(`File not found: ${file}`)

          const available = yield* lsp.hasClients(file)
          if (!available) throw new Error("No LSP server available for this file type.")

          yield* lsp.touchFile(file, "document")

          // A hover describes the symbol where it is defined, and can carry that
          // file's values (the type of a constant). Shown only when the agent may
          // read every file the symbol is defined in. Type information can still
          // flow in from elsewhere, so the verifier's lock refuses hover outright.
          const hover = Effect.fnUntraced(function* (at: typeof position) {
            for (const item of yield* lsp.definition(at)) {
              const target = locationFile(item)
              if (!target || !(yield* Tool.readable(ctx, instance.worktree, target, "content"))) return []
            }
            return yield* lsp.hover(at)
          })

          const raw: unknown[] = yield* (() => {
            switch (args.operation) {
              case "goToDefinition":
                return lsp.definition(position)
              case "findReferences":
                return lsp.references(position)
              case "hover":
                return hover(position)
              case "documentSymbol":
                return lsp.documentSymbol(uri)
              case "workspaceSymbol":
                return lsp.workspaceSymbol(args.query ?? "")
              case "goToImplementation":
                return lsp.implementation(position)
              case "prepareCallHierarchy":
                return lsp.prepareCallHierarchy(position)
              case "incomingCalls":
                return lsp.incomingCalls(position)
              case "outgoingCalls":
                return lsp.outgoingCalls(position)
            }
          })()
          // locations in files the agent's read rules deny are left out
          const result: unknown[] = []
          for (const item of raw) {
            const target = locationFile(item)
            if (target && !(yield* Tool.readable(ctx, instance.worktree, target, "path"))) continue
            result.push(item)
          }

          return {
            title,
            metadata: { result },
            output: result.length === 0 ? `No results found for ${args.operation}` : JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** The file an LSP result points into: Location, LocationLink, SymbolInformation or a call-hierarchy item. */
function locationFile(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined
  const record = item as Record<string, any>
  const uri = record.uri ?? record.targetUri ?? record.location?.uri ?? record.from?.uri ?? record.to?.uri
  if (typeof uri !== "string" || !uri.startsWith("file:")) return undefined
  return fileURLToPath(uri)
}
