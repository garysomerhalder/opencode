#!/usr/bin/env bun
// What does one request carry before any conversation? (#47, Muse token efficiency)
//
//   bun script/prompt-probe.ts --dir <project dir> [--dir ...] [--agent build] [--save <file>]
//     [--tokens-per-byte 0.3] [--env NAME=VALUE ...] [--config '<extra opencode.json JSON>']
//
// Starts a local OpenAI-compatible endpoint that records the request and
// answers "ok", then runs `opencode run` once in each directory against it.
// The real home and config are used (so instructions, skills and MCP servers
// load as they do for the Muses); the data, state and cache directories are
// temporary, so no session is written to the real database. The request body
// is broken down into system prompt sections, tool definitions (grouped by MCP
// server) and messages. --save writes the raw body; it can contain whatever the
// instruction files contain, so keep it out of the repository.

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    dir: { type: "string", multiple: true },
    agent: { type: "string", default: "build" },
    save: { type: "string" },
    "tokens-per-byte": { type: "string", default: "0.3" },
    env: { type: "string", multiple: true },
    config: { type: "string" },
    timeout: { type: "string", default: "240000" },
  },
})
const dirs = args.dir ?? [process.cwd()]
const ratio = Number(args["tokens-per-byte"])
const extraEnv = Object.fromEntries((args.env ?? []).map((pair) => pair.split(/=(.*)/s).slice(0, 2)))
const opencode = path.resolve(import.meta.dir, "..")

const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf-8")
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`)
const tok = (n: number) => k(Math.round(n * ratio))

async function capture(dir: string) {
  let body: any
  const got = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 })
      const json = await request.json()
      // the first request of the session; title generation uses the small model and has no tools
      if (!body && Array.isArray(json.tools) && json.tools.length > 0) {
        body = json
        got.resolve()
      }
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      return new Response(
        chunk({ role: "assistant", content: "ok" }, null) +
          chunk({}, "stop") +
          `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: "probe", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const temp = mkdtempSync(path.join(tmpdir(), "prompt-probe-"))
  const extraConfig: Record<string, unknown> = args.config ? JSON.parse(args.config) : {}
  const config = {
    provider: {
      capture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Capture",
        options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "probe" },
        models: { probe: { name: "Probe", tool_call: true, limit: { context: 1_048_576, output: 131_072 } } },
      },
    },
    model: "capture/probe",
    small_model: "capture/probe",
    // --config: extra opencode.json content to measure a change, e.g.
    // '{"permission":{"linear_*":"deny"}}' or a skill allowlist
    ...extraConfig,
    // A user's agent.<name>.model would otherwise send the request to a real
    // provider with the inherited keys: pin every agent this run can use.
    agent: {
      ...((extraConfig.agent as Record<string, object> | undefined) ?? {}),
      ...Object.fromEntries(
        [args.agent!, "title", "summary", "compaction"].map((name) => [
          name,
          {
            ...((extraConfig.agent as Record<string, object> | undefined)?.[name] ?? {}),
            model: "capture/probe",
          },
        ]),
      ),
    },
  }
  const child = spawn(
    process.execPath,
    ["run", path.join(opencode, "src", "index.ts"), "run", "--agent", args.agent!, "Reply with the single word ok."],
    {
      cwd: dir,
      env: {
        ...process.env,
        // `run` takes its directory from PWD when set; the inherited one is this script's
        PWD: dir,
        XDG_DATA_HOME: path.join(temp, "share"),
        XDG_STATE_HOME: path.join(temp, "state"),
        XDG_CACHE_HOME: path.join(temp, "cache"),
        OPENCODE_MODELS_PATH: path.join(opencode, "test", "tool", "fixtures", "models-api.json"),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        ...extraEnv,
        // an inherited absolute OPENCODE_DB would be written to (database.ts path())
        OPENCODE_DB: ":memory:",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  )
  let stderr = ""
  child.stderr?.on("data", (data) => (stderr += data.toString()))
  const exited = new Promise<void>((done) => child.once("exit", () => done()))
  const timer = setTimeout(
    () => got.reject(new Error(`no request within ${args.timeout} ms\n${stderr.slice(-2000)}`)),
    Number(args.timeout),
  )
  try {
    await Promise.race([got.promise, exited.then(() => got.promise)])
  } finally {
    clearTimeout(timer)
    // the run starts MCP servers as its own children: stop the whole tree
    if (process.platform === "win32" && child.pid)
      await new Promise((done) =>
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).once("exit", done),
      )
    else child.kill()
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
    server.stop(true)
    try {
      rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      console.error(`note: could not remove ${temp} (still locked); remove it later`)
    }
  }
  return { body, stderr }
}

function breakdown(body: any) {
  const messages: any[] = body.messages ?? []
  const text = (content: unknown) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n")
        : ""
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => text(m.content))
    .join("\n")
  const rest = messages.filter((m) => m.role !== "system")

  // sections of the system prompt
  const sections: { name: string; bytes: number }[] = []
  const skills = system.match(/Skills provide specialized[\s\S]*?<\/available_skills>/)?.[0] ?? ""
  if (skills)
    sections.push({ name: `skills list (${(skills.match(/<skill>/g) ?? []).length} skills)`, bytes: bytes(skills) })
  const instructions = [...system.matchAll(/Instructions from: (.+)\n/g)]
  for (let i = 0; i < instructions.length; i++) {
    const start = instructions[i].index!
    const end = i + 1 < instructions.length ? instructions[i + 1].index! : system.length
    // an instruction file ends where the next known block starts
    const block = system
      .slice(start, end)
      .split(/\n(?=Skills provide specialized|<mcp_instructions>|<available_references>)/)[0]
    sections.push({ name: `instructions: ${instructions[i][1]}`, bytes: bytes(block) })
  }
  const mcp = system.match(/<mcp_instructions>[\s\S]*?<\/mcp_instructions>/)?.[0]
  if (mcp) sections.push({ name: "mcp instructions", bytes: bytes(mcp) })
  const known = sections.reduce((total, s) => total + s.bytes, 0)
  sections.push({ name: "everything else (base prompt, environment, agent)", bytes: bytes(system) - known })

  // tools, grouped by the MCP server prefix where there is one
  const tools: any[] = body.tools ?? []
  const groups = new Map<string, { count: number; bytes: number }>()
  for (const tool of tools) {
    const name: string = tool.function?.name ?? tool.name ?? "?"
    const server =
      name.includes("_") && !["todowrite", "webfetch", "websearch"].includes(name) ? name.split("_")[0] : name
    const group = groups.get(server) ?? { count: 0, bytes: 0 }
    group.count++
    group.bytes += bytes(tool)
    groups.set(server, group)
  }
  return {
    system: bytes(system),
    sections,
    tools: bytes(tools),
    toolCount: tools.length,
    groups,
    messages: bytes(rest),
    total: bytes(body),
  }
}

for (const dir of dirs) {
  const { body } = await capture(dir)
  if (args.save) await Bun.write(args.save.replace("{n}", String(dirs.indexOf(dir))), JSON.stringify(body, null, 2))
  const b = breakdown(body)
  console.log(`\n## ${dir} (agent ${args.agent})\n`)
  console.log(`Request body ${k(b.total)} bytes, ~${tok(b.total)} tokens at ${ratio} tokens/byte.\n`)
  console.log("| part | bytes | ~tokens |\n|---|---|---|")
  console.log(`| system prompt | ${k(b.system)} | ${tok(b.system)} |`)
  for (const s of b.sections.sort((a, z) => z.bytes - a.bytes))
    console.log(`| &nbsp;&nbsp;${s.name} | ${k(s.bytes)} | ${tok(s.bytes)} |`)
  console.log(`| tool definitions (${b.toolCount}) | ${k(b.tools)} | ${tok(b.tools)} |`)
  for (const [name, g] of [...b.groups.entries()].sort((a, z) => z[1].bytes - a[1].bytes).slice(0, 12))
    console.log(`| &nbsp;&nbsp;${name}${g.count > 1 ? ` (${g.count})` : ""} | ${k(g.bytes)} | ${tok(g.bytes)} |`)
  console.log(`| messages | ${k(b.messages)} | ${tok(b.messages)} |`)
}
