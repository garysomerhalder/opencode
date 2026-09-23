import path from "path"
import { fileURLToPath } from "url"
import { loadModelsSnapshot } from "./models-snapshot"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

export const modelsData = await loadModelsSnapshot({
  jsonPath: process.env.MODELS_DEV_API_JSON,
  url: process.env.OPENCODE_MODELS_URL || "https://models.dev",
  fetch,
  read: (file) => Bun.file(file).text(),
})
console.log("Loaded models.dev snapshot")
