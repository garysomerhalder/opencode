import { describe, expect, test } from "bun:test"
import { Receipt } from "@/tool/receipt"

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line${i + 1}`).join("\n")
const bytes = (text: string) => Buffer.byteLength(text, "utf-8")

describe("Receipt.preview", () => {
  test("keeps the tail: an error on the last line of a 5000-line output is in the preview", () => {
    const text = numbered(4999) + "\nerror: build failed at step 12"
    const p = Receipt.preview(text, { maxLines: 60, maxBytes: 50 * 1024 })
    const shown = Receipt.body(p)
    expect(shown).toContain("line1\n")
    expect(shown).toContain("error: build failed at step 12")
    expect(p.unit).toBe("lines")
    expect(p.shown).toEqual([
      [1, 30],
      [4971, 5000],
    ])
    expect(p.omitted).toBe(4940)
    expect(shown).toContain("... 4940 lines not shown ...")
  })

  test("direction head keeps only the beginning, as before", () => {
    const p = Receipt.preview(numbered(10), { maxLines: 3, maxBytes: 50 * 1024, direction: "head" })
    expect(p.head).toBe("line1\nline2\nline3")
    expect(p.tail).toBe("")
    expect(p.shown).toEqual([[1, 3]])
    expect(Receipt.body(p)).toBe("line1\nline2\nline3\n\n... 7 lines not shown ...")
  })

  test("direction tail keeps only the end, as before", () => {
    const p = Receipt.preview(numbered(10), { maxLines: 3, maxBytes: 50 * 1024, direction: "tail" })
    expect(p.head).toBe("")
    expect(p.tail).toBe("line8\nline9\nline10")
    expect(p.shown).toEqual([[8, 10]])
    expect(Receipt.body(p)).toBe("... 7 lines not shown ...\n\nline8\nline9\nline10")
  })

  test("the preview including the marker is within maxBytes", () => {
    const text = Array.from({ length: 3000 }, (_, i) => `${i}: ${"x".repeat(i % 97)}`).join("\n")
    for (const maxBytes of [200, 1000, 4096, 10_000]) {
      for (const direction of ["both", "head", "tail"] as const) {
        const p = Receipt.preview(text, { maxLines: 2000, maxBytes, direction })
        expect(bytes(Receipt.body(p))).toBeLessThanOrEqual(maxBytes)
      }
    }
  })

  test("a single line longer than the budget is previewed in bytes, UTF-8 safe", () => {
    const text = "é".repeat(5000) + "END"
    const p = Receipt.preview(text, { maxLines: 2000, maxBytes: 1000 })
    expect(p.unit).toBe("bytes")
    expect(p.tail.endsWith("END")).toBe(true)
    expect(p.head.startsWith("é")).toBe(true)
    expect(p.head).not.toContain("�")
    expect(bytes(Receipt.body(p))).toBeLessThanOrEqual(1000)
    const total = bytes(text)
    expect(p.shown[0]).toEqual([1, bytes(p.head)])
    expect(p.shown[1]).toEqual([total - bytes(p.tail) + 1, total])
    expect(p.omitted).toBe(total - bytes(p.head) - bytes(p.tail))
  })

  test("is deterministic", () => {
    const text = numbered(9000)
    expect(Receipt.preview(text, { maxLines: 100, maxBytes: 4096 })).toEqual(
      Receipt.preview(text, { maxLines: 100, maxBytes: 4096 }),
    )
  })
})

describe("Receipt.envelope", () => {
  const text = numbered(20411)
  const p = Receipt.preview(text, { maxLines: 120, maxBytes: 50 * 1024 })
  const archive = Receipt.archive({ path: "/tmp/tool_abc", text, preview: p })
  const out = Receipt.envelope({ tool: "bash", call: "call_1", archive, preview: p })

  test("bytes, lines and shown match the input", () => {
    expect(archive.bytes).toBe(bytes(text))
    expect(archive.lines).toBe(20411)
    expect(archive.shown).toEqual([
      [1, 60],
      [20352, 20411],
    ])
    expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out.split("\n")[0]).toBe(
      `<tool-output-archived tool="bash" call="call_1" bytes="${bytes(text)}" lines="20411" shown="lines 1-60, 20352-20411">`,
    )
  })

  test("the path in the text is the archive's path, with the next unseen line to read", () => {
    expect(out).toContain("Full output: /tmp/tool_abc")
    expect(out).toContain('read({ filePath: "/tmp/tool_abc", offset: 61, limit: 400 })')
  })

  test("says the tool already ran and not to rerun it", () => {
    expect(out).toContain("The tool already ran. Do not rerun it to see more output.")
    expect(out.endsWith("</tool-output-archived>")).toBe(true)
  })

  test("suggests delegating only when the agent can", () => {
    expect(out).not.toContain("Task tool")
    expect(Receipt.envelope({ archive, preview: p, delegate: true })).toContain("Task tool")
  })

  test("quotes in attributes are escaped", () => {
    expect(Receipt.envelope({ tool: 'a"b', archive, preview: p })).toContain('tool="a&quot;b"')
  })
})

describe("Receipt.pruned", () => {
  test("one line with the tool, the size and the path", () => {
    expect(Receipt.pruned({ tool: "bash", bytes: 8397, path: "/tmp/tool_x" })).toBe(
      "[Tool output archived: bash, 8.2 KB, /tmp/tool_x. Read it again with read or grep if you need it; do not rerun.]",
    )
  })
})
