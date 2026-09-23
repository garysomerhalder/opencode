import { spawn } from "node:child_process"
import { describe, expect, test } from "bun:test"
import { ProcessTree } from "../../script/process-tree"

describe("ProcessTree.plan", () => {
  test("Windows: taskkill walks the tree from the child", () => {
    expect(ProcessTree.plan({ platform: "win32", pid: 42, running: true })).toEqual({
      kind: "taskkill",
      args: ["/pid", "42", "/T", "/F"],
    })
  })

  test("macOS and Linux: the child's whole process group is signalled, not the child alone", () => {
    expect(ProcessTree.plan({ platform: "linux", pid: 42, running: true })).toEqual({ kind: "group", pgid: 42 })
    expect(ProcessTree.plan({ platform: "darwin", pid: 42, running: true })).toEqual({ kind: "group", pgid: 42 })
  })

  test("a child that has exited is never targeted: its PID may be reused", () => {
    expect(ProcessTree.plan({ platform: "win32", pid: 42, running: false })).toBeUndefined()
    expect(ProcessTree.plan({ platform: "linux", pid: 42, running: false })).toBeUndefined()
    expect(ProcessTree.plan({ platform: "linux", pid: undefined, running: true })).toBeUndefined()
  })

  test("on macOS and Linux the child leads its own group; Windows gets no console window", () => {
    expect(ProcessTree.spawnOptions("linux").detached).toBe(true)
    expect(ProcessTree.spawnOptions("darwin").detached).toBe(true)
    expect(ProcessTree.spawnOptions("win32").detached).toBe(false)
  })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("ProcessTree.stop", () => {
  // Runs the real path for this platform: taskkill on Windows, the group signal elsewhere.
  test("stops the child and the process it started", async () => {
    const script = `const g = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"]); console.log(g.pid); setTimeout(() => {}, 60000)`
    const child = spawn(process.execPath, ["-e", script], {
      ...ProcessTree.spawnOptions(),
      stdio: ["ignore", "pipe", "ignore"],
    })
    const grandchild = await new Promise<number>((done) =>
      child.stdout!.once("data", (data) => done(Number(data.toString().trim()))),
    )
    expect(alive(grandchild)).toBe(true)

    await ProcessTree.stop(child, 5000)

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    const deadline = Date.now() + 5000
    while (alive(grandchild) && Date.now() < deadline) await Bun.sleep(100)
    expect(alive(grandchild)).toBe(false)
  }, 30_000)
})
