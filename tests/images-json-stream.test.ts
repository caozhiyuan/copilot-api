import { describe, expect, test, mock } from "bun:test"
import consola from "consola"
import { access } from "node:fs/promises"
import { createImageJsonFiles } from "~/lib/image-json-files"

import { HTTPError } from "~/lib/error"
import { prepareImageJsonRequest } from "~/lib/image-json-request"
import { readExternalImageJson } from "~/lib/image-json-value"
import { state } from "~/lib/state"
import {
  ImageModelReader,
  StreamingJsonReader,
  readJsonBytes,
  rewriteImageModel,
} from "~/lib/streaming-json"
import { logImageEditRequest } from "~/routes/images/request-logging"
import { translateXaiImageJsonRequest } from "~/routes/images/xai-json-request"
import {
  translateXaiImageEditJson,
  translateXaiImageGeneration,
} from "~/services/xai/images"

const encoder = new TextEncoder()
const url = "http://localhost/v1/images/edits"

test.each([
  {},
  {
    prompt: "a cat \u{1f408} caf\u00e9",
    nested: { model: "nested-model" },
    n: 1,
  },
  {
    images: [{ image_url: `data:image/png;base64,${"A".repeat(1000)}` }],
    prompt: "edit",
  },
  { prompt: "a".repeat(65523) },
])(
  "inserts a missing image model without dropping fields %#",
  async (payload) => {
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    const parsed = await prepareImageJsonRequest(request)
    expect(await parsed.createRequest("gpt-image-2.5-flare").json()).toEqual({
      ...payload,
      model: "gpt-image-2.5-flare",
    })
  },
)

async function expectFailure(
  promise: Promise<unknown>,
  expected?: string | Error,
) {
  const failure: unknown = await promise.then(
    () => null,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  if (expected instanceof Error) expect(failure).toBe(expected)
  else if (expected) expect((failure as Error).message).toContain(expected)
}

function request(
  body: string | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "1" },
    body: typeof body === "string" ? encoder.encode(body) : body,
    signal,
    duplex: "half",
  } as RequestInit)
}

function chunks(text: string, size = 8192): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text)
  let offset = 0
  return new ReadableStream(
    {
      pull(controller) {
        if (offset === bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.subarray(offset, offset + size))
        offset = Math.min(offset + size, bytes.length)
      },
    },
    { highWaterMark: 0 },
  )
}

describe("streaming image JSON", () => {
  test("starts fallback expiry after staging and removes abandoned files", async () => {
    const files = await createImageJsonFiles(10)
    try {
      const staged = await files.create()
      await staged.handle.writeFile("staged image")
      await staged.handle.close()
      await Bun.sleep(20)
      await access(staged.path)
      files.scheduleCleanup()
      files.scheduleCleanup()
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          !(await access(files.directory).then(
            () => true,
            () => false,
          ))
        )
          break
        await Bun.sleep(5)
      }
      expect(
        await access(files.directory).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await files.cleanup()
    }
  })
  test("dispatches a model-first request before the image body finishes and preserves raw bytes", async () => {
    let tail = false
    let pulls = 0
    const cancel = mock(() => {})
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++
          if (pulls === 1)
            controller.enqueue(
              encoder.encode(
                '{ "model": "gpt-image-2", "images": ["data:image/png;base64,',
              ),
            )
          else if (tail) {
            controller.enqueue(encoder.encode('AAAA"] }'))
            controller.close()
          } else throw new Error("Read image body before forwarding")
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    const parsed = await prepareImageJsonRequest(request(body))
    expect(parsed.model).toBe("gpt-image-2")
    expect(pulls).toBe(1)
    tail = true
    expect(await parsed.originalRequest.text()).toBe(
      '{ "model": "gpt-image-2", "images": ["data:image/png;base64,AAAA"] }',
    )
    expect(pulls).toBe(2)
    expect(cancel).not.toHaveBeenCalled()
  })

  test("rewrites only the top-level model across byte, Unicode, and escape boundaries", async () => {
    const payload = {
      model: 'alias\\"name',
      prompt: 'caf\u00e9 \ud800 \u{1f408}\n"\\',
      nested: { model: "unchanged" },
      images: ["data:image/png;base64," + "ABCD".repeat(512 * 1024)],
    }
    const parsed = await prepareImageJsonRequest(
      request(chunks(JSON.stringify(payload), 8191)),
    )
    expect(parsed.model).toBe(payload.model)
    const rewritten = parsed.createRequest('gpt-image-2.5\\"')
    expect(rewritten.headers.has("content-length")).toBe(false)
    expect(await rewritten.json()).toEqual({
      ...payload,
      model: 'gpt-image-2.5\\"',
    })
  }, 20000)

  test("handles single-byte JSON tokens", async () => {
    const small = {
      model: 'alias\\"caf\u00e9',
      prompt: "\u{1f408}\n\ud800",
      n: 1.25,
      nested: { model: "other" },
    }
    const parsed = await prepareImageJsonRequest(
      request(chunks(JSON.stringify(small), 1)),
    )
    expect(await parsed.createRequest("gpt-image-2").json()).toEqual({
      ...small,
      model: "gpt-image-2",
    })
  })

  test.each([1013, 100000])(
    "accepts a model ending at exactly 64 KiB with %i-byte network chunks",
    async (size) => {
      const head = '{"prompt":"🐈'
      const model = '","model":"gpt-image-2"'
      const prefix =
        head
        + "a".repeat(65536 - encoder.encode(head + model).byteLength)
        + model
      expect(encoder.encode(prefix).byteLength).toBe(65536)
      const text = prefix + ',"image":"' + "A".repeat(100000) + '"}'
      const parsed = await prepareImageJsonRequest(request(chunks(text, size)))
      expect(parsed.model).toBe("gpt-image-2")
      expect(await parsed.originalRequest.text()).toBe(text)
    },
  )

  test.each([
    JSON.stringify({ image: "A".repeat(100000), model: "late" }),
    JSON.stringify({ image: "A".repeat(100000) }),
    JSON.stringify({ nested: { model: "nested" }, image: "A".repeat(100000) }),
    '{"prompt":"' + "a".repeat(65512) + '","model":"late"}',
  ])(
    "rejects an unfinished prefix without a complete model %#",
    async (text) => {
      let pulls = 0
      const cancel = mock(() => {})
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (++pulls > 1) throw new Error("Read beyond the 64 KiB prefix")
            controller.enqueue(encoder.encode(text).subarray(0, 65536))
          },
          cancel,
        },
        { highWaterMark: 0 },
      )
      const error: unknown = await prepareImageJsonRequest(request(body)).catch(
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(HTTPError)
      if (!(error instanceof HTTPError)) throw new Error("Expected HTTPError")
      expect(error.response.status).toBe(400)
      expect(await error.response.json()).toEqual({
        error: {
          message:
            "Image model must appear within the first 64 KiB of the JSON body",
          type: "invalid_request_error",
        },
      })
      expect(pulls).toBe(1)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(body.locked).toBe(false)
    },
  )

  test("rejects a late model contained in a single oversized network chunk", async () => {
    await expectFailure(
      prepareImageJsonRequest(
        request(JSON.stringify({ image: "A".repeat(100000), model: "late" })),
      ),
      "first 64 KiB",
    )
  })

  test("releases an unconsumed request on cancellation", async () => {
    const original = request(
      chunks('{"model":"alias","image":"' + "A".repeat(100000) + '"}'),
    )
    const parsed = await prepareImageJsonRequest(original)
    await parsed.originalRequest.body!.cancel()
    expect(original.body!.locked).toBe(false)
    expect(await original.body!.getReader().read()).toEqual({
      done: true,
      value: undefined,
    })
  })

  test("releases the input on client abort and during forwarding cancellation", async () => {
    const text = JSON.stringify({
      model: "gpt-image-2",
      image: "data:image/png;base64," + "A".repeat(200000),
    })
    const abort = new AbortController()
    const original = request(chunks(text), abort.signal)
    const parsed = await prepareImageJsonRequest(original)
    abort.abort()
    await parsed.cleanup()
    expect(original.body!.locked).toBe(false)
    const next = request(chunks(text))
    const forwarded = await prepareImageJsonRequest(next)
    const reader = forwarded.originalRequest.body!.getReader()
    await reader.read()
    await reader.cancel("stop forwarding")
    expect(next.body!.locked).toBe(false)
  })

  test("rejects invalid JSON, nonobjects, invalid model types, and non-UTF8 bytes", async () => {
    for (const text of [
      "not-json",
      "null",
      "[]",
      '{"model":3}',
      '{"model":null}',
      '{"model":true}',
      '{"model":{}}',
      '{"model":[]}',
      '{"model":"' + "x".repeat(5000) + '"}',
    ]) {
      await expectFailure(prepareImageJsonRequest(request(text)), "Image")
    }
    const raw = Uint8Array.of(123, 255, 125)
    await expectFailure(
      prepareImageJsonRequest(new Request(url, { method: "POST", body: raw })),
      "Image",
    )
  })

  test("rejects invalid JSON found while streaming a model-first body", async () => {
    const parsed = await prepareImageJsonRequest(
      request(chunks('{"model":"gpt-image-2","image":"' + "A".repeat(100000))),
    )
    await expectFailure(parsed.originalRequest.text(), "Image request body")
  })

  test("rejects duplicate top-level models before completing an upload", async () => {
    await expectFailure(
      prepareImageJsonRequest(request('{"model":"a","model":"b"}')),
      "Duplicate",
    )
    const parsed = await prepareImageJsonRequest(
      request(
        chunks(
          '{"model":"a","images":["' + "A".repeat(100000) + '"],"model":"b"}',
        ),
      ),
    )
    await expectFailure(parsed.originalRequest.text(), "Duplicate")
  })

  test("propagates source errors and cancels an in-progress upload", async () => {
    const failure = new Error("upload failed")
    await expectFailure(
      prepareImageJsonRequest(
        request(
          new ReadableStream({
            pull(controller) {
              controller.error(failure)
            },
          }),
        ),
      ),
      failure,
    )
    const cancel = mock(() => {})
    const controller = new AbortController()
    let first = true
    const parsed = await prepareImageJsonRequest(
      request(
        new ReadableStream(
          {
            pull(stream) {
              if (first) {
                first = false
                stream.enqueue(
                  encoder.encode('{"model":"gpt-image-2","image":"'),
                )
              }
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        controller.signal,
      ),
    )
    const reading = parsed.originalRequest.text()
    await Bun.sleep(5)
    controller.abort(new Error("client left"))
    await expectFailure(reading, "client left")
    expect(cancel).toHaveBeenCalled()
  })

  test("cancels an upload without a client abort and propagates JSON encoder failures", async () => {
    const cancel = mock(() => {})
    let first = true
    const parsed = await prepareImageJsonRequest(
      request(
        new ReadableStream(
          {
            pull(stream) {
              if (first) {
                first = false
                stream.enqueue(encoder.encode('{"model":"a","image":"'))
              }
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      ),
    )
    const reader = parsed.originalRequest.body!.getReader()
    await reader.read()
    const pending = reader.read()
    await reader.cancel("upstream stopped")
    await pending
    expect(cancel).toHaveBeenCalled()
    await expectFailure(
      new Response(
        new ReadableStream({
          async start(controller) {
            try {
              for await (const part of rewriteImageModel(
                readJsonBytes(chunks('{"model":"a"')),
                "b",
              ))
                controller.enqueue(part)
              controller.close()
            } catch (error) {
              controller.error(error)
            }
          },
        }),
      ).text(),
    )
  })

  test("bounds untrusted depth, keys, and number lengths", () => {
    for (const text of [
      "[".repeat(65),
      '{"' + "k".repeat(70000),
      "1".repeat(70000),
    ]) {
      expect(() => {
        const reader = new StreamingJsonReader()
        for (let i = 0; i < text.length; i += 4096)
          reader.read(encoder.encode(text.slice(i, i + 4096)))
      }).toThrow()
    }
    const metadata = new ImageModelReader()
    const parser = new StreamingJsonReader()
    metadata.read(
      parser.read(
        encoder.encode(
          '{"model":"x","nested":{"model":"y"},"n":1.25,"ok":false}',
        ),
      ),
    )
    metadata.read(parser.read())
    expect(metadata.model).toBe("x")
  })
})

describe("xAI JSON streaming translation", () => {
  test("propagates client aborts before and during replay of staged image data", async () => {
    for (const readFirst of [false, true]) {
      const abort = new AbortController()
      const translated = await translateXaiImageJsonRequest(
        request(
          JSON.stringify({
            prompt: "Edit this image",
            images: ["data:image/png;base64," + "A".repeat(200000)],
          }),
          abort.signal,
        ),
        "edits",
        "model",
      )
      const reader = translated.body.getReader()
      if (readFirst) {
        await reader.read()
        await reader.read()
      }
      abort.abort(new Error("image upload cancelled"))
      await expectFailure(reader.read(), "image upload cancelled")
    }
  })
  test("matches existing translators for every image reference shape and common parameters", async () => {
    const base64 = "ABCD".repeat(300000)
    const cases = [
      { images: ["  data:image/png;base64," + base64 + " \n"] },
      {
        images: [
          { b64_json: " \n" + base64 + "== \t", mime_type: "image/jpeg" },
        ],
      },
      { image: { b64_json: "data:image/png;base64," + base64 } },
      { image_url: "https://example.com/" + base64 },
      {
        image: [
          { image_url: "data:image/webp;base64," + base64 },
          { url: "https://example.com/a" },
        ],
      },
    ]
    for (const images of cases) {
      const payload = {
        prompt: "Optimize this image",
        n: "2",
        size: "1024x1536",
        quality: "high",
        response_format: "url",
        ...images,
      }
      const translated = await translateXaiImageJsonRequest(
        request(chunks(JSON.stringify(payload), 16384)),
        "edits",
        "grok-imagine-image-2.0",
      )
      expect(await new Response(translated.body).json()).toEqual(
        translateXaiImageEditJson(payload, "grok-imagine-image-2.0"),
      )
    }
  })

  test("keeps large prompts and ignores unused large fields without retaining them", async () => {
    const payload = {
      prompt: "  " + "\u{1f331}\\\n\ud800".repeat(30000) + "  ",
      images: ["A".repeat(100000)],
      n: 1,
      size: "auto",
      quality: "low",
    }
    const translated = await translateXaiImageJsonRequest(
      request(chunks(JSON.stringify(payload), 1001)),
      "generations",
      "grok-imagine-image-2.0",
    )
    expect(await new Response(translated.body).json()).toEqual(
      translateXaiImageGeneration(payload, "grok-imagine-image-2.0"),
    )
    expect(translated.payload.prompt).not.toBe(payload.prompt)
  })

  test("rejects malformed JSON, invalid fields and large invalid base64 using existing errors", async () => {
    for (const body of [
      "invalid",
      '{"prompt":"a"',
      JSON.stringify({
        prompt: "a",
        image: { b64_json: "A".repeat(70000) + "*" },
      }),
      JSON.stringify({
        prompt: "a",
        image: { b64_json: "A".repeat(70000) + "===" },
      }),
      JSON.stringify({
        prompt: "a",
        image: { b64_json: "A".repeat(70000) + "=A" },
      }),
      JSON.stringify({ prompt: "a", image: "bad" }),
      JSON.stringify({
        prompt: "a",
        image: "data:image/png;base64," + "A".repeat(70000),
        mask: "no",
      }),
    ]) {
      await expectFailure(
        translateXaiImageJsonRequest(request(chunks(body)), "edits", "model"),
      )
    }
    await expectFailure(
      readExternalImageJson(
        request(chunks('{"image":"' + "A".repeat(100000) + '"}')),
        70000,
      ),
      "staging limit",
    )
  })

  test("cancels a staged body before reading and keeps small payloads compatible", async () => {
    const translated = await translateXaiImageJsonRequest(
      request(
        JSON.stringify({
          prompt: "a",
          images: ["data:image/png;base64," + "A".repeat(70000)],
        }),
      ),
      "edits",
      "model",
    )
    await translated.body.cancel()
    const small = await translateXaiImageJsonRequest(
      request('{"prompt":"small","n":1}'),
      "generations",
      "model",
    )
    expect(await new Response(small.body).json()).toEqual({
      model: "model",
      prompt: "small",
      n: 1,
      response_format: "b64_json",
    })
  })

  test("observes a large request log while forwarding, with image strings omitted", async () => {
    const previous = state.verbose
    state.verbose = true
    try {
      const logs: Array<unknown> = []
      const debug = mock(
        async (
          _logger: unknown,
          _label: string,
          factory: () => Promise<unknown>,
        ) => {
          logs.push(await factory())
        },
      )
      const logger = consola.create({ reporters: [] })
      const body = JSON.stringify({
        model: "gpt-image-2",
        prompt: "Optimize this image",
        images: ["data:image/png;base64," + "A".repeat(2 * 1024 * 1024)],
        n: 1,
      })
      const logged = await logImageEditRequest(
        logger,
        "edit",
        request(chunks(body)),
        {},
        debug,
      )
      expect(logs).toHaveLength(0)
      expect(await logged.text()).toBe(body)
      expect(logs).toHaveLength(1)
      expect(JSON.stringify(logs)).toContain("Optimize this image")
      expect(JSON.stringify(logs).length).toBeLessThan(1000)
    } finally {
      state.verbose = previous
    }
  })
})
