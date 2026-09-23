// A budget across the tool calls of one step (accuracy C, technique #5, part C).
// Pure: the processor gathers the step's tool outputs, `plan` decides how many
// bytes of each the model sees, and the decision is stored on the part. The
// stored output is never rewritten; only the model's view is cut, from an
// archive the part points at.
//
// Off by default: it removes text the model would otherwise see, so it has to
// earn its default in the eval.

import { Receipt } from "../tool/receipt"

export const DEFAULT_STEP_BYTES = 128 * 1024
export const DEFAULT_FLOOR_BYTES = 4 * 1024
/** Line cap of a budgeted preview, the same as the per-call cap's default. */
export const PREVIEW_MAX_LINES = 2000

/** Tools whose full output is the point, or that are already bounded. */
export const EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "skill",
  "todowrite",
  "question",
  "StructuredOutput",
  "shell_output",
])

export interface Settings {
  readonly stepBytes: number
  readonly floorBytes: number
}

export interface Candidate {
  readonly callID: string
  readonly tool: string
  readonly bytes: number
  /** The output is already a receipt (the per-call cap archived it). A receipt is never budgeted again. */
  readonly archived: boolean
}

export interface Decision {
  readonly callID: string
  readonly tool: string
  readonly bytes: number
  readonly maxBytes: number
}

export function eligible(candidate: Candidate) {
  return !candidate.archived && !EXEMPT_TOOLS.has(candidate.tool)
}

/**
 * Lowers the largest outputs first until the step's eligible outputs fit in
 * `stepBytes`: every eligible output above a common cap is cut to that cap.
 * No output is cut below `floorBytes`, even if the step then stays over budget.
 * Deterministic: the same parts give the same decisions in the same order
 * (largest first, then by call id).
 */
export function plan(candidates: ReadonlyArray<Candidate>, settings: Settings): Decision[] {
  const parts = candidates.filter(eligible)
  const total = parts.reduce((sum, part) => sum + part.bytes, 0)
  if (total <= settings.stepBytes) return []

  const ascending = parts.toSorted((a, b) => a.bytes - b.bytes || a.callID.localeCompare(b.callID))
  let remaining = settings.stepBytes
  let cap = Number.POSITIVE_INFINITY
  for (let i = 0; i < ascending.length; i++) {
    const left = ascending.length - i
    if (ascending[i].bytes * left <= remaining) {
      remaining -= ascending[i].bytes
      continue
    }
    cap = Math.floor(remaining / left)
    break
  }
  const limit = Math.max(cap, settings.floorBytes)

  return parts
    .filter((part) => part.bytes > limit)
    .toSorted((a, b) => b.bytes - a.bytes || a.callID.localeCompare(b.callID))
    .map((part) => ({ callID: part.callID, tool: part.tool, bytes: part.bytes, maxBytes: limit }))
}

/** The preview a budgeted output shows. The processor and the model conversion both use it, so they agree. */
export function preview(output: string, maxBytes: number) {
  return Receipt.preview(output, { maxLines: PREVIEW_MAX_LINES, maxBytes })
}

/**
 * What the model sees for a part carrying a stored budget: the envelope, built
 * from the stored output and the stored archive. The same part always gives
 * the same text, which keeps the prompt-cache prefix stable. Undefined when the
 * part has no budget or no archive to point at (nothing to cut to).
 */
export function view(input: {
  readonly tool: string
  readonly callID: string
  readonly output: string
  readonly metadata: Record<string, unknown> | undefined
}) {
  const budget = input.metadata?.budget as { maxBytes?: unknown } | undefined
  const archive = input.metadata?.archive as Partial<Receipt.Archive> | undefined
  if (typeof budget?.maxBytes !== "number" || typeof archive?.path !== "string") return undefined
  if (Buffer.byteLength(input.output, "utf-8") <= budget.maxBytes) return undefined
  const p = preview(input.output, budget.maxBytes)
  const total = Receipt.measure(input.output)
  return Receipt.envelope({
    tool: input.tool,
    call: input.callID,
    archive: {
      path: archive.path,
      bytes: total.bytes,
      lines: total.lines,
      unit: p.unit,
      shown: p.shown,
      sha256: typeof archive.sha256 === "string" ? archive.sha256 : "",
    },
    preview: p,
  })
}

/**
 * The log record for one budgeted output. Sizes and ranges only, never the
 * output: a tool may have printed a secret.
 */
export function record(decision: Decision, input: { shown: string; archived: boolean }) {
  return {
    kind: "output_budget" as const,
    tool: decision.tool,
    bytes: decision.bytes,
    shown: input.shown,
    archived: input.archived,
  }
}

export * as OutputBudget from "./output-budget"
