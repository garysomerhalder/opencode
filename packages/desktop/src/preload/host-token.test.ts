// The server's host token (accuracy E §11.8) authorizes goal writes. It lives in
// the Electron main process only (hostToken() in main/server.ts). A renderer runs
// web content, so nothing may hand the token to one: the preload exposes no API
// that returns it, and no IPC handler in main sends it.
import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))
const main = join(dir, "..", "main")
const token = /hostToken|host-token|HostToken/

const sources = async (folder: string) =>
  (await readdir(folder)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))

test("the preload exposes nothing that carries the host token", async () => {
  for (const file of await sources(dir)) {
    const text = await Bun.file(join(dir, file)).text()
    expect([file, token.test(text)]).toEqual([file, false])
  }
})

test("only the sidecar handshake, the server module and the goal loop in main touch the host token", async () => {
  const touching: string[] = []
  for (const file of await sources(main)) {
    if (token.test(await Bun.file(join(main, file)).text())) touching.push(file)
  }
  // sidecar.ts sends it from the utility process; server.ts receives and holds it and
  // gives it out only for the local server's origin (hostTokenFor); index.ts wires that
  // into the goal loop; goal-loop.ts sends it with the loop's host requests (Phase 4).
  // ipc.ts (the renderer's handlers) must never appear here.
  expect(touching.sort()).toEqual(["goal-loop.ts", "index.ts", "server.ts", "sidecar.ts"])
  expect(touching).not.toContain("ipc.ts")
})
