import type {
  CalculatedTokenUsageCost,
  TokenUsageCostInput,
} from "../types/pricing"
import type { ImageTokenDetails } from "../types/token-usage"
import { normalizeToken } from "./normalize"

// USD per million tokens, checked 2026-10-30. These are API price estimates
// for Codex subscription usage, not charges to the subscription account.
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/guides/image-generation
const IMAGE_PRICES = {
  textInput: 5,
  imageInput: 8,
  imageOutput: 30,
}
const IMAGE_MODELS = new Set([
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
])

function splitTokens(
  total: number | null | undefined,
  details: ImageTokenDetails | undefined,
  defaultModality: "text" | "image",
): { image: number; text: number } {
  const tokens = normalizeToken(total)
  if (details?.image_tokens !== undefined) {
    const image = Math.min(tokens, normalizeToken(details.image_tokens))
    return { image, text: tokens - image }
  }
  if (details?.text_tokens !== undefined) {
    const text = Math.min(tokens, normalizeToken(details.text_tokens))
    return { image: tokens - text, text }
  }
  return defaultModality === "image" ?
      { image: tokens, text: 0 }
    : { image: 0, text: tokens }
}

export function hasBuiltinImagePricing(model: string): boolean {
  return IMAGE_MODELS.has(
    model
      .trim()
      .toLowerCase()
      .replace(/-\d{4}-\d{2}-\d{2}$/u, ""),
  )
}

export function resolveBuiltinImageCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
  if (!hasBuiltinImagePricing(input.model)) return null

  const prompt = splitTokens(
    input.input_tokens,
    input.input_tokens_details,
    "text",
  )
  const output = splitTokens(
    input.output_tokens,
    input.output_tokens_details,
    "image",
  )
  const totalCostNanos = Math.round(
    (prompt.text * IMAGE_PRICES.textInput
      + prompt.image * IMAGE_PRICES.imageInput
      + output.image * IMAGE_PRICES.imageOutput)
      * 1_000,
  )
  return totalCostNanos > 0 ?
      { currency: "USD", source: "builtin", total_cost_nanos: totalCostNanos }
    : null
}
