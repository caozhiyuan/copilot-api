import { describe, expect, test } from "bun:test"
import { encode } from "gpt-tokenizer/encoding/o200k_base"

import { createFallbackModel } from "~/lib/catalog/provider-model"
import { getTokenCount } from "~/lib/catalog/tokenizer"
import type {
  ContentPart,
  FilePart,
  ImagePart,
} from "~/lib/types/chat-completions"

const model = createFallbackModel("gpt-test")
const count = (content: Array<ContentPart>) =>
  getTokenCount(
    { model: model.id, messages: [{ role: "user", content }] },
    model,
  )
const image = (
  url: string,
  detail?: ImagePart["image_url"]["detail"],
): ImagePart => ({
  type: "image_url",
  image_url: { url, detail },
})
const file = (fileData: string, filename?: string): FilePart => ({
  type: "file",
  file: {
    file_data: fileData,
    ...(filename === undefined ? {} : { filename }),
  },
})

describe("image token estimates", () => {
  test.each([
    { detail: "low", expected: 85 },
    { detail: "high", expected: 765 },
    { detail: "auto", expected: 765 },
    { detail: undefined, expected: 765 },
  ] as const)(
    "estimates %j independently of URL length",
    async ({ detail, expected }) => {
      const baseline = await count([])
      const remote = await count([
        image("https://example.com/image.png", detail),
      ])
      const inline = await count([
        image(`data:image/png;base64,${"aGVsbG8=".repeat(16_384)}`, detail),
      ])
      expect(remote.input - baseline.input).toBe(expected)
      expect(inline).toEqual(remote)
    },
  )

  test("adds each image estimate while retaining text tokenization", async () => {
    const text = "Describe these images. 请比较这两张图片。"
    const baseline = await count([])
    const result = await count([
      { type: "text", text },
      image("data:image/png;base64,AAAA", "low"),
      image("https://example.com/image.png", "high"),
    ])
    expect(result.input - baseline.input).toBe(encode(text).length + 85 + 765)
    expect(result.output).toBe(0)
  })

  test("estimates file parts independently of base64 file_data length while tokenizing filename", async () => {
    const baseline = await count([])
    const smallPdf = await count([
      file("data:application/pdf;base64,JVBERi0xLjQK", "report.pdf"),
    ])
    const largePdf = await count([
      file(
        `data:application/pdf;base64,${"JVBERi0xLjQK".repeat(16_384)}`,
        "report.pdf",
      ),
    ])
    const untitledPdf = await count([
      file(`data:application/pdf;base64,${"JVBERi0xLjQK".repeat(4_096)}`),
    ])

    expect(smallPdf.input - baseline.input).toBe(
      2_000 + encode("report.pdf").length,
    )
    expect(largePdf).toEqual(smallPdf)
    expect(untitledPdf.input - baseline.input).toBe(2_000)
  })

  test("leaves ordinary text input and assistant output counting unchanged", async () => {
    const text = "hello world"
    const result = await getTokenCount(
      {
        model: model.id,
        messages: [
          { role: "user", content: text },
          { role: "assistant", content: "response" },
        ],
      },
      model,
    )
    expect(result.input).toBe(6 + encode("user").length + encode(text).length)
    expect(result.output).toBe(
      6 + encode("assistant").length + encode("response").length,
    )
  })

  test("counts tool definitions and assistant tool calls across GPT and non-GPT models", async () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "read_pdf",
          description: "Read a PDF file.",
          parameters: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              mode: {
                type: "string",
                description: "Extraction mode.",
                enum: ["fast", "full"],
                default: "fast",
              },
              pages: {
                type: "array",
                items: { type: "number" },
              },
            },
            required: ["mode"],
          },
        },
      },
    ]

    const gptResult = await getTokenCount(
      {
        model: model.id,
        tools,
        messages: [
          {
            role: "user",
            name: "alice",
            content: [file("data:application/pdf;base64,AAAA", "doc.pdf")],
          },
          {
            role: "assistant",
            content: null,
            reasoning_opaque: "ignored-opaque-token",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_pdf",
                  arguments: '{"mode":"fast"}',
                },
              },
            ],
          },
        ],
      },
      model,
    )
    const claudeModel = createFallbackModel("claude-sonnet-4.6")
    const nonGptResult = await getTokenCount(
      {
        model: claudeModel.id,
        tools,
        messages: [{ role: "user", content: "hi" }],
      },
      claudeModel,
    )

    expect(gptResult.input).toBeGreaterThan(2_000)
    expect(gptResult.output).toBeGreaterThan(0)
    expect(nonGptResult.input).toBeGreaterThan(0)
  })
})
