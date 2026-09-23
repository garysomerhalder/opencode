// Stopping a child process and everything it started (#47, prompt-probe).
//
// `opencode run` starts MCP servers as its own children. Killing only the run
// leaves them running, holding the temp directory and, for a stdio server, its
// pipes. On Windows `taskkill /T` walks the tree. On macOS and Linux the child
// is spawned as the leader of its own process group, and the whole group is
// signalled. Either way only while the child still runs, so a PID the system
// has since reused is never targeted.

import { spawn, type ChildProcess } from "node:child_process"

/** Spawn options that let stop() reach the child's whole tree. */
export function spawnOptions(platform: NodeJS.Platform = process.platform) {
  // detached on Windows would open a console window for the child; taskkill does not need it
  return { detached: platform !== "win32" }
}

export type Plan = { kind: "taskkill"; args: string[] } | { kind: "group"; pgid: number }

/** How to stop a child and its descendants, or undefined when there is nothing safe to target. */
export function plan(input: {
  platform: NodeJS.Platform
  pid: number | undefined
  running: boolean
}): Plan | undefined {
  if (!input.running || input.pid === undefined) return undefined
  if (input.platform === "win32") return { kind: "taskkill", args: ["/pid", String(input.pid), "/T", "/F"] }
  return { kind: "group", pgid: input.pid }
}

/**
 * Stops a child spawned with spawnOptions() and waits for it to exit, at most
 * `graceMs`. On POSIX the group gets SIGTERM, and SIGKILL if the child has not
 * exited by then.
 */
export async function stop(child: ChildProcess, graceMs = 5000) {
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((done) => child.once("exit", () => done()))
  const step = plan({
    platform: process.platform,
    pid: child.pid,
    running: child.exitCode === null && child.signalCode === null,
  })
  if (step?.kind === "taskkill")
    await new Promise((done) => spawn("taskkill", step.args, { stdio: "ignore" }).once("exit", done))
  if (step?.kind === "group") signal(step.pgid, "SIGTERM")
  await Promise.race([exited, new Promise((done) => setTimeout(done, graceMs))])
  if (step?.kind === "group" && child.exitCode === null && child.signalCode === null) {
    signal(step.pgid, "SIGKILL")
    await Promise.race([exited, new Promise((done) => setTimeout(done, graceMs))])
  }
}

function signal(pgid: number, name: NodeJS.Signals) {
  try {
    // a negative PID signals the whole process group
    process.kill(-pgid, name)
  } catch {
    // ESRCH: the group is already gone
  }
}

export * as ProcessTree from "./process-tree"
