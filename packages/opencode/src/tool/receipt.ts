// Receipts for tool output that was cut before the model saw it (accuracy C,
// technique #5). Pure: no effect services, no file system. The caller archives
// the full text and passes the path in, so this module ports as-is.
//
// A preview keeps the head and the tail of the output by default, because for
// builds, test runs and linters the verdict is at the end. The envelope around
// it says how big the output was, what part is shown, where the full text is,
// and that the tool already ran.

import { createHash } from "crypto"

export type Unit = "lines" | "bytes"
export type Range = readonly [number, number]
export type Direction = "both" | "head" | "tail"

/** Stored on the tool part's metadata as `archive`, so clients and the checkpoint can list receipts without parsing text. */
export interface Archive {
  readonly path: string
  readonly bytes: number
  readonly lines: number
  /** What `shown` counts: whole lines, or bytes when a single line was too long to show whole. */
  readonly unit: Unit
  /** 1-based inclusive ranges of the output that the preview shows. */
  readonly shown: ReadonlyArray<Range>
  readonly sha256: string
}

export interface Preview {
  readonly head: string
  readonly tail: string
  readonly unit: Unit
  readonly shown: ReadonlyArray<Range>
  /** How many lines (or bytes, see unit) are between the head and the tail, or after the head / before the tail. */
  readonly omitted: number
}

export interface Measure {
  readonly bytes: number
  readonly lines: number
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf-8")

export function measure(text: string): Measure {
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return { bytes: byteLength(text), lines }
}

export function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

export function marker(omitted: number, unit: Unit) {
  return `... ${omitted} ${unit} not shown ...`
}

// Bytes the marker and its blank lines can take, whatever the omitted count.
function markerReserve(total: number, unit: Unit) {
  return byteLength(marker(total, unit)) + 4
}

function takePrefix(text: string, maxBytes: number) {
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = byteLength(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

function takeSuffix(text: string, maxBytes: number) {
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const size = byteLength(chars[start - 1])
    if (bytes + size > maxBytes) break
    bytes += size
    start--
  }
  return chars.slice(start).join("")
}

function byBytes(text: string, total: Measure, maxBytes: number, direction: Direction): Preview {
  const budget = Math.max(0, maxBytes - markerReserve(total.bytes, "bytes"))
  const headBudget = direction === "both" ? Math.ceil(budget / 2) : direction === "head" ? budget : 0
  const tailBudget = direction === "both" ? Math.floor(budget / 2) : direction === "tail" ? budget : 0
  const head = headBudget > 0 ? takePrefix(text, headBudget) : ""
  const tail = tailBudget > 0 ? takeSuffix(text, tailBudget) : ""
  const headBytes = byteLength(head)
  const tailBytes = byteLength(tail)
  const shown: Range[] = []
  if (headBytes > 0) shown.push([1, headBytes])
  if (tailBytes > 0) shown.push([total.bytes - tailBytes + 1, total.bytes])
  return { head, tail, unit: "bytes", shown, omitted: total.bytes - headBytes - tailBytes }
}

/**
 * A preview of `text` within `maxLines` content lines and `maxBytes` bytes,
 * counting the marker. Whole lines when possible; when a line at an end that
 * must be shown is longer than the budget, the preview is taken in bytes.
 * Call it only for text that is over one of the limits.
 */
export function preview(text: string, options: { maxLines: number; maxBytes: number; direction?: Direction }): Preview {
  const direction = options.direction ?? "both"
  const total = measure(text)
  const lines = text.split("\n")
  const budget = Math.max(0, options.maxBytes - markerReserve(total.lines, "lines"))
  const maxLines = Math.max(1, options.maxLines)
  const headLines = direction === "both" ? Math.ceil(maxLines / 2) : direction === "head" ? maxLines : 0
  const tailLines = direction === "both" ? Math.floor(maxLines / 2) : direction === "tail" ? maxLines : 0
  const headBudget = direction === "both" ? Math.ceil(budget / 2) : direction === "head" ? budget : 0

  const head: string[] = []
  let used = 0
  for (let i = 0; i < lines.length && head.length < headLines; i++) {
    const size = byteLength(lines[i]) + (head.length > 0 ? 1 : 0)
    if (used + size > headBudget) break
    head.push(lines[i])
    used += size
  }

  const tail: string[] = []
  let tailUsed = 0
  const tailBudget = budget - used
  for (let i = lines.length - 1; i >= head.length && tail.length < tailLines; i--) {
    const size = byteLength(lines[i]) + (tail.length > 0 ? 1 : 0)
    if (tailUsed + size > tailBudget) break
    tail.unshift(lines[i])
    tailUsed += size
  }

  const headMissing = headLines > 0 && head.length === 0
  const tailMissing = tailLines > 0 && tail.length === 0 && lines.length > head.length
  if (headMissing || tailMissing) return byBytes(text, total, options.maxBytes, direction)

  const shown: Range[] = []
  if (head.length > 0) shown.push([1, head.length])
  if (tail.length > 0) shown.push([lines.length - tail.length + 1, lines.length])
  return {
    head: head.join("\n"),
    tail: tail.join("\n"),
    unit: "lines",
    shown,
    omitted: lines.length - head.length - tail.length,
  }
}

export function describeShown(unit: Unit, shown: ReadonlyArray<Range>) {
  if (shown.length === 0) return "none"
  return `${unit} ${shown.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ")}`
}

/** The preview text with the marker between (or after/before) its halves. */
export function body(p: Preview) {
  const mark = marker(p.omitted, p.unit)
  return [p.head, mark, p.tail].filter((section) => section !== "").join("\n\n")
}

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")

function nextLine(archive: Archive) {
  if (archive.unit !== "lines") return 1
  const first = archive.shown[0]
  return first && first[0] === 1 ? first[1] + 1 : 1
}

/**
 * The envelope the model sees for an output that was cut. The same format is
 * used whether the per-call cap or the step budget cut it.
 */
export function envelope(input: {
  readonly tool?: string
  readonly call?: string
  readonly archive: Archive
  readonly preview: Preview
  /** The agent can delegate to a subagent: suggest that instead of reading the archive itself. */
  readonly delegate?: boolean
}) {
  const { archive } = input
  const attributes = [
    ...(input.tool ? [`tool="${attribute(input.tool)}"`] : []),
    ...(input.call ? [`call="${attribute(input.call)}"`] : []),
    `bytes="${archive.bytes}"`,
    `lines="${archive.lines}"`,
    `shown="${describeShown(archive.unit, archive.shown)}"`,
  ].join(" ")
  const read =
    archive.unit === "lines"
      ? `Read more with read({ filePath: "${archive.path}", offset: ${nextLine(archive)}, limit: 400 }) or grep on that path.`
      : `Search it with grep on that path, or read it with read({ filePath: "${archive.path}", offset: 1, limit: 400 }) (long lines are cut there too).`
  return [
    `<tool-output-archived ${attributes}>`,
    body(input.preview),
    "",
    `Full output: ${archive.path}`,
    read,
    ...(input.delegate
      ? [
          "To save context, use the Task tool to have the explore agent search it with Grep and Read (offset/limit) instead of reading it all yourself.",
        ]
      : []),
    "The tool already ran. Do not rerun it to see more output.",
    "</tool-output-archived>",
  ].join("\n")
}

export function archive(input: { path: string; text: string; preview: Preview }): Archive {
  const total = measure(input.text)
  return {
    path: input.path,
    bytes: total.bytes,
    lines: total.lines,
    unit: input.preview.unit,
    shown: input.preview.shown,
    sha256: sha256(input.text),
  }
}

/** The archive of an output the model no longer sees at all (prune): nothing of it is shown. */
export function whole(input: { path: string; text: string }): Archive {
  const total = measure(input.text)
  return {
    path: input.path,
    bytes: total.bytes,
    lines: total.lines,
    unit: "lines",
    shown: [],
    sha256: sha256(input.text),
  }
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One line in place of an output that prune cleared from the model's view. */
export function pruned(input: { tool: string; bytes: number; path: string }) {
  return `[Tool output archived: ${input.tool}, ${size(input.bytes)}, ${input.path}. Read it again with read or grep if you need it; do not rerun.]`
}

export * as Receipt from "./receipt"
