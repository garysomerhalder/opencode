// The user message that follows an auto compaction and asks the model to keep
// going. Pure, so the wording and the settings it carries are unit-testable and
// port as-is.
//
// The loop decides whether a turn is autonomous from the newest user message
// (`lastUser.autonomous`), and after a compaction that message is this one. So
// it must carry the turn's `autonomous` flag, or the rest of the turn loses the
// headless section and is told to stop and ask a question nobody can answer.

const OVERFLOW =
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"

const INTERACTIVE =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

const AUTONOMOUS =
  "Continue with the next step. Nobody can answer questions during this run: resolve what you can from the files and tools, take the safest reasonable default for the rest, and record any assumption in your final report."

export function text(input: { overflow?: boolean; autonomous?: boolean }) {
  return (input.overflow ? OVERFLOW : "") + (input.autonomous ? AUTONOMOUS : INTERACTIVE)
}

/** The flag to copy onto a message written for the turn: set only when true, so interactive turns are unchanged. */
export function carry(autonomous: boolean | undefined) {
  return autonomous === true ? { autonomous: true as const } : {}
}

export * as CompactionContinue from "./compaction-continue"
