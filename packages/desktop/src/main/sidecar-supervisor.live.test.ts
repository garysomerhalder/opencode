import { afterAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createSidecarSupervisor, type SidecarConnection, type StartedSidecar } from "./sidecar-supervisor"

// A real, throwaway server process: the opencode CLI's `serve`, in a temp data
// directory, on its own port. It is never the live dev app's sidecar. The test
// kills it the way the 9/21 crash did (the process just ends), and checks that
// the supervisor brings it back and that a session created before the crash is
// still there after it: sessions live on disk, not in the process.

const opencode = resolve(import.meta.dir, "../../../opencode")
const root = mkdtempSync(join(tmpdir(), "sidecar-supervisor-"))
const children: ChildProcess[] = []

afterAll(() => {
  for (const child of children) child.kill()
  rmSync(root, { recursive: true, force: true })
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

const auth = (connection: SidecarConnection) =>
  `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`

async function healthy(connection: SidecarConnection, deadline: number) {
  while (Date.now() < deadline) {
    const ok = await fetch(`${connection.url}/global/health`, { headers: { authorization: auth(connection) } })
      .then((response) => response.ok)
      .catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`server at ${connection.url} never became healthy`)
}

async function startServer(previous: SidecarConnection | undefined): Promise<StartedSidecar> {
  const connection = previous ?? {
    url: `http://127.0.0.1:${await freePort()}`,
    username: "opencode",
    password: crypto.randomUUID(),
  }
  const port = new URL(connection.url).port
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
    stdio: "ignore",
  })
  children.push(child)
  const exited = new Promise<number>((done) => child.once("exit", (code) => done(code ?? -1)))
  await Promise.race([
    healthy(connection, Date.now() + 90_000),
    exited.then((code) => {
      throw new Error(`server exited before it was healthy (code ${code})`)
    }),
  ])
  return { connection, exited, stop: async () => void child.kill() }
}

describe("sidecar supervisor with a real server process", () => {
  test("a crashed server is restarted and a session created before the crash is still there", async () => {
    const project = mkdtempSync(join(root, "project-"))
    const supervisor = createSidecarSupervisor({
      start: startServer,
      policy: { delays: [500], maxCrashes: 3, windowMs: 60_000 },
    })
    const first = await supervisor.start()
    const headers = { authorization: auth(first), "content-type": "application/json" }
    const created = await fetch(`${first.url}/session?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "before the crash" }),
    }).then((response) => response.json() as Promise<{ id: string }>)
    expect(created.id).toBeTruthy()

    // the crash: the process is gone, nobody asked it to stop
    children.at(-1)!.kill("SIGKILL")

    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && !(supervisor.state().status === "running" && children.length === 2)) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(supervisor.state().status).toBe("running")
    expect(supervisor.state().restarts).toBe(1)
    const after = supervisor.connection()!
    // same port and credentials, so clients holding the old server.json keep working
    expect(after).toEqual(first)

    const read = await fetch(`${after.url}/session/${created.id}?directory=${encodeURIComponent(project)}`, {
      headers,
    })
    expect(read.status).toBe(200)
    expect(((await read.json()) as { title: string }).title).toBe("before the crash")
    await supervisor.stop()
  }, 300_000)
})
