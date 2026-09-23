import { afterAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  createSidecarSupervisor,
  type SidecarConnection,
  type SidecarSupervisor,
  type StartedSidecar,
} from "./sidecar-supervisor"

// A real, throwaway server process: the opencode CLI's `serve`, in a temp data
// directory, on its own port. It is never the live dev app's sidecar. The tests
// kill it the way the 9/21 crash did (the process just ends), and check that
// the supervisor brings it back and that a session created before the crash is
// still there after it: sessions live on disk, not in the process.
//
// `startServer` mirrors the product's startLocalSidecar (index.ts): a restart
// tries the previous port first and falls back to a new port with the same
// credentials, so these tests exercise what ships.

const opencode = resolve(import.meta.dir, "../../../opencode")
const root = mkdtempSync(join(tmpdir(), "sidecar-supervisor-"))
const children: ChildProcess[] = []
const logs: number[] = []
const history: string[] = []
const t0 = Date.now()
const note = (line: string) => history.push(`${Date.now() - t0}ms ${line}`)

afterAll(async () => {
  // Windows keeps the data directory locked until every server has exited, so
  // wait for the exits before removing it, and retry a lock that lingers.
  await Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? undefined
        : Promise.race([
            new Promise((done) => child.once("exit", done)),
            new Promise((done) => setTimeout(done, 10_000)),
          ]).finally(() => undefined),
    ),
  )
  for (const child of children) child.kill("SIGKILL")
  for (const fd of logs) closeSync(fd)
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

const freePort = () =>
  new Promise<number>((done, fail) => {
    const socket = createServer()
    socket.on("error", fail)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      const port = typeof address === "object" && address ? address.port : 0
      socket.close(() => done(port))
    })
  })

const hold = (port: number) =>
  new Promise<Server>((done, fail) => {
    const socket = createServer()
    socket.on("error", fail)
    socket.listen(port, "127.0.0.1", () => done(socket))
  })

const auth = (connection: SidecarConnection) =>
  `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`

async function healthy(connection: SidecarConnection, deadline: number) {
  while (Date.now() < deadline) {
    const ok = await fetch(`${connection.url}/global/health`, {
      headers: { authorization: auth(connection) },
      signal: AbortSignal.timeout(5_000),
    })
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`server at ${connection.url} never became healthy`)
}

async function launch(connection: SidecarConnection): Promise<StartedSidecar> {
  const port = new URL(connection.url).port
  const index = children.length
  const out = openSync(join(root, `server-${index}.log`), "w")
  logs.push(out)
  note(`spawn #${index} on port ${port}`)
  const child = spawn(process.execPath, ["run", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", port], {
    cwd: opencode,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: connection.password,
      OPENCODE_SERVER_USERNAME: connection.username,
      XDG_DATA_HOME: join(root, "share"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_MODELS_PATH: join(opencode, "test", "tool", "fixtures", "models-api.json"),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    },
    stdio: ["ignore", out, out],
  })
  children.push(child)
  const exited = new Promise<number>((done) =>
    child.once("exit", (code, signal) => {
      note(`exit #${index} code=${code} signal=${signal}`)
      done(code ?? -1)
    }),
  )
  try {
    await Promise.race([
      healthy(connection, Date.now() + 90_000),
      exited.then((code) => {
        throw new Error(`server exited before it was healthy (code ${code})`)
      }),
    ])
  } catch (error) {
    child.kill("SIGKILL")
    throw error
  }
  note(`healthy #${index}`)
  return { connection, exited, stop: async () => void child.kill() }
}

async function startServer(previous: SidecarConnection | undefined): Promise<StartedSidecar> {
  if (!previous)
    return launch({
      url: `http://127.0.0.1:${await freePort()}`,
      username: "opencode",
      password: crypto.randomUUID(),
    })
  return launch(previous).catch(async (error) => {
    note(`restart on the previous port failed (${error}); trying a new port`)
    return launch({ ...previous, url: `http://127.0.0.1:${await freePort()}` })
  })
}

function supervise(policy = { delays: [500], maxCrashes: 3, windowMs: 60_000 }) {
  return createSidecarSupervisor({
    start: startServer,
    policy,
    onState: (state) => note(`state ${state.status} restarts=${state.restarts} ${state.error ?? ""}`.trim()),
  })
}

// Waits on the supervisor's own observable state, never on how many processes
// it took: a restart may need a second launch (the port fallback).
async function restarted(supervisor: SidecarSupervisor, deadline: number) {
  while (Date.now() < deadline) {
    const state = supervisor.state()
    if (state.status === "failed") return
    if (state.status === "running" && state.restarts >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function createSession(connection: SidecarConnection, directory: string) {
  const response = await fetch(`${connection.url}/session?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { authorization: auth(connection), "content-type": "application/json" },
    body: JSON.stringify({ title: "before the crash" }),
    signal: AbortSignal.timeout(30_000),
  })
  return (await response.json()) as { id: string }
}

async function readSession(connection: SidecarConnection, directory: string, id: string) {
  const response = await fetch(`${connection.url}/session/${id}?directory=${encodeURIComponent(directory)}`, {
    headers: { authorization: auth(connection) },
    signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, title: ((await response.json()) as { title?: string }).title }
}

// On a failure the timeline and the servers' own output say why.
function diagnostics() {
  const tails = readdirSync(root)
    .filter((name) => name.endsWith(".log"))
    .map((name) => `--- ${name}\n${readFileSync(join(root, name), "utf8").slice(-2000)}`)
  return [...history, ...tails].join("\n")
}

describe("sidecar supervisor with a real server process", () => {
  test("a crashed server is restarted and a session created before the crash is still there", async () => {
    const project = mkdtempSync(join(root, "project-"))
    const supervisor = supervise()
    try {
      const first = await supervisor.start()
      const created = await createSession(first, project)
      expect(created.id).toBeTruthy()

      // the crash: the process is gone, nobody asked it to stop
      children.at(-1)!.kill("SIGKILL")

      await restarted(supervisor, Date.now() + 150_000)
      expect({ status: supervisor.state().status, restarts: supervisor.state().restarts }, diagnostics()).toEqual({
        status: "running",
        restarts: 1,
      })
      const after = supervisor.connection()!
      // same credentials, so a client holding the rewritten server.json keeps working
      expect({ username: after.username, password: after.password }).toEqual({
        username: first.username,
        password: first.password,
      })
      expect(await readSession(after, project, created.id), diagnostics()).toEqual({
        status: 200,
        title: "before the crash",
      })
    } finally {
      await supervisor.stop()
    }
  }, 300_000)

  test("a restart whose old port is taken falls back to a new port within the same restart", async () => {
    const project = mkdtempSync(join(root, "project-"))
    const supervisor = supervise()
    let squatter: Server | undefined
    try {
      const first = await supervisor.start()
      const created = await createSession(first, project)
      const child = children.at(-1)!
      const gone = new Promise((done) => child.once("exit", done))
      child.kill("SIGKILL")
      await gone
      // something else takes the port before the relaunch (500 ms later)
      squatter = await hold(Number(new URL(first.url).port)).catch((error) => {
        // still held by the killed server's socket: the relaunch has to fall back either way
        note(`port still taken after the kill: ${error}`)
        return undefined
      })
      note(`holding port ${new URL(first.url).port}`)

      await restarted(supervisor, Date.now() + 150_000)
      expect({ status: supervisor.state().status, restarts: supervisor.state().restarts }, diagnostics()).toEqual({
        status: "running",
        restarts: 1,
      })
      const after = supervisor.connection()!
      expect(after.url).not.toBe(first.url)
      expect(after.password).toBe(first.password)
      expect(await readSession(after, project, created.id), diagnostics()).toEqual({
        status: 200,
        title: "before the crash",
      })
    } finally {
      squatter?.close()
      await supervisor.stop()
    }
  }, 300_000)
})
