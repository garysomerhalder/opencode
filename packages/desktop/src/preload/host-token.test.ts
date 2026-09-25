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

test("only the sidecar handshake and the server module in main touch the host token", async () => {
  const touching: string[] = []
  for (const file of await sources(main)) {
    if (token.test(await Bun.file(join(main, file)).text())) touching.push(file)
  }
  // server.ts receives and holds it; sidecar.ts sends it from the utility process.
  // ipc.ts (the renderer's handlers) must never appear here.
  expect(touching.sort()).toEqual(["server.ts", "sidecar.ts"])
})
