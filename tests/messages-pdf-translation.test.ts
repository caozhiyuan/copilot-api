import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type {
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
} from "~/lib/types/anthropic"
import type { FilePart, TextPart } from "~/lib/types/chat-completions"

import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import { getProviderModelPdfSupport } from "~/lib/model-pdf-support"
import { createFallbackModel } from "~/lib/provider-model"
import {
  RICH_TOOL_RESULT_MOVED_TEXT,
  translateToOpenAI as translatePayloadToOpenAI,
} from "~/routes/messages/non-stream-translation"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

const pdfBlock: AnthropicDocumentBlock = {
  type: "document",
  source: {
    type: "base64",
    media_type: "application/pdf",
    data: "pdf-data",
  },
  title: "report.pdf",
}
const pdfPart: FilePart = {
  type: "file",
  file: {
    file_data: "data:application/pdf;base64,pdf-data",
    filename: "report.pdf",
  },
}
const unsupportedPdfPart: TextPart = {
  type: "text",
  text: "PDF/document content is not supported by this Chat Completions upstream. Use the available text extracted from the document.",
}

function createPayload(model = "pdf-model"): AnthropicMessagesPayload {
  return {
    model,
    max_tokens: 128,
    messages: [{ role: "user", content: [pdfBlock] }],
  }
}

function installCatalog(input: unknown): void {
  installModelsDevCatalog({
    ...modelsDevCatalogFixture,
    "github-copilot": {
      models: {
        "pdf-model": {
          id: "pdf-model",
          modalities: { input, output: ["text"] },
        },
      },
    },
    catalog: {
      models: {
        "org/pdf-model": {
          id: "org/pdf-model",
          modalities: { input, output: ["text"] },
        },
      },
    },
  })
}

function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  options: {
    provider?: Parameters<typeof getProviderModelPdfSupport>[1]
    toolContentSupportType?: NonNullable<
      Parameters<typeof translatePayloadToOpenAI>[1]
    >["toolContentSupportType"]
  } = {},
) {
  const provider = options.provider ?? { name: "github-copilot" }
  return translatePayloadToOpenAI(payload, {
    supportPdf: getProviderModelPdfSupport(payload.model, provider),
    toolContentSupportType: options.toolContentSupportType,
  })
}

beforeEach(() => installCatalog(["text", "pdf"]))
afterEach(() => installModelsDevCatalog(modelsDevCatalogFixture))

describe("models.dev PDF request translation", () => {
  test.each<[string, string, string]>([
    [
      "dashscope",
      "https://dashscope-intl.aliyuncs.com/compatible-mode",
      "alibaba",
    ],
    ["kimi", "https://api.moonshot.cn/v1", "moonshotai-cn"],
  ])(
    "matches the %s PDF catalog by its official base URL",
    (name, baseUrl, catalogId) => {
      installModelsDevCatalog({
        ...modelsDevCatalogFixture,
        [catalogId]: {
          models: {
            "pdf-model": {
              id: "pdf-model",
              modalities: { input: ["text", "pdf"], output: ["text"] },
            },
          },
        },
      })
      expect(getProviderModelPdfSupport("pdf-model", { name, baseUrl })).toBe(
        true,
      )
      expect(getProviderModelPdfSupport("pdf-model", { name })).toBe(false)
    },
  )
  test.each(["codex", "xai"])(
    "keeps PDF defaults only for uncatalogued Codex models: %s",
    (name) => {
      expect(getProviderModelPdfSupport("unknown-model", { name })).toBe(
        name === "codex",
      )
      expect(
        getProviderModelPdfSupport("unknown-model", {
          name,
          models: { "unknown-model": { supportPdf: false } },
        }),
      ).toBe(false)
    },
  )

  test.each([false, true])(
    "preserves Copilot PDF data with stream=%s",
    (stream) => {
      const translated = translateToOpenAI({ ...createPayload(), stream })

      expect(translated.stream).toBe(stream)
      expect(translated.messages).toEqual([
        { role: "user", content: [pdfPart] },
      ])
    },
  )

  test.each([
    { name: "catalog" },
    { name: "custom", modelsDevProviderId: "catalog" },
  ])("uses the provider catalog for %j", (provider) => {
    const translated = translateToOpenAI(createPayload("org/pdf-model"), {
      provider,
    })

    expect(translated.messages).toEqual([{ role: "user", content: [pdfPart] }])
  })

  test("uses the OpenCode Go catalog for the resolved model", () => {
    const translated = translateToOpenAI(createPayload("gpt-6-luna"), {
      provider: { name: "opencode-go" },
    })

    expect(translated.messages).toEqual([{ role: "user", content: [pdfPart] }])
  })

  test("resolves catalog metadata and explicit overrides with the selected raw model ID", () => {
    const selectedModel = createFallbackModel("pdf-model")
    expect(
      getProviderModelPdfSupport(
        "client-alias",
        { name: "github-copilot" },
        selectedModel,
      ),
    ).toBe(true)
    expect(
      getProviderModelPdfSupport(
        "client-alias",
        {
          name: "github-copilot",
          models: { "pdf-model": { supportPdf: false } },
        },
        selectedModel,
      ),
    ).toBe(false)
  })

  test("keeps an explicit false override over catalog PDF support", () => {
    const translated = translateToOpenAI(createPayload(), {
      provider: {
        name: "github-copilot",
        models: { "pdf-model": { supportPdf: false } },
      },
    })

    expect(translated.messages).toEqual([
      { role: "user", content: [unsupportedPdfPart] },
    ])
  })

  test("keeps an explicit true override when the model is absent from the catalog", () => {
    const translated = translateToOpenAI(createPayload("unknown-model"), {
      provider: {
        name: "unknown-provider",
        models: { "unknown-model": { supportPdf: true } },
      },
    })

    expect(translated.messages).toEqual([{ role: "user", content: [pdfPart] }])
  })

  test("does not use another provider's PDF capability for the same model ID", () => {
    const translated = translateToOpenAI(createPayload(), {
      provider: { name: "unknown-provider" },
    })

    expect(translated.messages).toEqual([
      { role: "user", content: [unsupportedPdfPart] },
    ])
  })

  test.each([undefined, null, "text,pdf", {}, ["text", "image"]])(
    "downgrades PDFs when catalog input modalities are %j",
    (input) => {
      installCatalog(input)
      const translated = translateToOpenAI(createPayload())

      expect(translated.messages).toEqual([
        { role: "user", content: [unsupportedPdfPart] },
      ])
    },
  )

  test("keeps the default filename for untitled catalog-supported PDFs", () => {
    const payload = createPayload()
    payload.messages = [
      { role: "user", content: [{ ...pdfBlock, title: null }] },
    ]

    expect(translateToOpenAI(payload).messages).toEqual([
      {
        role: "user",
        content: [
          { ...pdfPart, file: { ...pdfPart.file, filename: "document.pdf" } },
        ],
      },
    ])
  })

  test("moves catalog-supported PDFs from tool results to user messages", () => {
    const payload = createPayload()
    payload.messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-pdf",
            content: [pdfBlock],
          },
          { type: "text", text: "Summarize the document" },
        ],
      },
    ]

    expect(translateToOpenAI(payload).messages).toEqual([
      {
        role: "tool",
        tool_call_id: "read-pdf",
        content: RICH_TOOL_RESULT_MOVED_TEXT,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Tool result for read-pdf:" }, pdfPart],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Summarize the document" }],
      },
    ])
  })

  test("keeps PDFs in tool results when PDF tool content is supported", () => {
    const payload = createPayload("org/pdf-model")
    payload.messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-pdf",
            content: [pdfBlock],
          },
        ],
      },
    ]

    expect(
      translateToOpenAI(payload, {
        provider: { name: "custom", modelsDevProviderId: "catalog" },
        toolContentSupportType: ["pdf"],
      }).messages,
    ).toEqual([{ role: "tool", tool_call_id: "read-pdf", content: [pdfPart] }])
  })
})
