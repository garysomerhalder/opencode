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

const server: Plugin = async (input: PluginInput, rawOptions?: PluginOptions) => {
  const options = (rawOptions ?? {}) as AdaptiveEffortOptions
  if (options.enabled === false) return {}
  const client = input.client

  const classifierSessions = new Set<string>()

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

  async function classifyWithModel(text: string): Promise<Decision | undefined> {
    const model = await resolveSmallModel()
    if (!model) return undefined
    try {
      const created = await client.session.create({ body: { title: "adaptive-effort-classifier" } })
      const sessionID = created.data?.id
      if (!sessionID) return undefined
      classifierSessions.add(sessionID)
      try {
        const response = await client.session.prompt({
          path: { id: sessionID },
          body: {
            model,
            agent: CLASSIFIER_AGENT,
            parts: [
              {
                type: "text",
                text:
                  "Classify the following task by how much reasoning it needs. " +
                  "Respond with exactly one word from: trivial, easy, medium, hard. " +
                  "Then on a second line respond with exactly one word from: main, small, " +
                  'where "small" means the task is I/O-heavy grunt work (reading/summarizing files, ' +
                  "boilerplate, renaming, formatting) that a small model can handle.\n\n" +
                  `Task:\n${text}`,
              },
            ],
          },
        })
        const parts = response.data?.parts ?? []
        const answer = parts
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        return parseClassification(answer)
      } finally {
        classifierSessions.delete(sessionID)
        await client.session.delete({ path: { id: sessionID } }).catch(() => {})
      }
    } catch {
      return undefined
    }
  }

  const hooks: Hooks = {
    "chat.message": async (msg, output) => {
      if (classifierSessions.has(msg.sessionID)) return
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
  }

  return hooks
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
