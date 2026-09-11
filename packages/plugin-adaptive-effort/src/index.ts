import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { TextPart } from "@opencode-ai/sdk"
import { decide } from "./classify.js"
import type { AdaptiveEffortOptions, ClassifyInput, Decision, Difficulty, Route } from "./types.js"

type Model = { providerID: string; modelID: string }

function parseModel(spec: string): Model | undefined {
  const idx = spec.indexOf("/")
  if (idx <= 0 || idx === spec.length - 1) return undefined
  return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) }
}

const CLASSIFIER_AGENT = "opencode-adaptive-effort-classifier"
const READER_AGENT = "opencode-adaptive-effort-reader"

const DEFAULT_MIN_LINES = 350

const server: Plugin = async (input: PluginInput, rawOptions?: PluginOptions) => {
  const options = (rawOptions ?? {}) as AdaptiveEffortOptions
  if (options.enabled === false) return {}
  const client = input.client

  const delegatedSessions = new Set<string>()

  let smallModel: Model | undefined
  let smallModelResolved = false
  async function resolveSmallModel(): Promise<Model | undefined> {
    if (smallModelResolved) return smallModel
    smallModelResolved = true
    const spec = options.smallModel
    if (spec) {
      smallModel = parseModel(spec)
      return smallModel
    }
    try {
      const config = await client.config.get()
      const configured = config.data?.small_model
      smallModel = configured ? parseModel(configured) : undefined
    } catch {
      smallModel = undefined
    }
    return smallModel
  }

  async function promptOne(model: Model, agent: string, title: string, text: string): Promise<string | undefined> {
    try {
      const created = await client.session.create({ body: { title } })
      const sessionID = created.data?.id
      if (!sessionID) return undefined
      delegatedSessions.add(sessionID)
      try {
        const response = await client.session.prompt({
          path: { id: sessionID },
          body: {
            model,
            agent,
            parts: [{ type: "text", text }],
          },
        })
        const parts = response.data?.parts ?? []
        return parts
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      } finally {
        delegatedSessions.delete(sessionID)
        await client.session.delete({ path: { id: sessionID } }).catch(() => {})
      }
    } catch {
      return undefined
    }
  }

  async function classifyWithModel(text: string): Promise<Decision | undefined> {
    const model = await resolveSmallModel()
    if (!model) return undefined
    const answer = await promptOne(
      model,
      CLASSIFIER_AGENT,
      "adaptive-effort-classifier",
      "Classify the following task by how much reasoning it needs. " +
        "Respond with exactly one word from: trivial, easy, medium, hard. " +
        "Then on a second line respond with exactly one word from: main, small, " +
        'where "small" means the task is I/O-heavy grunt work (reading/summarizing files, ' +
        "boilerplate, renaming, formatting) that a small model can handle.\n\n" +
        `Task:\n${text}`,
    )
    return answer ? parseClassification(answer) : undefined
  }

  async function currentQuestion(sessionID: string): Promise<string | undefined> {
    try {
      const response = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
      const messages = response.data ?? []
      for (const message of [...messages].reverse()) {
        if (message.info.role !== "user") continue
        const text = message.parts
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (text) return text
      }
    } catch {
      return undefined
    }
    return undefined
  }

  async function summarizeRead(content: string, filePath: string, question?: string): Promise<string | undefined> {
    const model = await resolveSmallModel()
    if (!model) return undefined
    const answer = await promptOne(
      model,
      READER_AGENT,
      "adaptive-effort-reader",
      "You are a precise code analyst. Read the file content below and answer the " +
        "caller's question concisely. Output structured bullets only. No greetings, no prose, " +
        "no preambles, no markdown fences. Lead every bullet with the exact symbol name, type, or " +
        "line number. Skip anything the caller did not ask for.\n\n" +
        `Question:\n${question ?? "Summarize the structure and purpose of this file."}\n\n` +
        `File (${filePath}):\n${content}`,
    )
    return answer
  }

  const minLines = options.minLines ?? DEFAULT_MIN_LINES

  const hooks: Hooks = {
    "chat.message": async (msg, output) => {
      if (delegatedSessions.has(msg.sessionID)) return
      if (msg.agent && msg.agent !== "build" && msg.agent !== "general" && msg.agent !== "plan") return

      const text = output.parts
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      if (!text.trim()) return

      const fileCount = output.parts.filter((part) => part.type === "file").length
      const wordCount = text.split(/\s+/).filter(Boolean).length
      const classifyInput: ClassifyInput = { text, fileCount, wordCount }

      let decision = decide(classifyInput, options.efforts ?? {})
      if (options.classifier === "hybrid" && decision.difficulty === "medium") {
        const refined = await classifyWithModel(text)
        if (refined) decision = refined
      }

      const model = output.message.model as Model & { variant?: string }
      const hasExplicitVariant = msg.variant !== undefined && msg.variant !== "default"

      if (decision.route === "small") {
        const small = await resolveSmallModel()
        if (small) {
          model.providerID = small.providerID
          model.modelID = small.modelID
          if (!hasExplicitVariant) delete model.variant
          return
        }
      }

      if (decision.effort !== null && !hasExplicitVariant) {
        model.variant = decision.effort
      }
    },
    "tool.execute.after": async (tool, output) => {
      if (options.read === false) return
      if (tool.tool !== "read") return
      if (delegatedSessions.has(tool.sessionID)) return
      if (tool.args?.offset && tool.args.offset > 1) return
      if (typeof tool.args?.limit === "number" && tool.args.limit <= minLines) return

      const content = output.output
      if (!content) return
      const lineCount = content.split("\n").length
      if (lineCount <= minLines) return

      const filePath = extractPath(content)
      const question = await currentQuestion(tool.sessionID)
      const summary = await summarizeRead(content, filePath ?? "unknown", question)
      if (!summary) return

      output.output = [
        `<path>${filePath ?? "unknown"}</path>`,
        `<type>file</type>`,
        `<system-reminder>File summarized by a small model to conserve context. For exact line references, re-read specific sections using offset and limit.</system-reminder>`,
        `<content>`,
        summary,
        `</content>`,
      ].join("\n")
      output.title = `${filePath ?? "read"} (summarized)`
    },
  }

  return hooks
}

function extractPath(content: string): string | undefined {
  const match = /<path>(.*?)<\/path>/.exec(content)
  return match ? match[1] : undefined
}

function parseClassification(answer: string): Decision | undefined {
  const difficulty = (["trivial", "easy", "medium", "hard"] as const).find((word) =>
    answer.toLowerCase().includes(word),
  )
  if (!difficulty) return undefined
  const route: Route = answer.toLowerCase().includes("small") ? "small" : "main"
  const effort =
    difficulty === "trivial" || difficulty === "easy"
      ? "low"
      : difficulty === "hard"
        ? "high"
        : null
  return { difficulty: difficulty as Difficulty, route, effort }
}

export default { id: "opencode-adaptive-effort", server }
