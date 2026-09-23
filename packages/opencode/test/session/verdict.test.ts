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
  check: (callID) =>
    ({
      call_tests: { exit: 1, output: "12 pass\n3 fail\nRan 15 tests" },
      call_lint: { exit: 0, output: "no problems" },
    })[callID],
  diff: "diff --git a/src/budget.ts b/src/budget.ts\n+  if (bytes > LIMIT)\n+    return cut(bytes)",
}

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
    const result = Verdict.validate(input, world, { final: false })
    expect(result.errors).toEqual([])
    expect(result.verdict).toEqual(input)
    expect(result.downgraded).toBe(false)
  })

  test("a quote that is not in the file is rejected", () => {
    const result = Verdict.validate(pass([fileCite("if (bytes > MAX)")]), world, { final: false })
    expect(result.errors).toEqual(["C1: the quote is not in src/budget.ts at lines 2-3"])
    expect(result.verdict).toBeUndefined()
  })

  test("a quote that is in the file but outside the cited lines is rejected", () => {
    const result = Verdict.validate(pass([fileCite("export function budget", [2, 4])]), world, { final: false })
    expect(result.errors).toEqual(["C1: the quote is not in src/budget.ts at lines 2-4"])
  })

  test("whitespace and line endings do not matter; the file must exist and the lines must be in it", () => {
    const readme: Verdict.Evidence = {
      kind: "file",
      path: "README.md",
      lines: [3, 3],
      quote: "Pass `--budget`   to cap",
    }
    expect(Verdict.validate(pass([readme]), world, { final: false }).errors).toEqual([])
    expect(Verdict.validate(pass([{ ...readme, path: "docs/missing.md" }]), world, { final: false }).errors).toEqual([
      "C1: docs/missing.md cannot be read",
    ])
    expect(Verdict.validate(pass([fileCite("cut", [3, 9])]), world, { final: false }).errors).toEqual([
      "C1: lines 3-9 are outside src/budget.ts (4 lines)",
    ])
    expect(Verdict.validate(pass([fileCite("   ")]), world, { final: false }).errors).toEqual([
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
      criteria: [{ id: "C2", text: "tests pass", status: "unmet", evidence: [cite("call_tests", 1, "3 fail")] }],
      missing: [],
    }
    expect(Verdict.validate(failing, world, { final: false }).errors).toEqual([])
    const wrongExit = {
      ...failing,
      criteria: [{ ...failing.criteria[0]!, evidence: [cite("call_tests", 0, "3 fail")] }],
    }
    expect(Verdict.validate(wrongExit, world, { final: false }).errors).toEqual([
      "C2: check call_tests exited 1, not 0",
    ])
    const noCheck = { ...failing, criteria: [{ ...failing.criteria[0]!, evidence: [cite("call_x", 1, "3 fail")] }] }
    expect(Verdict.validate(noCheck, world, { final: false }).errors).toEqual([
      "C2: there is no check call_x in this verification",
    ])
    const wrongExcerpt = {
      ...failing,
      criteria: [{ ...failing.criteria[0]!, evidence: [cite("call_tests", 1, "0 fail")] }],
    }
    expect(Verdict.validate(wrongExcerpt, world, { final: false }).errors).toEqual([
      "C2: the excerpt is not in the output of check call_tests",
    ])
  })

  test("a diff citation must be in the host's diff, for a file the diff touches", () => {
    const cite = (path: string, excerpt: string): Verdict.Evidence => ({ kind: "diff", path, excerpt })
    expect(
      Verdict.validate(pass([cite("src/budget.ts", "+ return cut(bytes)")]), world, { final: false }).errors,
    ).toEqual([])
    expect(
      Verdict.validate(pass([cite("src/budget.ts", "+ return all(bytes)")]), world, { final: false }).errors,
    ).toEqual(["C1: the excerpt is not in the diff"])
    expect(Verdict.validate(pass([cite("src/other.ts", "return cut")]), world, { final: false }).errors).toEqual([
      "C1: the diff does not touch src/other.ts",
    ])
    expect(
      Verdict.validate(pass([cite("src/budget.ts", "return cut")]), { ...world, diff: undefined }, { final: false })
        .errors,
    ).toEqual(["C1: there is no host diff for this verification"])
  })
})

describe("Verdict.validate: consistency", () => {
  test("a met criterion must cite evidence, and ids must be unique", () => {
    expect(Verdict.validate(pass([]), world, { final: false }).errors).toEqual(["C1: met, but cites no evidence"])
    const twice: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [
        { id: "C1", text: "a", status: "unmet", evidence: [] },
        { id: "C1", text: "b", status: "unmet", evidence: [] },
      ],
      missing: [],
    }
    expect(Verdict.validate(twice, world, { final: false }).errors).toEqual(["C1: the id is used twice"])
    expect(Verdict.validate({ verdict: "FAIL", criteria: [], missing: [] }, world, { final: false }).errors).toEqual([
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
    expect(Verdict.validate(mixed, world, { final: false }).errors).toEqual(["PASS, but C2 is unknown"])
    const allMet: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [{ id: "C1", text: "capped", status: "met", evidence: [fileCite("return cut(bytes)")] }],
      missing: [],
    }
    expect(Verdict.validate(allMet, world, { final: false }).errors).toEqual(["FAIL, but every criterion is met"])
    expect(Verdict.validate({ ...mixed, verdict: "PARTIAL" }, world, { final: false }).errors).toEqual([])
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
    const result = Verdict.validate(input, world, { final: true })
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
    expect(Verdict.validate(fail, world, { final: true })).toEqual({ errors: [], verdict: fail, downgraded: false })
    const extra = pass([fileCite("return cut(bytes)"), fileCite("nowhere")])
    const result = Verdict.validate(extra, world, { final: true })
    expect(result.verdict).toEqual(pass([fileCite("return cut(bytes)")]))
    expect(result.downgraded).toBe(false)
  })

  test("a FAIL that turns out to have every criterion met, or a malformed verdict, stores nothing", () => {
    const allMet: Verdict.Verdict = {
      verdict: "FAIL",
      criteria: [{ id: "C1", text: "capped", status: "met", evidence: [fileCite("return cut(bytes)")] }],
      missing: [],
    }
    expect(Verdict.validate(allMet, world, { final: true }).verdict).toBeUndefined()
    expect(
      Verdict.validate({ verdict: "PASS", criteria: [], missing: [] }, world, { final: true }).verdict,
    ).toBeUndefined()
  })
})
