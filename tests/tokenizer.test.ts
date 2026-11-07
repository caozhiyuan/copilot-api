import { describe, expect, test } from "bun:test"
import { encode } from "gpt-tokenizer/encoding/o200k_base"

import { createFallbackModel } from "~/lib/provider-model"
import { getTokenCount } from "~/lib/tokenizer"
import type { ContentPart, ImagePart } from "~/lib/types/chat-completions"

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
})
