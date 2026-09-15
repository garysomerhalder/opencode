import path from "path"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"

import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Filesystem } from "@/util/filesystem"

export type ScopeInput = {
  global?: boolean
  vcs?: string
  worktree: string
  directory: string
  config?: string
}

// Base directory for MCP config lookup. Mirrors the CLI: the global config
// dir for global scope, otherwise the worktree root (git) or working
// directory, each with an `.opencode/` fallback.
export function configBase(input: ScopeInput): string {
  if (input.global) return input.config ?? Global.Path.config
  const git = input.vcs === "git" && input.worktree !== "/"
  return git ? input.worktree : input.directory
}

// Candidate config files in read order: the first existing file wins for
// reads and patches, defaulting to opencode.json. Same order as the CLI's
// resolveConfigPath.
export function configCandidates(baseDir: string, global = false): string[] {
  const candidates = [path.join(baseDir, "opencode.json"), path.join(baseDir, "opencode.jsonc")]
  if (!global) {
    candidates.push(path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc"))
  }
  return candidates
}

export async function resolveConfigFile(input: ScopeInput): Promise<string> {
  const base = configBase(input)
  const candidates = configCandidates(base, input.global)
  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) return candidate
  }
  return candidates[0]
}

function patch(text: string, p: Array<string | number>, value: unknown) {
  return applyEdits(
    text,
    modify(text, p, value, {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
      },
    }),
  )
}

type InvalidJson = {
  ok: false
  code: "invalid_json"
  file: string
  line: number
  col: number
  parse: string
}

type PatchFailed = {
  ok: false
  code: "patch_failed"
  file: string
  error: unknown
}

function invalid(text: string, file: string, errs: JsoncParseError[]): InvalidJson {
  const err = errs[0]
  const lines = text.substring(0, err.offset).split("\n")
  return {
    ok: false,
    code: "invalid_json",
    file,
    line: lines.length,
    col: lines[lines.length - 1].length + 1,
    parse: printParseErrorCode(err.error),
  }
}

async function readConfig(
  file: string,
): Promise<{ ok: true; text: string } | InvalidJson | { ok: false; code: "patch_failed"; file: string; error: unknown }> {
  const src = await Filesystem.readText(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "{}"
    return err
  })
  if (src instanceof Error) return { ok: false, code: "patch_failed", file, error: src }
  const text = src.trim() ? src : "{}"
  const errs: JsoncParseError[] = []
  parseJsonc(text, errs, { allowTrailingComma: true })
  if (errs.length) return invalid(text, file, errs)
  return { ok: true, text }
}

function lock(file: string) {
  return Flock.acquire(`mcp-config:${Filesystem.resolve(file)}`)
}

export type AddResult = { ok: true; file: string } | InvalidJson | PatchFailed

export async function addMcpEntry(file: string, name: string, config: ConfigMCPV1.Info): Promise<AddResult> {
  await using _ = await lock(file)
  const read = await readConfig(file)
  if (!read.ok) return read
  const out = patch(read.text, ["mcp", name], config)
  const write = await Filesystem.write(file, out).catch((error: unknown) => error)
  if (write instanceof Error) return { ok: false, code: "patch_failed", file, error: write }
  return { ok: true, file }
}

export type RemoveResult = { ok: true; file: string; removed: boolean } | InvalidJson | PatchFailed

export async function removeMcpEntry(file: string, name: string): Promise<RemoveResult> {
  if (!(await Filesystem.exists(file))) return { ok: true, file, removed: false }
  await using _ = await lock(file)
  const read = await readConfig(file)
  if (!read.ok) return read

  const errs: JsoncParseError[] = []
  const data = parseJsonc(read.text, errs, { allowTrailingComma: true }) as { mcp?: unknown } | undefined
  const entries = data?.mcp
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || !(name in entries)) {
    return { ok: true, file, removed: false }
  }

  const out = patch(read.text, ["mcp", name], undefined)
  const write = await Filesystem.write(file, out).catch((error: unknown) => error)
  if (write instanceof Error) return { ok: false, code: "patch_failed", file, error: write }
  return { ok: true, file, removed: true }
}
