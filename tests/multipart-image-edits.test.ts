import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"

import { parseMultipartImageEdit } from "~/routes/images/multipart-edits"

function formData() {
  const form = new FormData()
  form.set("model", "gpt-image-2")
  form.set("prompt", "edit this image")
  form.set("image", new File(["first"], "first.png", { type: "image/png" }))
  return form
}

async function parse(form: FormData, signal?: AbortSignal) {
  const parsed = await parseMultipartImageEdit(
    new Request("http://localhost/v1/images/edits?output=base64", {
      method: "POST",
      body: form,
      signal,
      headers: { "x-client-request-id": "edit-id" },
    }),
  )
  if (!parsed) throw new Error("Expected a multipart edit")
  return parsed
}

describe("multipart image edits", () => {
  test("leaves JSON request streams untouched", async () => {
    const request = new Request("http://localhost/images/edits", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    expect(await parseMultipartImageEdit(request)).toBeNull()
    expect(await request.text()).toBe("{}")
  })

  test("stages before encoding and preserves mixed image order, masks and typed options", async () => {
    const form = formData()
    form.append("image[]", "https://example.com/second.png")
    form.append(
      "image",
      new File(["third"], "third.webp", { type: "image/webp" }),
    )
    form.set("mask", new File(["mask"], "mask.png", { type: "image/png" }))
    form.set("n", "2")
    form.set("stream", "true")
    form.set("partial_images", "1")
    form.set("output_compression", "85")
    form.set("quality", "high")
    form.set("user", "00123")
    const parsed = await parse(form)
    expect(existsSync(parsed.directory)).toBe(true)
    try {
      const forwarded = await parsed.createRequest("mapped-model")
      expect(existsSync(parsed.directory)).toBe(false)
      expect(forwarded.url).toBe(
        "http://localhost/v1/images/edits?output=base64",
      )
      expect(forwarded.headers.get("content-type")).toBe("application/json")
      expect(forwarded.headers.get("content-length")).toBeNull()
      expect(forwarded.headers.get("x-client-request-id")).toBe("edit-id")
      expect(await forwarded.json()).toEqual({
        model: "mapped-model",
        prompt: "edit this image",
        images: [
          { image_url: "data:image/png;base64,Zmlyc3Q=" },
          { image_url: "https://example.com/second.png" },
          { image_url: "data:image/webp;base64,dGhpcmQ=" },
        ],
        mask: { image_url: "data:image/png;base64,bWFzaw==" },
        n: 2,
        stream: true,
        partial_images: 1,
        output_compression: 85,
        quality: "high",
        user: "00123",
      })
      expect(await parsed.readPayload()).toBe(await parsed.readPayload())
    } finally {
      await parsed.cleanup()
    }
  })

  test.each([
    { bytes: [137, 80, 78, 71, 13, 10, 26, 10], mime: "image/png" },
    { bytes: [255, 216, 255, 0], mime: "image/jpeg" },
    { bytes: Array.from(Buffer.from("RIFF1234WEBP")), mime: "image/webp" },
    { bytes: Array.from(Buffer.from("GIF89a")), mime: "image/gif" },
  ])(
    "detects $mime when the upload omits its MIME type",
    async ({ bytes, mime }) => {
      const form = formData()
      form.set("image", new File([Uint8Array.from(bytes)], "upload"))
      const parsed = await parse(form)
      try {
        const body = await parsed.readPayload()
        expect(body.images).toEqual([
          {
            image_url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
          },
        ])
      } finally {
        await parsed.cleanup()
      }
    },
  )

  test("uses the xAI translator for multiple images and false streaming", async () => {
    const form = formData()
    form.set("stream", "false")
    form.set("n", "2")
    form.append("image[]", "data:image/png;base64,c2Vjb25k")
    const parsed = await parse(form)
    try {
      const forwarded = await parsed.createRequest(
        "grok-imagine-image-2.0",
        "xai",
      )
      expect(await forwarded.json()).toEqual({
        model: "grok-imagine-image-2.0",
        prompt: "edit this image",
        n: 2,
        response_format: "b64_json",
        images: [
          { type: "image_url", url: "data:image/png;base64,Zmlyc3Q=" },
          { type: "image_url", url: "data:image/png;base64,c2Vjb25k" },
        ],
      })
      expect(existsSync(parsed.directory)).toBe(false)
    } finally {
      await parsed.cleanup()
    }
  })

  test("retains multipart uploads for other providers", async () => {
    const parsed = await parse(formData())
    try {
      const forwarded = await parsed.createRequest("other-model", "openrouter")
      expect(existsSync(parsed.directory)).toBe(true)
      expect(forwarded.headers.get("content-type")).toStartWith(
        "multipart/form-data; boundary=",
      )
      const form = await forwarded.formData()
      expect(form.get("model")).toBe("other-model")
      const image = form.get("image")
      expect(image).toBeInstanceOf(File)
      if (typeof image === "string" || !image) throw new Error("Expected image")
      expect(await image.text()).toBe("first")
      parsed.scheduleCleanup()
    } finally {
      await parsed.cleanup()
    }
    expect(existsSync(parsed.directory)).toBe(false)
  })

  test("allows omitted models for Codex", async () => {
    const form = formData()
    form.delete("model")
    const parsed = await parse(form)
    try {
      expect(parsed.model).toBeUndefined()
      expect(
        await (await parsed.createRequest(undefined)).json(),
      ).not.toHaveProperty("model")
    } finally {
      await parsed.cleanup()
    }
  })

  test.each([
    {
      name: "missing image",
      change: (form: FormData) => form.delete("image"),
      message: "image is required",
    },
    {
      name: "empty image",
      change: (form: FormData) =>
        form.set("image", new File([], "empty.png", { type: "image/png" })),
      message: "image is empty",
    },
    {
      name: "unknown image type",
      change: (form: FormData) =>
        form.set("image", new File(["unknown"], "unknown")),
      message: "MIME type",
    },
    {
      name: "invalid URL",
      change: (form: FormData) => form.set("image", "file:///tmp/image.png"),
      message: "HTTP URL",
    },
    {
      name: "invalid count",
      change: (form: FormData) => form.set("n", "1.5"),
      message: "n must be an integer",
    },
    {
      name: "empty count",
      change: (form: FormData) => form.set("partial_images", ""),
      message: "partial_images must be an integer",
    },
    {
      name: "unsafe integer",
      change: (form: FormData) =>
        form.set("output_compression", "9007199254740992"),
      message: "output_compression must be an integer",
    },
    {
      name: "invalid boolean",
      change: (form: FormData) => form.set("stream", "yes"),
      message: "stream must be true or false",
    },
    {
      name: "duplicate model",
      change: (form: FormData) => form.append("model", "other-model"),
      message: "Duplicate image edit field: model",
    },
    {
      name: "duplicate mask",
      change: (form: FormData) => {
        form.set("mask", "https://example.com/mask.png")
        form.set("mask[]", "https://example.com/other-mask.png")
      },
      message: "Duplicate image edit field: mask",
    },
    {
      name: "unexpected file",
      change: (form: FormData) =>
        form.set("prompt", new File(["prompt"], "prompt.txt")),
      message: "Unexpected image edit file field: prompt",
    },
  ])(
    "rejects $name and removes staged uploads",
    async ({ change, message }) => {
      const form = formData()
      change(form)
      const parsed = await parse(form)
      try {
        await Promise.resolve(
          expect(parsed.readPayload()).rejects.toThrow(message),
        )
      } finally {
        await parsed.cleanup()
      }
      expect(existsSync(parsed.directory)).toBe(false)
    },
  )

  test.each(["mask", "count", "model"])(
    "retains xAI validation for %s",
    async (invalid) => {
      const form = formData()
      if (invalid === "mask") form.set("mask", "https://example.com/mask.png")
      if (invalid === "count")
        for (let i = 0; i < 5; i++)
          form.append("image[]", "https://example.com/image.png")
      const parsed = await parse(form)
      try {
        await Promise.resolve(
          expect(
            parsed.createRequest(
              invalid === "model" ? undefined : "grok-imagine-image-2.0",
              "xai",
            ),
          ).rejects.toThrow(
            invalid === "mask" ? "do not support mask"
            : invalid === "count" ? "at most 5 images"
            : "model is required",
          ),
        )
      } finally {
        await parsed.cleanup()
      }
      expect(existsSync(parsed.directory)).toBe(false)
    },
  )

  test("cancellation after staging removes uploads before forwarding", async () => {
    const controller = new AbortController()
    const parsed = await parse(formData(), controller.signal)
    controller.abort(new Error("cancelled edit"))
    try {
      await Promise.resolve(
        expect(parsed.createRequest("gpt-image-2")).rejects.toThrow(
          "cancelled edit",
        ),
      )
    } finally {
      await parsed.cleanup()
    }
    expect(existsSync(parsed.directory)).toBe(false)
  })
})
