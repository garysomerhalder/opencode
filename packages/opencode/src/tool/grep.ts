import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CanonicalPath } from "@/util/canonical-path"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          // The directory the system resolves is the one checked and the one
          // searched: a link in the workspace cannot point the search elsewhere.
          const target = CanonicalPath.resolve(
            path.isAbsolute(params.path ?? ins.directory)
              ? (params.path ?? ins.directory)
              : path.join(ins.directory, params.path ?? "."),
          )
          const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, target, {
            bypass: false,
            kind: info?.type === "Directory" ? "directory" : "file",
          })
          const cwd = info?.type === "Directory" ? target : path.dirname(target)

          // A match prints file content, so only files the agent may read without
          // asking are searched at all (ripgrep searches hidden files, and include
          // can name any glob, .env files among them). The rest are left out before
          // the search, so nothing in the output depends on what they contain: no
          // count of them, and they cannot crowd the match cap.
          const excluded = yield* unreadable(ctx, ripgrep, cwd, params.include)
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            include: params.include,
            exclude: excluded,
            limit: LIMIT + 1,
          })
          // A file created between the listing and the search is still checked,
          // and left out without a word.
          const worktree = CanonicalPath.resolve(ins.worktree)
          const allowed = new Map<string, boolean>()
          for (const file of new Set(result.map((item) => path.join(cwd, item.entry.path))))
            allowed.set(file, yield* Tool.readable(ctx, worktree, file, "content"))
          const rows = result
            .map((item) => ({ path: path.join(cwd, item.entry.path), line: item.line, text: item.text }))
            .filter((row) => allowed.get(row.path))
          if (rows.length === 0) return empty

          const truncated = rows.length > LIMIT
          const final = rows.slice(0, LIMIT)

          const total = final.length
          const output = [`Found ${total} matches${truncated ? " (more matches available)" : ""}`]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            output.push(`  Line ${match.line}: ${match.text}`)
          }

          if (truncated) {
            output.push("")
            output.push("(Results truncated. Consider using a more specific path or pattern.)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const LIMIT = 100
// Listing more files than this to find the unreadable ones: search a narrower path.
const LIST_LIMIT = 200_000
// The exclusions go on ripgrep's command line (32767 characters on Windows).
const EXCLUDE_CHARS = 24_000

/**
 * The files under cwd, as the search would visit them, whose content the agent
 * may not read without asking, relative to cwd. Fails closed when there are
 * too many to list or to pass to ripgrep, rather than search them.
 */
const unreadable = Effect.fnUntraced(function* (
  ctx: Tool.Context,
  ripgrep: Ripgrep.Interface,
  cwd: string,
  include: string | undefined,
) {
  const ins = yield* InstanceState.context
  const worktree = CanonicalPath.resolve(ins.worktree)
  const listed = yield* ripgrep.find({ cwd, pattern: include ?? "*", hidden: true, limit: LIST_LIMIT })
  if (listed.length >= LIST_LIMIT)
    return yield* Effect.fail(new Error(`Too many files under ${cwd} to search; use a narrower path or include`))
  const excluded: string[] = []
  for (const entry of listed)
    if (!(yield* Tool.readable(ctx, worktree, path.join(cwd, entry.path), "content"))) excluded.push(entry.path)
  if (excluded.reduce((sum, file) => sum + file.length + 10, 0) > EXCLUDE_CHARS)
    return yield* Effect.fail(
      new Error(`Too many files under ${cwd} this agent may not read to search around; use a narrower path or include`),
    )
  return excluded
})
