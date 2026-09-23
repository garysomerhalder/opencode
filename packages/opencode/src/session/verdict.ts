// The goal verifier's verdict, and the host's check of it (accuracy E, docs/accuracy-e.md §2).
//
// The verifier ends by submitting a verdict with evidence for each criterion.
// The host accepts it only when every citation checks out against its own
// records: a quote must be in the file at the cited lines, a check must be one
// the loop ran with that exit code and output, a diff excerpt must be in the
// host's diff. A citation that does not check out never counts as evidence.
//
// Pure: the caller supplies the world (file reader, check records, diff), so
// the rules are unit-tested and port as they are.

export type Evidence =
  | { readonly kind: "file"; readonly path: string; readonly lines: readonly [number, number]; readonly quote: string }
  | { readonly kind: "check"; readonly callID: string; readonly exit: number; readonly excerpt: string }
  | { readonly kind: "diff"; readonly path: string; readonly excerpt: string }

export type Status = "met" | "unmet" | "unknown"

export interface Criterion {
  readonly id: string
  readonly text: string
  readonly status: Status
  readonly evidence: ReadonlyArray<Evidence>
}

export interface Verdict {
  readonly verdict: "PASS" | "FAIL" | "PARTIAL"
  readonly criteria: ReadonlyArray<Criterion>
  /** What evidence would settle each criterion that is not met. */
  readonly missing: ReadonlyArray<{ readonly criterion: string; readonly need: string }>
  readonly todos?: ReadonlyArray<{ readonly content: string; readonly status: "met" | "unmet" | "obsolete" }>
}

/** The host's own records, which the citations are checked against. */
export interface World {
  /** A file's content; undefined when it is missing or may not be cited. */
  readonly file: (path: string) => string | undefined
  /** A check the loop ran in this verification (a user-run shell command). */
  readonly check: (callID: string) => { readonly exit: number | undefined; readonly output: string } | undefined
  /** The host's diff since the loop started; undefined when there is none. */
  readonly diff: string | undefined
}

export interface Result {
  /** Why the submission is not accepted as submitted; empty when it is. */
  readonly errors: string[]
  /** What is stored: the submission, or on the last one what survives the check. Undefined when nothing can be. */
  readonly verdict: Verdict | undefined
  /** A PASS stored as PARTIAL because criteria it claimed met are unsupported. */
  readonly downgraded: boolean
}

/**
 * Checks a submission. With `final: false` (submissions left) any error rejects
 * it, so the verifier can fix its citations. With `final: true` the citations
 * that do not check out are dropped, a criterion left without evidence is no
 * longer met, and an unsupported PASS is stored as PARTIAL with those criteria
 * as missing evidence.
 */
export function validate(input: Verdict, world: World, options: { final: boolean }): Result {
  if (input.criteria.length === 0)
    return { errors: ["no criteria: list the criteria you judged"], verdict: undefined, downgraded: false }

  const errors: string[] = []
  const seen = new Set<string>()
  const checked = input.criteria.map((criterion) => {
    if (seen.has(criterion.id)) errors.push(`${criterion.id}: the id is used twice`)
    seen.add(criterion.id)
    const cited = criterion.evidence.map((evidence) => ({ evidence, error: citation(evidence, world) }))
    for (const item of cited) if (item.error) errors.push(`${criterion.id}: ${item.error}`)
    if (criterion.status === "met" && criterion.evidence.length === 0)
      errors.push(`${criterion.id}: met, but cites no evidence`)
    return { criterion, cited }
  })
  const structural = errors.some((error) => error.endsWith("the id is used twice"))
  errors.push(...consistency(input.verdict, input.criteria))

  if (errors.length === 0) return { errors, verdict: input, downgraded: false }
  if (!options.final || structural) return { errors, verdict: undefined, downgraded: false }

  // The last submission: keep only what checks out.
  const unsupported: { criterion: string; need: string }[] = []
  const criteria = checked.map(({ criterion, cited }): Criterion => {
    const evidence = cited.filter((item) => !item.error).map((item) => item.evidence)
    if (criterion.status !== "met" || evidence.length > 0) return { ...criterion, evidence }
    const reason = cited.find((item) => item.error)?.error ?? "none was cited"
    unsupported.push({ criterion: criterion.id, need: `evidence that checks out: ${reason}` })
    return { ...criterion, status: "unknown", evidence }
  })
  const allMet = criteria.every((criterion) => criterion.status === "met")
  // a FAIL or PARTIAL whose criteria are all met contradicts itself: nothing to store
  if (allMet && input.verdict !== "PASS") return { errors, verdict: undefined, downgraded: false }
  const downgraded = input.verdict === "PASS" && !allMet
  const verdict: Verdict = {
    ...input,
    verdict: downgraded ? "PARTIAL" : input.verdict,
    criteria,
    missing: [...input.missing, ...unsupported],
  }
  return { errors, verdict, downgraded }
}

function consistency(verdict: Verdict["verdict"], criteria: ReadonlyArray<Criterion>) {
  if (verdict === "PASS")
    return criteria
      .filter((criterion) => criterion.status !== "met")
      .map((criterion) => `PASS, but ${criterion.id} is ${criterion.status}`)
  if (criteria.every((criterion) => criterion.status === "met")) return [`${verdict}, but every criterion is met`]
  return []
}

/** Why a citation does not check out, or undefined when it does. */
function citation(evidence: Evidence, world: World): string | undefined {
  if (evidence.kind === "file") {
    const content = world.file(evidence.path)
    if (content === undefined) return `${evidence.path} cannot be read`
    const [start, end] = evidence.lines
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
      return `lines ${start}-${end} are not a range`
    const lines = content.split(/\r?\n/)
    if (end > lines.length) return `lines ${start}-${end} are outside ${evidence.path} (${lines.length} lines)`
    const quote = normalize(evidence.quote)
    if (quote === "") return "the quote is empty"
    if (!normalize(lines.slice(start - 1, end).join("\n")).includes(quote))
      return `the quote is not in ${evidence.path} at lines ${start}-${end}`
    return undefined
  }
  if (evidence.kind === "check") {
    const check = world.check(evidence.callID)
    if (!check) return `there is no check ${evidence.callID} in this verification`
    if (check.exit === undefined) return `check ${evidence.callID} has no exit code (it was aborted)`
    if (check.exit !== evidence.exit) return `check ${evidence.callID} exited ${check.exit}, not ${evidence.exit}`
    const excerpt = normalize(evidence.excerpt)
    if (excerpt === "" || !normalize(check.output).includes(excerpt))
      return `the excerpt is not in the output of check ${evidence.callID}`
    return undefined
  }
  if (!world.diff) return "there is no host diff for this verification"
  if (!world.diff.includes(evidence.path.replaceAll("\\", "/"))) return `the diff does not touch ${evidence.path}`
  const excerpt = normalize(evidence.excerpt)
  if (excerpt === "" || !normalize(world.diff).includes(excerpt)) return "the excerpt is not in the diff"
  return undefined
}

/** Whitespace, line endings and indentation do not matter. */
function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

export * as Verdict from "./verdict"
