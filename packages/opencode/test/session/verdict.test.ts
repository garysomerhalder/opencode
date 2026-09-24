// Accuracy E, phase 2: the verifier's verdict is accepted only when its citations check out.
import { describe, expect, test } from "bun:test"
import { Verdict } from "../../src/session/verdict"

const files: Record<string, string> = {
  "src/budget.ts": [
    "export function budget(bytes: number) {",
    "  if (bytes > LIMIT)",
    "    return cut(bytes)",
    "}",
  ].join("\n"),
  "README.md": "# Tool\r\n\r\nPass `--budget` to cap the output.\r\n",
}
const world: Verdict.World = {
  file: (path) => files[path],
  checks: [
    { callID: "call_tests", exit: 1, output: "12 pass\n3 fail\nRan 15 tests" },
    { callID: "call_lint", exit: 0, output: "no problems" },
  ],
  // as `git diff` writes it
  diff: [
    "diff --git a/src/budget.ts b/src/budget.ts",
    "index 83db48f..bf269f4 100644",
    "--- a/src/budget.ts",
    "+++ b/src/budget.ts",
    "@@ -1,2 +1,4 @@",
    " export function budget(bytes: number) {",
    "+  if (bytes > LIMIT)",
    "+    return cut(bytes)",
    " }",
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,3 @@",
    " # Tool",
    "+",
    "+Pass `--budget` to cap the output.",
  ].join("\n"),
}
// the checks all passed: a PASS is not held back by a failing one
const passing: Verdict.World = { ...world, checks: [{ callID: "call_lint", exit: 0, output: "no problems" }] }

const fileCite = (quote: string, lines: [number, number] = [2, 3]): Verdict.Evidence => ({
  kind: "file",
  path: "src/budget.ts",
  lines,
  quote,
})

const pass = (evidence: Verdict.Evidence[]): Verdict.Verdict => ({
  verdict: "PASS",
  criteria: [{ id: "C1", text: "the output is capped", status: "met", evidence }],
  missing: [],
})

describe("Verdict.validate: citations", () => {
  test("a PASS whose quote is in the file at the cited lines is accepted as is", () => {
    const input = pass([fileCite("if (bytes > LIMIT) return cut(bytes)")])
    const result = Verdict.validate(input, passing, { final: false })
    expect(result.errors).toEqual([])
    expect(result.verdict).toEqual(input)
    expect(result.downgraded).toBe(false)
  })

  test("a quote that is not in the file is rejected", () => {
    const result = Verdict.validate(pass([fileCite("if (bytes > MAX)")]), passing, { final: false })
    expect(result.errors).toEqual(["C1: the quote is not in src/budget.ts at lines 2-3"])
    expect(result.verdict).toBeUndefined()
  })

  test("a quote that is in the file but outside the cited lines is rejected", () => {
    const result = Verdict.validate(pass([fileCite("export function budget", [2, 4])]), passing, { final: false })
    expect(result.errors).toEqual(["C1: the quote is not in src/budget.ts at lines 2-4"])
  })

  test("whitespace and line endings do not matter; the file must exist and the lines must be in it", () => {
    const readme: Verdict.Evidence = {
      kind: "file",
      path: "README.md",
      lines: [3, 3],
      quote: "Pass `--budget`   to cap",
    }
    expect(Verdict.validate(pass([readme]), passing, { final: false }).errors).toEqual([])
    expect(Verdict.validate(pass([{ ...readme, path: "docs/missing.md" }]), passing, { final: false }).errors).toEqual([
      "C1: docs/missing.md cannot be read",
    ])
    expect(Verdict.validate(pass([fileCite("cut", [3, 9])]), passing, { final: false }).errors).toEqual([
      "C1: lines 3-9 are outside src/budget.ts (4 lines)",
    ])
    expect(Verdict.validate(pass([fileCite("   ")]), passing, { final: false }).errors).toEqual([
      "C1: the quote is empty",
    ])
  })

  test("a check citation needs the check's call id, its exit code and an excerpt of its output", () => {
    const cite = (callID: string, exit: number, excerpt: string): Verdict.Evidence => ({
      kind: "check",
      callID,
      exit,
      excerpt,
    })
    const failing: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [{ id: "C2", text: "tests pass", status: "unmet", evidence: [cite("call_tests", 1, "12 pass 3 fail")] }],
      missing: [],
    }
    expect(Verdict.validate(failing, world, { final: false }).errors).toEqual([])
    const wrongExit = {
      ...failing,
      criteria: [{ ...failing.criteria[0]!, evidence: [cite("call_tests", 0, "12 pass 3 fail")] }],
    }
    expect(Verdict.validate(wrongExit, world, { final: false }).errors).toEqual([
      "C2: check call_tests exited 1, not 0",
    ])
    const noCheck = { ...failing, criteria: [{ ...failing.criteria[0]!, evidence: [cite("call_x", 1, "12 pass 3 fail")] }] }
    expect(Verdict.validate(noCheck, world, { final: false }).errors).toEqual([
      "C2: there is no check call_x in this verification",
    ])
    const wrongExcerpt = {
      ...failing,
      criteria: [{ ...failing.criteria[0]!, evidence: [cite("call_tests", 1, "12 pass 0 fail")] }],
    }
    expect(Verdict.validate(wrongExcerpt, world, { final: false }).errors).toEqual([
      "C2: the excerpt is not in the output of check call_tests",
    ])
    const aborted: Verdict.World = { ...world, checks: [{ callID: "call_tests", exit: undefined, output: "3 fail" }] }
    expect(Verdict.validate(failing, aborted, { final: false }).errors).toEqual([
      "C2: check call_tests has no exit code (it did not finish)",
    ])
  })

  // The architect's rule for phase 2: the model's own text never stands in for evidence.
  test("a quote or excerpt with no words or numbers in it is not evidence", () => {
    expect(Verdict.validate(pass([fileCite(")", [3, 3])]), passing, { final: false }).errors).toEqual([
      "C1: the quote has no words or numbers in it",
    ])
    const dots: Verdict.Evidence = { kind: "check", callID: "call_lint", exit: 0, excerpt: " ... " }
    expect(Verdict.validate(pass([dots]), passing, { final: false }).errors).toEqual([
      "C1: the excerpt has no words or numbers in it",
    ])
  })

  test("a diff citation must be in the host's diff, for a file the diff touches", () => {
    const cite = (path: string, excerpt: string): Verdict.Evidence => ({ kind: "diff", path, excerpt })
    expect(
      Verdict.validate(pass([cite("src/budget.ts", "+ return cut(bytes)")]), passing, { final: false }).errors,
    ).toEqual([])
    expect(
      Verdict.validate(pass([cite("src/budget.ts", "+ return all(bytes)")]), passing, { final: false }).errors,
    ).toEqual(["C1: the excerpt is not in the diff for src/budget.ts"])
    expect(Verdict.validate(pass([cite("src/other.ts", "return cut")]), passing, { final: false }).errors).toEqual([
      "C1: the diff does not touch src/other.ts",
    ])
    // the excerpt must be in the cited file's part of the diff, not anywhere in it
    expect(
      Verdict.validate(pass([cite("README.md", "return cut(bytes)")]), passing, { final: false }).errors,
    ).toEqual(["C1: the excerpt is not in the diff for README.md"])
    // a path named only inside another file's lines is not a file the diff touches
    expect(Verdict.validate(pass([cite("LIMIT", "if (bytes > LIMIT)")]), passing, { final: false }).errors).toEqual([
      "C1: the diff does not touch LIMIT",
    ])
    // review finding 1: only changed lines are evidence, not the headers or context
    for (const excerpt of [
      "diff --git a/src/budget.ts b/src/budget.ts",
      "index 83db48f..bf269f4 100644",
      "+++ b/src/budget.ts",
      "--- a/src/budget.ts",
      "@@ -1,2 +1,4 @@ export function budget",
      "export function budget(bytes: number) {",
    ])
      expect([excerpt, Verdict.validate(pass([cite("src/budget.ts", excerpt)]), passing, { final: false }).errors]).toEqual([
        excerpt,
        ["C1: the excerpt is not in the diff for src/budget.ts"],
      ])
    expect(
      Verdict.validate(pass([cite("src/budget.ts", "return cut")]), { ...passing, diff: undefined }, { final: false })
        .errors,
    ).toEqual(["C1: there is no host diff for this verification"])
  })
})

describe("Verdict.validate: consistency", () => {
  test("a met criterion must cite evidence, and ids must be unique", () => {
    expect(Verdict.validate(pass([]), passing, { final: false }).errors).toEqual(["C1: met, but cites no evidence"])
    const twice: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [
        { id: "C1", text: "a", status: "unmet", evidence: [] },
        { id: "C1", text: "b", status: "unmet", evidence: [] },
      ],
      missing: [],
    }
    expect(Verdict.validate(twice, passing, { final: false }).errors).toEqual(["C1: the id is used twice"])
    expect(Verdict.validate({ verdict: "FAIL", criteria: [], missing: [] }, passing, { final: false }).errors).toEqual([
      "no criteria: list the criteria you judged",
    ])
  })

  test("the verdict must agree with the criteria", () => {
    const mixed: Verdict.Verdict = {
      verdict: "PASS",
      criteria: [
        { id: "C1", text: "capped", status: "met", evidence: [fileCite("return cut(bytes)")] },
        { id: "C2", text: "documented", status: "unknown", evidence: [] },
      ],
      missing: [{ criterion: "C2", need: "a README section naming --budget" }],
    }
    expect(Verdict.validate(mixed, passing, { final: false }).errors).toEqual(["PASS, but C2 is unknown"])
    const allMet: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [{ id: "C1", text: "capped", status: "met", evidence: [fileCite("return cut(bytes)")] }],
      missing: [],
    }
    expect(Verdict.validate(allMet, passing, { final: false }).errors).toEqual(["FAIL, but every criterion is met"])
    expect(Verdict.validate({ ...mixed, verdict: "PARTIAL" }, passing, { final: false }).errors).toEqual([])
  })
})

describe("Verdict.validate: the last submission", () => {
  test("an unsupported PASS is stored as PARTIAL, with the unsupported criteria as missing evidence", () => {
    const input: Verdict.Verdict = {
      verdict: "PASS",
      criteria: [
        { id: "C1", text: "capped", status: "met", evidence: [fileCite("return cut(bytes)")] },
        { id: "C2", text: "documented", status: "met", evidence: [fileCite("the README says so")] },
      ],
      missing: [],
    }
    const result = Verdict.validate(input, passing, { final: true })
    expect(result.errors).toEqual(["C2: the quote is not in src/budget.ts at lines 2-3"])
    expect(result.downgraded).toBe(true)
    expect(result.verdict).toEqual({
      verdict: "PARTIAL",
      criteria: [
        input.criteria[0]!,
        // the citation that did not check out is dropped, never counted
        { id: "C2", text: "documented", status: "unknown", evidence: [] },
      ],
      missing: [{ criterion: "C2", need: "evidence that checks out: the quote is not in src/budget.ts at lines 2-3" }],
    })
  })

  test("a consistent FAIL is accepted as is; a PASS whose extra citation fails keeps the rest", () => {
    const fail: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [{ id: "C1", text: "tests pass", status: "unmet", evidence: [] }],
      missing: [{ criterion: "C1", need: "a passing test run" }],
    }
    expect(Verdict.validate(fail, passing, { final: true })).toEqual({ errors: [], verdict: fail, downgraded: false })
    const extra = pass([fileCite("return cut(bytes)"), fileCite("nowhere")])
    const result = Verdict.validate(extra, passing, { final: true })
    expect(result.verdict).toEqual(pass([fileCite("return cut(bytes)")]))
    expect(result.downgraded).toBe(false)
  })

  test("a FAIL that turns out to have every criterion met, or a malformed verdict, stores nothing", () => {
    const allMet: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [{ id: "C1", text: "capped", status: "met", evidence: [fileCite("return cut(bytes)")] }],
      missing: [],
    }
    expect(Verdict.validate(allMet, passing, { final: true }).verdict).toBeUndefined()
    expect(
      Verdict.validate({ verdict: "PASS", criteria: [], missing: [] }, passing, { final: true }).verdict,
    ).toBeUndefined()
  })
})

// The verifier's word never replaces the host's records: what the user declared,
// what the checks recorded, and evidence for every "met", todos included.
describe("Verdict.validate: the host's records outrank the verifier's text", () => {
  const capped = { id: "C1", text: "The output is capped", status: "met" as const, evidence: [fileCite("return cut(bytes)")] }
  const declared: Verdict.World = { ...passing, criteria: ["the output is capped", "`--budget` is documented"] }

  test("every declared criterion must be judged, as written", () => {
    const partial: Verdict.Verdict = { verdict: "PASS", criteria: [capped], missing: [] }
    expect(Verdict.validate(partial, declared, { final: false }).errors).toEqual([
      'the declared criterion "`--budget` is documented" is not judged: judge it, with its text as written',
    ])
    const rewritten: Verdict.Verdict = {
      verdict: "PASS",
      criteria: [
        capped,
        {
          id: "C2",
          text: "docs exist",
          status: "met",
          evidence: [{ kind: "file", path: "README.md", lines: [3, 3], quote: "Pass `--budget`" }],
        },
      ],
      missing: [],
    }
    expect(Verdict.validate(rewritten, declared, { final: false }).errors).toEqual([
      'the declared criterion "`--budget` is documented" is not judged: judge it, with its text as written',
    ])
    // case and spacing do not matter
    const judged = {
      ...rewritten,
      criteria: [capped, { ...rewritten.criteria[1]!, text: "`--budget`  IS documented" }],
    }
    expect(Verdict.validate(judged, declared, { final: false })).toEqual({
      errors: [],
      verdict: judged,
      downgraded: false,
    })
  })

  test("on the last submission a PASS that skips a declared criterion is stored as PARTIAL", () => {
    const partial: Verdict.Verdict = { verdict: "PASS", criteria: [capped], missing: [] }
    const result = Verdict.validate(partial, declared, { final: true })
    expect(result.downgraded).toBe(true)
    expect(result.verdict).toEqual({
      verdict: "PARTIAL",
      criteria: [capped, { id: "declared-2", text: "`--budget` is documented", status: "unknown", evidence: [] }],
      missing: [{ criterion: "declared-2", need: "a judgment of this declared criterion, with evidence" }],
    })
  })

  test("a PASS cannot stand while a check run for this verification failed or was aborted", () => {
    expect(Verdict.validate(pass([fileCite("return cut(bytes)")]), world, { final: false }).errors).toEqual([
      "PASS, but check call_tests exited 1",
    ])
    const aborted: Verdict.World = { ...passing, checks: [{ callID: "call_lint", exit: undefined, output: "" }] }
    expect(Verdict.validate(pass([fileCite("return cut(bytes)")]), aborted, { final: false }).errors).toEqual([
      "PASS, but check call_lint did not finish",
    ])
    const result = Verdict.validate(pass([fileCite("return cut(bytes)")]), world, { final: true })
    expect(result.downgraded).toBe(true)
    expect(result.verdict?.verdict).toBe("PARTIAL")
    expect(result.verdict?.missing).toEqual([{ criterion: "check call_tests", need: "a run of it that exits 0" }])
  })

  test("a todo marked met needs evidence that checks out, like a criterion", () => {
    const todo = (status: "met" | "unmet", evidence: Verdict.Evidence[] = []) => ({
      ...pass([fileCite("return cut(bytes)")]),
      todos: [{ content: "cap the output", status, evidence }],
    })
    expect(Verdict.validate(todo("met"), passing, { final: false }).errors).toEqual([
      'todo "cap the output": met, but cites no evidence',
    ])
    expect(Verdict.validate(todo("met", [fileCite("nowhere at all")]), passing, { final: false }).errors).toEqual([
      'todo "cap the output": the quote is not in src/budget.ts at lines 2-3',
    ])
    expect(Verdict.validate(todo("met", [fileCite("return cut(bytes)")]), passing, { final: false }).errors).toEqual(
      [],
    )
    expect(Verdict.validate(todo("unmet"), passing, { final: false }).errors).toEqual([])
    // on the last submission the unsupported mark is dropped, not kept, and (review
    // finding 7) it is missing evidence: a PASS is stored as PARTIAL
    const result = Verdict.validate(todo("met", [fileCite("nowhere at all")]), passing, { final: true })
    expect(result.verdict?.todos).toEqual([{ content: "cap the output", status: "unknown", evidence: [] }])
    expect(result.verdict?.verdict).toBe("PARTIAL")
    expect(result.downgraded).toBe(true)
    expect(result.verdict?.missing).toEqual([
      { criterion: 'todo "cap the output"', need: "evidence that checks out: the quote is not in src/budget.ts at lines 2-3" },
    ])
  })

  test("missing evidence must name a criterion the verdict judged", () => {
    const fail: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [{ id: "C1", text: "tests pass", status: "unmet", evidence: [] }],
      missing: [{ criterion: "C9", need: "anything" }],
    }
    expect(Verdict.validate(fail, passing, { final: false }).errors).toEqual([
      "missing evidence names C9, which is not a criterion here",
    ])
  })
})

// Code review of feat/verdict.
describe("Verdict.validate: evidence is specific (review finding 2)", () => {
  const long: Verdict.World = {
    ...passing,
    file: (file) => (file === "long.ts" ? Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") : undefined),
  }
  test("a quote or excerpt needs two words or eight letters and digits", () => {
    for (const quote of ["cut", "c", "(bytes"])
      expect([quote, Verdict.validate(pass([fileCite(quote, [3, 3])]), passing, { final: false }).errors]).toEqual([
        quote,
        ["C1: the quote is too short to be evidence: cite at least two words, or eight letters and digits"],
      ])
    expect(Verdict.validate(pass([fileCite("cut(bytes", [3, 3])]), passing, { final: false }).errors).toEqual([])
  })

  // re-review 2: fragments of words are not words
  test("one-letter fragments do not count, and a quote must start and end on word boundaries", () => {
    expect(Verdict.validate(pass([fileCite("t f", [1, 1])]), passing, { final: false }).errors).toEqual([
      "C1: the quote is too short to be evidence: cite at least two words, or eight letters and digits",
    ])
    for (const quote of ["rt function", "function bud", "urn cut(bytes"])
      expect([quote, Verdict.validate(pass([fileCite(quote, [1, 3])]), passing, { final: false }).errors]).toEqual([
        quote,
        ["C1: the quote is not in src/budget.ts at lines 1-3"],
      ])
    expect(Verdict.validate(pass([fileCite("function budget", [1, 1])]), passing, { final: false }).errors).toEqual([])
  })

  test("a file citation spans fewer than 40 lines", () => {
    const cite = (lines: [number, number]): Verdict.Evidence => ({ kind: "file", path: "long.ts", lines, quote: "line 15" })
    expect(Verdict.validate(pass([cite([1, 40])]), long, { final: false }).errors).toEqual([
      "C1: lines 1-40 span 40 lines: cite fewer than 40",
    ])
    expect(Verdict.validate(pass([cite([1, 39])]), long, { final: false }).errors).toEqual([])
  })

  test("a check excerpt contains at least one whole line of the check's output", () => {
    const failing = (excerpt: string): Verdict.Verdict => ({
      verdict: "FAIL",
      criteria: [
        { id: "C2", text: "tests pass", status: "unmet", evidence: [{ kind: "check", callID: "call_tests", exit: 1, excerpt }] },
      ],
      missing: [],
    })
    expect(Verdict.validate(failing("Ran 15"), world, { final: false }).errors).toEqual([
      "C2: the excerpt must contain at least one whole line of the output of check call_tests",
    ])
    expect(Verdict.validate(failing("12 pass"), world, { final: false }).errors).toEqual([])
    expect(Verdict.validate(failing("12 pass 3 fail"), world, { final: false }).errors).toEqual([])
    // re-review 3: a trivial line (".") is not a whole line that counts
    const dots: Verdict.World = {
      ...world,
      checks: [{ callID: "call_tests", exit: 1, output: "alpha beta gamma\n.\ndelta" }],
    }
    expect(Verdict.validate(failing("gamma . delta"), dots, { final: false }).errors).toEqual([
      "C2: the excerpt must contain at least one whole line of the output of check call_tests",
    ])
    expect(Verdict.validate(failing("alpha beta gamma ."), dots, { final: false }).errors).toEqual([])
  })
})

// re-review 4: a path with " b/" in it
describe("Verdict.sections: the paths of each file in the diff", () => {
  test("taken from the ---/+++ lines, with /dev/null for adds and deletes", () => {
    const diff = [
      "diff --git a/Plan b/secret.txt b/Plan b/secret.txt",
      "index 1111111..2222222 100644",
      "--- a/Plan b/secret.txt",
      "+++ b/Plan b/secret.txt",
      "@@ -1 +1 @@",
      "-KEY old",
      "+KEY new",
      "diff --git a/new file.ts b/new file.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new file.ts",
      "@@ -0,0 +1 @@",
      "+added line here",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed line here",
      "diff --git a/old name.ts b/new name.ts",
      "similarity index 100%",
      "rename from old name.ts",
      "rename to new name.ts",
    ].join("\n")
    expect(Verdict.sections(diff).map((section) => section.paths)).toEqual([
      ["Plan b/secret.txt", "Plan b/secret.txt"],
      ["new file.ts"],
      ["gone.ts"],
      ["old name.ts", "new name.ts"],
    ])
  })
})

describe("Verdict.validate: generated ids (review finding 8)", () => {
  test("an id made for a skipped declared criterion never repeats one the verdict used", () => {
    const declared: Verdict.World = { ...passing, criteria: ["the output is capped", "the README names --budget"] }
    const input: Verdict.Verdict = {
      verdict: "PASS",
      criteria: [{ id: "declared-2", text: "the output is capped", status: "met", evidence: [fileCite("return cut(bytes)")] }],
      missing: [],
    }
    const ids = Validate(input, declared).verdict!.criteria.map((criterion) => criterion.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("Verdict.validate: checks bound to the loop (design ruling)", () => {
  // call_lint is one the loop ran and listed; call_other was run by the user
  // (ranBy "user") but not listed.
  const bound: Verdict.World = {
    ...passing,
    unlisted: [{ callID: "call_other", exit: 0, output: "15 pass" }],
  }
  test("a check the loop did not list is not evidence", () => {
    const cite: Verdict.Evidence = { kind: "check", callID: "call_other", exit: 0, excerpt: "15 pass" }
    expect(Verdict.validate(pass([cite]), bound, { final: false }).errors).toEqual([
      "C1: there is no check call_other in this verification",
    ])
  })

  test("but it still blocks a PASS when it failed or did not finish", () => {
    for (const exit of [1, undefined]) {
      const failed: Verdict.World = { ...passing, unlisted: [{ callID: "call_other", exit, output: "" }] }
      expect(Verdict.validate(pass([fileCite("return cut(bytes)")]), failed, { final: false }).errors).toEqual([
        exit === undefined ? "PASS, but check call_other did not finish" : "PASS, but check call_other exited 1",
      ])
    }
  })
})

function Validate(input: Verdict.Verdict, world: Verdict.World) {
  return Verdict.validate(input, world, { final: true })
}
