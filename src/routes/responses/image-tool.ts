import { randomUUID } from "node:crypto"

import type { CopilotImageGenerationConfig } from "~/lib/types/config"
import type {
  FunctionTool,
  ImageGenerationCall,
  ImageGenerationTool,
  ResponsesPayload,
  Tool,
} from "~/lib/types/responses"
import { HTTPError } from "~/lib/http/http-error"

import { executeCopilotToolImage } from "./copilot-tool-images"
import { isRecord } from "./messages-translation/parse"

type ImageReference = { image_url: string } | { file_id: string }
type Choice = ResponsesPayload["tool_choice"]

export interface ImageToolBridge {
  name: string
  run: (
    args: string,
    id: string,
    signal: AbortSignal,
    onPartialImage?: (index: number, base64: string) => Promise<void>,
  ) => Promise<ImageGenerationCall>
  restoreTools: (response: Record<string, unknown>) => void
}

export const newImageCallId = () => `ig_${randomUUID().replaceAll("-", "")}`

function toolError(message: string, status = 400) {
  return new HTTPError(
    message,
    Response.json(
      {
        error: {
          type: status === 400 ? "invalid_request_error" : "upstream_error",
          message,
        },
      },
      { status },
    ),
  )
}

const isImageTool = (tool: Tool): tool is ImageGenerationTool =>
  tool?.type === "image_generation"

function imageReferences(parts: unknown): Array<ImageReference> {
  if (!Array.isArray(parts)) return []
  const images: Array<ImageReference> = []
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "input_image") continue
    if (typeof part.image_url === "string" && part.image_url)
      images.push({ image_url: part.image_url })
    else if (typeof part.file_id === "string" && part.file_id)
      images.push({ file_id: part.file_id })
  }
  return images
}

// Codex replays the generated item in input on later turns. Copilot accepts
// ordinary image inputs; keep the latest group of references for edits.
function prepareImageHistory(
  input: ResponsesPayload["input"],
): Array<ImageReference> {
  if (!Array.isArray(input)) return []
  let images: Array<ImageReference> = []
  let previousWasImageCall = false
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object") continue
    if (item.type === "image_generation_call") {
      const content: Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string }
      > = [
        {
          type: "input_text",
          text:
            typeof item.revised_prompt === "string" && item.revised_prompt ?
              `Previous image generation: ${item.revised_prompt}`
            : "Previous image generation.",
        },
      ]
      if (!previousWasImageCall) images = []
      if (
        item.status === "completed"
        && typeof item.result === "string"
        && item.result
      ) {
        const mime =
          item.output_format === "webp" || item.result.startsWith("UklGR") ?
            "image/webp"
          : item.output_format === "jpeg" || item.result.startsWith("/9j/") ?
            "image/jpeg"
          : "image/png"
        const image_url = `data:${mime};base64,${item.result}`
        images.push({ image_url })
        content.push({ type: "input_image", image_url })
      }
      input[index] = { type: "message", role: "user", content }
      previousWasImageCall = true
    } else if ("role" in item && item.role === "user") {
      const current = imageReferences(item.content)
      if (current.length) images = current
      previousWasImageCall = false
    }
  }
  return images
}

function additionalToolLists(
  input: ResponsesPayload["input"],
): Array<Array<Tool>> {
  if (!Array.isArray(input)) return []
  const lists: Array<Array<Tool>> = []
  for (const item of input) {
    if (item?.type === "additional_tools" && Array.isArray(item.tools))
      lists.push(item.tools)
  }
  return lists
}

// Codex custom providers may advertise only client tools. Offer the hosted
// tool on ordinary tool-enabled turns without widening an explicit choice.
export function offerCodexImageTool(payload: ResponsesPayload): void {
  if (payload.tool_choice != null && payload.tool_choice !== "auto") return
  const lists = [payload.tools ?? [], ...additionalToolLists(payload.input)]
  if (!lists.some((list) => list.length)) return
  const hasHosted = lists.some((list) => list.some(isImageTool))
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0; i--) {
      const tool = list[i]
      if (
        tool?.type !== "namespace"
        || tool.name !== "image_gen"
        || !Array.isArray(tool.tools)
      )
        continue
      const siblings = tool.tools.filter(
        (child: unknown) =>
          !isRecord(child)
          || child.type !== "function"
          || child.name !== "imagegen",
      )
      if (!siblings.length) list.splice(i, 1)
      else if (siblings.length !== tool.tools.length)
        list[i] = { ...tool, tools: siblings }
    }
  }
  if (!hasHosted) (payload.tools ??= []).push({ type: "image_generation" })
}

function bridgeName(lists: Array<Array<Tool>>) {
  const names = new Set<string>()
  const visit = (tool: Tool) => {
    if (!tool || typeof tool !== "object") return
    if ("name" in tool && typeof tool.name === "string") names.add(tool.name)
    if (tool.type === "namespace" && Array.isArray(tool.tools))
      tool.tools.forEach(visit)
  }
  for (const list of lists) list.forEach(visit)
  const base = "copilot_generate_image"
  let name = base
  for (let suffix = 2; names.has(name); suffix++) name = `${base}_${suffix}`
  return name
}

function makeTool(name: string): FunctionTool {
  return {
    type: "function",
    name,
    strict: true,
    description:
      "Generate a new image or edit a supplied image. Use only when the user asks for an image. Write a self-contained prompt describing the desired result.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        action: {
          type: "string",
          enum: ["generate", "edit"],
          description:
            "Choose edit to modify a supplied or previously generated image.",
        },
      },
      required: ["prompt", "action"],
      additionalProperties: false,
    },
  }
}

function acceptsImages(choice: Choice): boolean {
  if (choice === "none") return false
  if (!choice || typeof choice === "string") return true
  return (
    choice.type === "image_generation"
    || (choice.type === "allowed_tools"
      && choice.tools.some((t) => t.type === "image_generation"))
  )
}

function rewriteChoice(choice: Choice, name: string): Choice {
  if (!choice || typeof choice === "string") return choice
  if (choice.type === "image_generation") return { type: "function", name }
  if (choice.type === "allowed_tools")
    return {
      ...choice,
      tools: choice.tools.map((t) =>
        t.type === "image_generation" ? { type: "function", name } : t,
      ),
    }
  return choice
}

export function prepareCopilotImageTool(
  payload: ResponsesPayload,
  config: CopilotImageGenerationConfig,
  execute = executeCopilotToolImage,
): ImageToolBridge | undefined {
  const lists = [payload.tools ?? [], ...additionalToolLists(payload.input)]
  const tool = lists.flatMap((list) => list.filter(isImageTool))[0]
  const originalChoice = payload.tool_choice
  const refs =
    (
      tool
      || (Array.isArray(payload.input)
        && payload.input.some((item) => item?.type === "image_generation_call"))
    ) ?
      prepareImageHistory(payload.input)
    : []
  if (!config.enabled || !tool) {
    if (
      typeof originalChoice === "object"
      && (originalChoice?.type === "image_generation"
        || (originalChoice?.type === "allowed_tools"
          && originalChoice.tools.some((t) => t.type === "image_generation")))
    ) {
      throw toolError(
        config.enabled ?
          "tool_choice requires an image_generation tool"
        : "Copilot image generation is disabled",
      )
    }
    if (tool) {
      for (const list of lists) {
        for (let i = list.length - 1; i >= 0; i--)
          if (isImageTool(list[i])) list.splice(i, 1)
      }
      if (!lists.some((list) => list.length)) {
        if (originalChoice === "required")
          throw toolError("Copilot image generation is disabled")
        delete payload.tool_choice
      }
    }
    return undefined
  }

  const name = bridgeName(lists)
  let declared = false
  const substitute = (list: Array<Tool>): Array<Tool> =>
    list.flatMap((entry): Array<Tool> => {
      if (!isImageTool(entry)) return [entry]
      if (declared) return []
      declared = true
      return [makeTool(name)]
    })
  if (payload.tools) payload.tools = substitute(payload.tools)
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (item?.type === "additional_tools" && Array.isArray(item.tools))
        item.tools = substitute(item.tools)
    }
  }
  if (originalChoice !== undefined)
    payload.tool_choice = rewriteChoice(originalChoice, name)

  return {
    name,
    restoreTools(response) {
      if (Array.isArray(response.tools)) {
        response.tools = response.tools.map((entry: unknown) =>
          isRecord(entry) && entry.type === "function" && entry.name === name ?
            tool
          : entry,
        )
      }
      if (originalChoice !== undefined && "tool_choice" in response)
        response.tool_choice = originalChoice
    },
    async run(args, id, signal, onPartialImage) {
      signal.throwIfAborted()
      if (!acceptsImages(originalChoice))
        throw toolError("Unexpected image tool call for this tool_choice", 502)
      let parsed: unknown
      try {
        parsed = JSON.parse(args)
      } catch {
        /* Invalid upstream arguments. */
      }
      if (
        !isRecord(parsed)
        || typeof parsed.prompt !== "string"
        || !parsed.prompt.trim()
      ) {
        throw toolError(
          "Copilot returned invalid arguments for the image tool",
          502,
        )
      }
      const action =
        tool.action && tool.action !== "auto" ? tool.action
        : parsed.action === "generate" || parsed.action === "edit" ?
          parsed.action
        : "auto"
      return execute({
        model: config.model,
        prompt: parsed.prompt,
        tool: { ...tool, action },
        inputImages: refs,
        id,
        signal,
        onPartialImage,
      })
    },
  }
}

export async function bridgeImageToolJson(
  response: Response,
  bridge: ImageToolBridge,
  signal: AbortSignal,
): Promise<Response> {
  const result: unknown = await response.json()
  if (!isRecord(result) || !Array.isArray(result.output))
    throw toolError("Invalid upstream Responses output", 502)
  bridge.restoreTools(result)
  const calls = new Map<string, ImageGenerationCall>()
  for (const [index, item] of result.output.entries()) {
    if (
      !isRecord(item)
      || item.type !== "function_call"
      || item.name !== bridge.name
      || item.namespace
    )
      continue
    const id = newImageCallId()
    if (
      result.status !== "completed"
      || (item.status && item.status !== "completed")
    ) {
      result.output[index] = {
        type: "image_generation_call",
        id,
        status: "failed",
        result: "",
      }
      continue
    }
    const key =
      typeof item.call_id === "string" && item.call_id ? item.call_id : id
    const image =
      calls.get(key)
      ?? (await bridge.run(
        typeof item.arguments === "string" ? item.arguments : "",
        id,
        signal,
      ))
    calls.set(key, image)
    result.output[index] = image
  }
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return Response.json(result, { headers, status: response.status })
}
