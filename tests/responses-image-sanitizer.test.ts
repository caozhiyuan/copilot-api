import { describe, expect, test } from "bun:test"

import type {
  ResponseCustomToolCallOutputItem,
  ResponseFunctionCallOutputItem,
  ResponseInputImage,
  ResponsesPayload,
} from "~/lib/types/responses"

import {
  normalizeInputImageDetails,
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

  test("keeps input images within the estimated data URL size limit", () => {
    const imageUrl = imageDataUrl(8)
    const payload = makePayload(imageUrl)

    const sanitized = sanitizeOversizedInputImages(payload, 22)

    expect(sanitized).toBe(0)
    expect(
      (
        payload.input as Array<{
          content: Array<{ detail?: string; image_url?: string; type: string }>
        }>
      )[0].content[1],
    ).toEqual({ detail: "low", image_url: imageUrl, type: "input_image" })
  })

  test("replaces every input image exceeding the configured size limit", () => {
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

    const sanitized = sanitizeOversizedInputImages(payload, 1)

    expect(sanitized).toBe(2)
    expect(JSON.stringify(payload)).not.toContain(firstImageUrl)
    expect(JSON.stringify(payload)).not.toContain(secondImageUrl)
    expect(JSON.stringify(payload)).toContain("data:image/png;base64")
  })

  test("estimates image size from the full data URL string", () => {
    const payload = makePayload(imageDataUrl(4))

    const sanitized = sanitizeOversizedInputImages(payload, 10)

    expect(sanitized).toBe(1)
  })

  test("sanitizes images inside function call outputs", () => {
    const toolImageUrl = imageDataUrl(128)
    const toolOutputImage: ResponseInputImage = {
      detail: "high",
      image_url: toolImageUrl,
      type: "input_image",
    }
    const payload = {
      input: [
        {
          call_id: "call_123",
          output: [toolOutputImage],
          status: "completed",
          type: "function_call_output",
        } satisfies ResponseFunctionCallOutputItem,
      ],
      model: "gpt-test",
    } satisfies ResponsesPayload

    const sanitized = sanitizeOversizedInputImages(payload, 64)

    expect(sanitized).toBe(1)
    expect(toolOutputImage.type).toBe("input_image")
    expect(toolOutputImage.detail).toBe("low")
    expect(
      toolOutputImage.image_url?.startsWith("data:image/png;base64,"),
    ).toBe(true)
    expect(toolOutputImage.image_url).not.toBe(toolImageUrl)
  })

  test("sanitizes images inside custom tool call outputs", () => {
    const toolImageUrl = imageDataUrl(128)
    const toolOutputImage: ResponseInputImage = {
      detail: "high",
      image_url: toolImageUrl,
      type: "input_image",
    }
    const payload = {
      input: [
        {
          call_id: "call_123",
          output: [toolOutputImage],
          status: "completed",
          type: "custom_tool_call_output",
        } satisfies ResponseCustomToolCallOutputItem,
      ],
      model: "gpt-test",
    } satisfies ResponsesPayload

    const sanitized = sanitizeOversizedInputImages(payload, 64)

    expect(sanitized).toBe(1)
    expect(toolOutputImage.type).toBe("input_image")
    expect(toolOutputImage.detail).toBe("low")
    expect(
      toolOutputImage.image_url?.startsWith("data:image/png;base64,"),
    ).toBe(true)
    expect(toolOutputImage.image_url).not.toBe(toolImageUrl)
  })

  test("does not normalize image detail while checking image sizes", () => {
    const imageUrl = imageDataUrl(8)
    const image: ResponseInputImage = {
      detail: "ultra" as ResponseInputImage["detail"],
      image_url: imageUrl,
      type: "input_image",
    }
    const payload = {
      input: [{ content: [image], role: "user" }],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const sanitized = sanitizeOversizedInputImages(payload, 64)

    expect(sanitized).toBe(0)
    expect(image.detail as unknown).toBe("ultra")
    expect(image.image_url).toBe(imageUrl)
  })
})

describe("normalizeInputImageDetails", () => {
  test("normalizes unsupported detail values to auto", () => {
    const image: ResponseInputImage = {
      detail: "ultra" as ResponseInputImage["detail"],
      image_url: imageDataUrl(8),
      type: "input_image",
    }
    const payload = {
      input: [{ content: [image], role: "user" }],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const normalized = normalizeInputImageDetails(payload)

    expect(normalized).toBe(1)
    expect(image.detail).toBe("auto")
  })

  test("keeps images without a detail value unset", () => {
    const image: ResponseInputImage = {
      image_url: imageDataUrl(8),
      type: "input_image",
    }
    const payload = {
      input: [{ content: [image], role: "user" }],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const normalized = normalizeInputImageDetails(payload)

    expect(normalized).toBe(0)
    expect(image.detail).toBeUndefined()
  })

  test("keeps supported detail values unchanged", () => {
    const payload = makePayload(imageDataUrl(8))

    const normalized = normalizeInputImageDetails(payload)

    expect(normalized).toBe(0)
    expect(
      (
        payload.input as Array<{
          content: Array<{ detail?: string; type: string }>
        }>
      )[0].content[1].detail,
    ).toBe("low")
  })

  test("normalizes detail values inside custom tool call outputs", () => {
    const toolOutputImage: ResponseInputImage = {
      detail: "original" as ResponseInputImage["detail"],
      image_url: imageDataUrl(8),
      type: "input_image",
    }
    const payload = {
      input: [
        {
          call_id: "call_123",
          output: [toolOutputImage],
          status: "completed",
          type: "custom_tool_call_output",
        } satisfies ResponseCustomToolCallOutputItem,
      ],
      model: "gpt-test",
    } satisfies ResponsesPayload

    const normalized = normalizeInputImageDetails(payload)

    expect(normalized).toBe(1)
    expect(toolOutputImage.detail).toBe("auto")
  })
})
