import { expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { prepareImageJsonRequest } from "~/lib/image-json-request"
import { readJsonBytes } from "~/lib/streaming-json"
import { translateXaiImageJsonRequest } from "~/routes/images/xai-json-request"
import { translateXaiImageEditJson } from "~/services/xai/images"

const IMAGE_BYTES = 20 * 1024 * 1024
const chunk = new TextEncoder().encode("A".repeat(64 * 1024))
const prefix =
  '{"model":"image-alias","prompt":"Edit this image","images":["data:image/png;base64,'
const suffix = '"]}'

function largeRequest() {
  let sent = 0
  let started = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!started) {
          started = true
          controller.enqueue(new TextEncoder().encode(prefix))
        } else if (sent < IMAGE_BYTES) {
          sent += chunk.byteLength
          controller.enqueue(chunk)
        } else {
          controller.enqueue(new TextEncoder().encode(suffix))
          controller.close()
        }
      },
    },
    { highWaterMark: 0 },
  )
  const request = new Request("http://localhost/v1/images/edits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit)
  return { request, sent: () => sent }
}

async function bodyDigest(body: ReadableStream<Uint8Array> | null) {
  const hash = createHash("sha256")
  let length = 0
  for await (const part of readJsonBytes(body)) {
    hash.update(part)
    length += part.byteLength
  }
  return { hash: hash.digest("hex"), length }
}

function expectedDigest(before: string, after: string) {
  const hash = createHash("sha256").update(before)
  for (let offset = 0; offset < IMAGE_BYTES; offset += chunk.byteLength)
    hash.update(chunk)
  hash.update(after)
  return {
    hash: hash.digest("hex"),
    length: Buffer.byteLength(before) + IMAGE_BYTES + Buffer.byteLength(after),
  }
}

test("rewrites a 20 MiB image request before reading its image bytes", async () => {
  const input = largeRequest()
  const parsed = await prepareImageJsonRequest(input.request)
  expect(parsed.model).toBe("image-alias")
  expect(input.sent()).toBe(0)
  expect(parsed.stagedDirectory).toBeUndefined()
  const output = parsed.createRequest("gpt-image-2")
  expect(await bodyDigest(output.body as ReadableStream<Uint8Array>)).toEqual(
    expectedDigest(prefix.replace("image-alias", "gpt-image-2"), suffix),
  )
  expect(input.sent()).toBe(IMAGE_BYTES)
}, 20000)

test("converts a 20 MiB xAI image reference without assembling the image string", async () => {
  const input = largeRequest()
  const result = await translateXaiImageJsonRequest(
    input.request,
    "edits",
    "grok-imagine-image-2.0",
  )
  expect(JSON.stringify(result.payload).length).toBeLessThan(1000)
  const marker = "__IMAGE_CONTENT__"
  const template = JSON.stringify(
    translateXaiImageEditJson(
      {
        prompt: "Edit this image",
        images: [`data:image/png;base64,${marker}`],
      },
      "grok-imagine-image-2.0",
    ),
  )
  const [before, after] = template.split(marker)
  expect(await bodyDigest(result.body)).toEqual(expectedDigest(before, after))
  expect(input.sent()).toBe(IMAGE_BYTES)
}, 20000)
