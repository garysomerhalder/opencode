// One verification of a goal loop's worker (accuracy E Phase 4, docs/accuracy-e.md
// §11.9): the host creates a pinned, sealed verifier session from the worker's goal
// record, runs the trusted checks in it, prompts the verifier, and reads the verdict
// the verdict tool recorded on the worker's goal. Everything it returns is built from
// the host's records (the goal's lastVerdict, the checks' recorded exit codes), never
// from the verifier's prose. Every write carries the host token.

/** A non-2xx answer, with its status (the loop tells 409 "the goal is gone" apart). */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type VerifyIO = {
  /** A request to the server; `host` adds the host token. Throws RequestError on non-2xx. */
  request: (path: string, init: { method: string; body?: string; host?: boolean }) => Promise<unknown>
  sleep: (ms: number) => Promise<void>
  now: () => number
  alive: () => boolean
}

export type VerifyInput = {
  workerID: string
  directory: string
  goal: string
  checks: string[]
  /** What the last verdict asked for, so the verifier can look at it first. */
  missingBefore: { criterion: string; need: string }[]
  pollMs: number
  /** Wall-clock cap on the verifier's turn (ruling 2); past it, no verdict. */
  timeoutMs: number
  onVerifier: (verifierSessionID: string) => void
}

export type LastVerdict = {
  verdict: "PASS" | "PARTIAL" | "FAIL"
  at: number
  verifierSessionID: string
  unmet: string[]
  missing?: { criterion: string; need: string }[]
  counts?: { met: number; unmet: number; unknown: number }
}

export type VerifyOutcome =
  | { kind: "pass"; verdict: LastVerdict }
  /** Ends the loop without using an attempt (ruling 3: the verifier could not judge). */
  | { kind: "unverified"; reason: string; verdict: LastVerdict }
  /** Not counted: the goal changed or ended; the worker continues. */
  | { kind: "stale"; reason: string }
  /** Counted: the worker continues with `feedback`, built from host records only. */
  | { kind: "fail"; feedback: string; verdict: LastVerdict | null }

type Goal = { id: string; endedAt?: number; lastVerdict?: LastVerdict }
type Ran = { partID: string; callID: string; command: string }

const NUDGE = "Submit your verdict now, with the verdict tool, citing the evidence you have."

export async function verifyOnce(io: VerifyIO, input: VerifyInput): Promise<VerifyOutcome> {
  const q = `?directory=${encodeURIComponent(input.directory)}`
  const goalPath = `/experimental/session/${input.workerID}/goal${q}`
  const before = (await io.request(goalPath, { method: "GET" })) as Goal

  let started: { verifierSessionID: string; pin: { providerID: string; modelID: string } }
  try {
    started = (await io.request(`/experimental/session/${input.workerID}/verify${q}`, {
      method: "POST",
      body: "{}",
      host: true,
    })) as typeof started
  } catch (error) {
    if (error instanceof RequestError && error.status === 409)
      return { kind: "stale", reason: "the goal changed before its verification started; the attempt was dropped" }
    throw error
  }
  const child = started.verifierSessionID
  input.onVerifier(child)

  const ran: Ran[] = []
  for (const command of input.checks) {
    const result = (await io.request(`/session/${child}/shell${q}`, {
      method: "POST",
      body: JSON.stringify({ agent: "build", command }),
      host: true,
    })) as { parts?: { id?: string; type?: string; callID?: string }[] }
    const part = result?.parts?.find((item) => item.type === "tool")
    if (part?.id && part.callID) ran.push({ partID: part.id, callID: part.callID, command })
  }

  const model = { providerID: started.pin.providerID, modelID: started.pin.modelID }
  const promptVerifier = (text: string) =>
    io.request(`/session/${child}/prompt_async${q}`, {
      method: "POST",
      body: JSON.stringify({ agent: "verifier", model, autonomous: true, parts: [{ type: "text", text }] }),
      host: true,
    })

  // the verdict the tool recorded for this verifier, "stale" when the goal moved on,
  // undefined when the verifier's turn ended without one (or ran out of time)
  const waitVerdict = async (): Promise<LastVerdict | "stale" | undefined> => {
    const since = io.now()
    while (io.alive() && io.now() - since < input.timeoutMs) {
      await io.sleep(input.pollMs)
      const status = (await io.request(`/session/status${q}`, { method: "GET" })) as Record<string, { type?: string }> | null
      if ((status?.[child]?.type ?? "idle") !== "idle") continue
      const goal = (await io.request(goalPath, { method: "GET" })) as Goal
      if (goal.id !== before.id || goal.endedAt !== undefined) return "stale"
      if (goal.lastVerdict?.verifierSessionID === child) return goal.lastVerdict
      const messages = (await io.request(`/session/${child}/message${q}`, { method: "GET" })) as unknown[] | null
      const answered = (messages ?? []).some(
        (message) => (message as { info?: { role?: string } })?.info?.role === "assistant",
      )
      if (answered) return undefined
    }
    return undefined
  }

  await promptVerifier(verifierPrompt(input, ran))
  let verdict = await waitVerdict()
  if (verdict === undefined && io.alive()) {
    await promptVerifier(NUDGE)
    verdict = await waitVerdict()
  }
  if (verdict === "stale")
    return { kind: "stale", reason: "the goal changed during its verification; the attempt was dropped" }
  if (verdict === undefined)
    return {
      kind: "fail",
      verdict: null,
      feedback: "The independent verification recorded no verdict. Make sure the work is complete and checkable.",
    }
  if (verdict.verdict === "PASS") return { kind: "pass", verdict }
  const counts = verdict.counts
  if (counts && counts.unknown > 0 && counts.met === 0 && counts.unmet === 0)
    return { kind: "unverified", reason: "verifier could not judge", verdict }

  // the checks that failed, from the host's record of them (their recorded exit codes)
  const record = (await io.request(`/session/${child}${q}`, { method: "GET" })) as {
    metadata?: { verifyRecord?: { checks?: Record<string, { exit: number | null }> } }
  }
  const exits = record?.metadata?.verifyRecord?.checks ?? {}
  const failed = ran.flatMap((item) => {
    const exit = exits[item.partID]?.exit
    return exit === 0 ? [] : [`${item.command} (exited ${exit ?? "without an exit code"})`]
  })
  return { kind: "fail", verdict, feedback: feedback(verdict, failed) }
}

function verifierPrompt(input: VerifyInput, ran: Ran[]) {
  const lines = [
    "Verify whether this goal is achieved, independently. You can read the workspace; you cannot change it.",
    "",
    "Goal:",
    input.goal,
  ]
  if (ran.length) {
    lines.push("", "Checks the host ran for this verification (cite them by call id):")
    for (const item of ran) lines.push(`- ${item.callID}: ${item.command}`)
  }
  if (input.missingBefore.length) {
    lines.push("", "The last verification asked for:")
    for (const item of input.missingBefore) lines.push(`- ${item.criterion}: ${item.need}`)
  }
  lines.push("", "Judge every acceptance criterion with cited evidence, then submit your verdict with the verdict tool.")
  return lines.join("\n")
}

/** The worker's feedback: the host's records only (unmet criteria, what is missing, failed checks). */
function feedback(verdict: LastVerdict, failed: string[]) {
  const lines = [`An independent verification did not accept the goal as achieved (${verdict.verdict}).`]
  if (verdict.unmet.length) {
    lines.push("", "Criteria not met:")
    for (const item of verdict.unmet) lines.push(`- ${item}`)
  }
  if (verdict.missing?.length) {
    lines.push("", "What would settle them:")
    for (const item of verdict.missing) lines.push(`- ${item.criterion}: ${item.need}`)
  }
  if (failed.length) {
    lines.push("", "Checks that failed:")
    for (const item of failed) lines.push(`- ${item}`)
  }
  return lines.join("\n")
}
