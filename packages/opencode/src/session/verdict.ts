// The goal verifier's verdict, and the host's check of it (accuracy E, docs/accuracy-e.md §2).
//
// The verifier ends by submitting a verdict with evidence for each criterion.
// The host accepts it only when every citation checks out against its own
// records: a quote must be in the file at the cited lines, a check must be one
// the host ran for this verification with that exit code and output, a diff
// excerpt must be in the host's diff for that file. The verifier's own text
// never stands in for those records: a citation that does not check out never
// counts, every criterion the user declared must be judged as written, a PASS
// cannot stand while a check failed, and a todo marked met needs evidence too.
//
// Pure: the caller supplies the world (file reader, check records, diff,
// declared criteria), so the rules are unit-tested and port as they are.

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

export interface Todo {
  readonly content: string
  readonly status: "met" | "unmet" | "unknown" | "obsolete"
  readonly evidence?: ReadonlyArray<Evidence>
}

export interface Verdict {
  readonly verdict: "PASS" | "FAIL" | "PARTIAL"
  readonly criteria: ReadonlyArray<Criterion>
  /** What evidence would settle each criterion that is not met. */
  readonly missing: ReadonlyArray<{ readonly criterion: string; readonly need: string }>
  readonly todos?: ReadonlyArray<Todo>
}

/** A check the host ran for this verification (a user-run shell command). */
export interface Check {
  readonly callID: string
  /** Undefined when the command was aborted, so its outcome is unknown. */
  readonly exit: number | undefined
  readonly output: string
}

/** The host's own records, which the citations are checked against. */
export interface World {
  /**
   * A file's content; undefined when it is missing or may not be cited. Missing
   * and not citable must look the same, or the answer tells what the agent may
   * not read.
   */
  readonly file: (path: string) => string | undefined
  /** The checks the loop ran for this verification and listed (verify.checks): the only citable ones. */
  readonly checks: ReadonlyArray<Check>
  /**
   * Other commands the host ran in the session (a user-run shell part the loop did
   * not list). Never evidence, but one that failed or did not finish still blocks
   * a PASS.
   */
  readonly unlisted?: ReadonlyArray<Check>
  /** The host's diff since the loop started; undefined when there is none. */
  readonly diff: string | undefined
  /** The acceptance criteria the user declared; the verifier must judge each, as written. */
  readonly criteria?: ReadonlyArray<string>
}

export interface Result {
  /** Why the submission is not accepted as submitted; empty when it is. */
  readonly errors: string[]
  /** What is stored: the submission, or on the last one what survives the check. Undefined when nothing can be. */
  readonly verdict: Verdict | undefined
  /** A PASS stored as PARTIAL because what it claimed is not supported by the host's records. */
  readonly downgraded: boolean
}

/**
 * Checks a submission. With `final: false` (submissions left) any error rejects
 * it, so the verifier can fix it. With `final: true` the citations that do not
 * check out are dropped, a criterion or todo left without evidence is no longer
 * met, a declared criterion the verdict skipped is added as unknown, and a PASS
 * that is then unsupported, or that a failed check contradicts, is stored as
 * PARTIAL with what is missing.
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

  const todos = (input.todos ?? []).map((todo) => {
    const cited = (todo.evidence ?? []).map((evidence) => ({ evidence, error: citation(evidence, world) }))
    for (const item of cited) if (item.error) errors.push(`todo "${todo.content}": ${item.error}`)
    if (todo.status === "met" && cited.length === 0) errors.push(`todo "${todo.content}": met, but cites no evidence`)
    return { todo, cited }
  })

  const skipped = (world.criteria ?? [])
    .map((text, index) => ({ text, id: fresh(`declared-${index + 1}`, seen) }))
    .filter((declared) => !input.criteria.some((criterion) => same(criterion.text, declared.text)))
  for (const declared of skipped)
    errors.push(`the declared criterion "${declared.text}" is not judged: judge it, with its text as written`)

  for (const item of input.missing)
    if (!seen.has(item.criterion)) errors.push(`missing evidence names ${item.criterion}, which is not a criterion here`)

  errors.push(...consistency(input.verdict, input.criteria))
  // every check the host ran blocks a PASS when it failed or did not finish,
  // whether the loop listed it (citable) or not
  const failed = [...world.checks, ...(world.unlisted ?? [])].filter((check) => check.exit !== 0)
  if (input.verdict === "PASS")
    for (const check of failed)
      errors.push(
        check.exit === undefined
          ? `PASS, but check ${check.callID} was aborted`
          : `PASS, but check ${check.callID} exited ${check.exit}`,
      )

  if (errors.length === 0) return { errors, verdict: input, downgraded: false }
  if (!options.final || structural) return { errors, verdict: undefined, downgraded: false }

  // The last submission: keep only what the host's records support.
  const unsupported: { criterion: string; need: string }[] = []
  const criteria = checked.map(({ criterion, cited }): Criterion => {
    const evidence = cited.filter((item) => !item.error).map((item) => item.evidence)
    if (criterion.status !== "met" || evidence.length > 0) return { ...criterion, evidence }
    const reason = cited.find((item) => item.error)?.error ?? "none was cited"
    unsupported.push({ criterion: criterion.id, need: `evidence that checks out: ${reason}` })
    return { ...criterion, status: "unknown", evidence }
  })
  for (const declared of skipped) {
    criteria.push({ id: declared.id, text: declared.text, status: "unknown", evidence: [] })
    unsupported.push({ criterion: declared.id, need: "a judgment of this declared criterion, with evidence" })
  }
  // a todo marked met without evidence that checks out is missing evidence too
  const storedTodos = todos.map(({ todo, cited }): Todo => {
    const evidence = cited.filter((item) => !item.error).map((item) => item.evidence)
    if (todo.status !== "met" || evidence.length > 0) return { ...todo, evidence }
    const reason = cited.find((item) => item.error)?.error ?? "none was cited"
    unsupported.push({ criterion: `todo "${todo.content}"`, need: `evidence that checks out: ${reason}` })
    return { ...todo, status: "unknown", evidence }
  })
  const allMet = criteria.every((criterion) => criterion.status === "met")
  // a FAIL or PARTIAL whose criteria are all met contradicts itself: nothing to store
  if (allMet && input.verdict !== "PASS") return { errors, verdict: undefined, downgraded: false }
  const contradicted = input.verdict === "PASS" ? failed : []
  const dropped = unsupported.some((item) => item.criterion.startsWith("todo "))
  const downgraded = input.verdict === "PASS" && (!allMet || contradicted.length > 0 || dropped)
  const verdict: Verdict = {
    ...input,
    verdict: downgraded ? "PARTIAL" : input.verdict,
    criteria,
    missing: [
      ...input.missing.filter((item) => seen.has(item.criterion)),
      ...unsupported,
      ...contradicted.map((check) => ({ criterion: `check ${check.callID}`, need: "a run of it that exits 0" })),
    ],
    ...(input.todos ? { todos: storedTodos } : {}),
  }
  return { errors, verdict, downgraded }
}

/** An id not in `taken`: the given one, or it with a number after it. */
function fresh(id: string, taken: ReadonlySet<string>) {
  if (!taken.has(id)) return id
  let n = 2
  while (taken.has(`${id}-${n}`)) n++
  return `${id}-${n}`
}

function consistency(verdict: Verdict["verdict"], criteria: ReadonlyArray<Criterion>) {
  if (verdict === "PASS")
    return criteria
      .filter((criterion) => criterion.status !== "met")
      .map((criterion) => `PASS, but ${criterion.id} is ${criterion.status}`)
  if (criteria.every((criterion) => criterion.status === "met")) return [`${verdict}, but every criterion is met`]
  return []
}

/** A file citation spans fewer lines than this: a quote must say where, not "somewhere in here". */
export const MAX_CITED_LINES = 40

/** Why a citation does not check out, or undefined when it does. */
function citation(evidence: Evidence, world: World): string | undefined {
  if (evidence.kind === "file") {
    const content = world.file(evidence.path)
    if (content === undefined) return `${evidence.path} cannot be read`
    const [start, end] = evidence.lines
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
      return `lines ${start}-${end} are not a range`
    if (end - start + 1 >= MAX_CITED_LINES)
      return `lines ${start}-${end} span ${end - start + 1} lines: cite fewer than ${MAX_CITED_LINES}`
    const lines = content.split(/\r?\n/)
    if (end > lines.length) return `lines ${start}-${end} are outside ${evidence.path} (${lines.length} lines)`
    const quote = normalize(evidence.quote)
    if (quote === "") return "the quote is empty"
    const weak = specific(quote, "quote")
    if (weak) return weak
    if (!normalize(lines.slice(start - 1, end).join("\n")).includes(quote))
      return `the quote is not in ${evidence.path} at lines ${start}-${end}`
    return undefined
  }
  if (evidence.kind === "check") {
    const check = world.checks.find((item) => item.callID === evidence.callID)
    if (!check) return `there is no check ${evidence.callID} in this verification`
    if (check.exit === undefined) return `check ${evidence.callID} has no exit code (it was aborted)`
    if (check.exit !== evidence.exit) return `check ${evidence.callID} exited ${check.exit}, not ${evidence.exit}`
    const excerpt = normalize(evidence.excerpt)
    const weak = excerpt === "" ? undefined : specific(excerpt, "excerpt")
    if (weak) return weak
    if (excerpt === "" || !normalize(check.output).includes(excerpt))
      return `the excerpt is not in the output of check ${evidence.callID}`
    const whole = check.output
      .split(/\r?\n/)
      .map(normalize)
      .some((line) => line !== "" && excerpt.includes(line))
    if (!whole) return `the excerpt must contain at least one whole line of the output of check ${evidence.callID}`
    return undefined
  }
  if (!world.diff) return "there is no host diff for this verification"
  const file = evidence.path.replaceAll("\\", "/")
  const section = sections(world.diff).find((item) => item.paths.includes(file))
  if (!section) return `the diff does not touch ${evidence.path}`
  const excerpt = normalize(evidence.excerpt)
  const weak = excerpt === "" ? undefined : specific(excerpt, "excerpt")
  if (weak) return weak
  if (excerpt === "" || !normalize(section.changed).includes(excerpt))
    return `the excerpt is not in the diff for ${evidence.path}`
  return undefined
}

/**
 * A unified diff split by file: the paths from each `diff --git a/<old> b/<new>`
 * header, and the changed lines (+ and -) after the section's first hunk header.
 * The headers, the hunk headers and the context lines are not evidence: they
 * name the file or repeat what was already there.
 */
export function sections(diff: string) {
  return diff
    .split(/^(?=diff --git )/m)
    .map((text) => {
      const header = text.match(/^diff --git a\/(.+?) b\/(.+)$/m)
      const lines = text.split(/\r?\n/)
      const hunk = lines.findIndex((line) => line.startsWith("@@"))
      const changed =
        hunk === -1
          ? ""
          : lines
              .slice(hunk)
              .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("@@"))
              .join("\n")
      return { paths: header ? [header[1]!, header[2]!.trimEnd()] : [], text, changed }
    })
    .filter((section) => section.paths.length > 0)
}

/** Whitespace, line endings and indentation do not matter. */
function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

/** Whether two criterion texts are the same criterion: case and spacing aside. */
function same(a: string, b: string) {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase()
}

/**
 * Why a quote or excerpt is too unspecific to be evidence, or undefined. A brace,
 * a dot or one short word is in nearly every file and output: it needs two words,
 * or eight letters and digits.
 */
function specific(text: string, what: "quote" | "excerpt") {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
  if (words.length === 0) return `the ${what} has no words or numbers in it`
  if (words.length >= 2 || words.join("").length >= 8) return undefined
  return `the ${what} is too short to be evidence: cite at least two words, or eight letters and digits`
}

export * as Verdict from "./verdict"
