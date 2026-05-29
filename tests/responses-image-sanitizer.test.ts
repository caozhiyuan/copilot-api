import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import {
  sanitizeAllInputImages,
  sanitizeOversizedInputImages,
} from "~/routes/responses/utils"

const imageDataUrl = (base64Length: number): string =>
  `data:image/png;base64,${"A".repeat(base64Length)}`

const tinyPngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="

const makePayload = (imageUrl: string): ResponsesPayload =>
  ({
    input: [
      {
        content: [
          { text: "look", type: "input_text" },
          { detail: "low", image_url: imageUrl, type: "input_image" },
        ],
        role: "user",
      },
    ],
    model: "gpt-test",
  }) as unknown as ResponsesPayload

describe("sanitizeOversizedInputImages", () => {
  test("replaces oversized input images with placeholder images", () => {
    const payload = makePayload(tinyPngDataUrl)

    const sanitized = sanitizeOversizedInputImages(payload, 67)

    expect(sanitized).toBe(1)
    const image = (
      payload.input as Array<{
        content: Array<{
          detail?: string
          image_url?: string
          text?: string
          type: string
        }>
      }>
    )[0].content[1]
    expect(image.type).toBe("input_image")
    expect(image.detail).toBe("low")
    expect(image.image_url?.startsWith("data:image/png;base64,")).toBe(true)
    expect(image.image_url).not.toBe(tinyPngDataUrl)
    expect(image.text).toBeUndefined()
  })

  test("keeps input images within the model size limit", () => {
    const imageUrl = imageDataUrl(8)
    const payload = makePayload(imageUrl)

    const sanitized = sanitizeOversizedInputImages(payload, 8)

    expect(sanitized).toBe(0)
    expect(
      (
        payload.input as Array<{
          content: Array<{ detail?: string; image_url?: string; type: string }>
        }>
      )[0].content[1],
    ).toEqual({ detail: "low", image_url: imageUrl, type: "input_image" })
  })

  test("replaces all input images for a retry after payload rejection", () => {
    const firstImageUrl = imageDataUrl(1024)
    const secondImageUrl = imageDataUrl(1024)
    const payload = {
      input: [
        {
          content: [
            { text: "look", type: "input_text" },
            {
              detail: "low",
              image_url: firstImageUrl,
              type: "input_image",
            },
            {
              detail: "low",
              image_url: secondImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const sanitized = sanitizeAllInputImages(payload)

    expect(sanitized).toBe(2)
    expect(JSON.stringify(payload)).not.toContain(firstImageUrl)
    expect(JSON.stringify(payload)).not.toContain(secondImageUrl)
    expect(JSON.stringify(payload)).toContain("data:image/png;base64")
  })
})
