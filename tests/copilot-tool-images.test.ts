import { afterEach, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { invalidateConfigCache } from "~/lib/config/config-store"
import { requestContext, type RequestContext } from "~/lib/http/request-context"
import { state } from "~/lib/state"
import { PATHS } from "~/lib/storage/paths"
import { closeUsageStore, getTokenUsageEventsPage } from "~/lib/token-usage"
import {
  copilotToolImageDependencies as deps,
  executeCopilotToolImage,
} from "~/routes/responses/copilot-tool-images"

type Options = Parameters<typeof executeCopilotToolImage>[0]
const model = "gpt-image-2.5-flare"
const image = "aW1hZ2U="
const preview = "cHJldmlldw=="
const defaults: Options = {
  id: "ig_123",
  model,
  prompt: "Paint a boat",
  tool: { type: "image_generation" },
  inputImages: [],
}
const original = { ...deps }
afterEach(() => {
  Object.assign(deps, original)
})

function useUpstream(response: Response) {
  const forward = mock((..._args: Parameters<typeof deps.forward>) =>
    Promise.resolve(response),
  )
  deps.forward = forward
  return forward
}

async function expectFailure(options: Options, expected: object) {
  const result = await executeCopilotToolImage(options).catch(
    (cause: unknown) => cause,
  )
  expect(result).toMatchObject(expected)
}

function sse(events: Array<[string, unknown]>) {
  const data = events.map(
    ([name, body]) =>
      "event: " + name + "\ndata: " + JSON.stringify(body) + "\n\n",
  )
  return new Response(data.join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

test("generates one image using the selected Copilot model and returns the revised prompt", async () => {
  const forward = useUpstream(
    Response.json({
      data: [{ b64_json: image, revised_prompt: "A sailboat at sea" }],
    }),
  )
  const result = await executeCopilotToolImage({
    ...defaults,
    model: "github-copilot/" + model,
    inputImages: [{ file_id: "ignored" }],
    tool: {
      ...defaults.tool,
      model: "gpt-image-2",
      action: "generate",
      size: "1024x1024",
      quality: "high",
      background: "opaque",
      output_format: "webp",
      output_compression: 85,
      moderation: "auto",
      partial_images: 2,
    },
  })
  expect(result).toEqual({
    type: "image_generation_call",
    id: "ig_123",
    status: "completed",
    action: "generate",
    revised_prompt: "A sailboat at sea",
    result: image,
    output_format: "webp",
  })
  const [request, operation, context] = forward.mock.calls[0]
  expect(operation).toBe("generations")
  expect(context).toMatchObject({ provider: "github-copilot", model })
  expect(await request.json()).toEqual({
    model,
    prompt: defaults.prompt,
    n: 1,
    response_format: "b64_json",
    size: "1024x1024",
    quality: "high",
    background: "opaque",
    output_format: "webp",
    output_compression: 85,
    moderation: "auto",
  })
})

test("edits all referenced images in order with the supplied mask", async () => {
  const forward = useUpstream(Response.json({ data: [{ b64_json: image }] }))
  const images = [
    { image_url: "data:image/png;base64," + image },
    { file_id: "file-a" },
  ]
  const mask = { file_id: "file-mask" }
  const result = await executeCopilotToolImage({
    ...defaults,
    inputImages: images,
    tool: { ...defaults.tool, input_fidelity: "high", input_image_mask: mask },
  })
  const [request, operation] = forward.mock.calls[0]
  expect(operation).toBe("edits")
  expect(await request.json()).toMatchObject({
    model,
    images,
    mask,
    input_fidelity: "high",
  })
  expect(result).toMatchObject({
    action: "edit",
    revised_prompt: defaults.prompt,
    result: image,
  })
})

test.each(["image_generation", "image_edit"])(
  "streams %s previews and collects the final result",
  async (name) => {
    const onPartialImage = mock()
    const forward = useUpstream(
      sse([
        [
          name + ".partial_image",
          { b64_json: preview, partial_image_index: 0 },
        ],
        [name + ".completed", { b64_json: image, output_format: "jpeg" }],
      ]),
    )
    const opts: Options = {
      ...defaults,
      inputImages: name === "image_edit" ? [{ file_id: "file-a" }] : [],
      tool: { ...defaults.tool, partial_images: 1 },
      onPartialImage,
    }
    const result = await executeCopilotToolImage(opts)
    expect(onPartialImage.mock.calls).toEqual([[0, preview]])
    const [request] = forward.mock.calls[0]
    expect(request.headers.get("accept")).toBe("text/event-stream")
    expect(await request.json()).toMatchObject({
      stream: true,
      partial_images: 1,
    })
    expect(result).toMatchObject({ result: image, output_format: "jpeg" })
  },
)

test.each([
  { options: { prompt: " " }, status: 400 },
  { options: { model: "xai/grok-imagine" }, status: 400 },
  { options: { tool: { ...defaults.tool, action: "edit" } }, status: 400 },
  { options: { tool: { ...defaults.tool, partial_images: 4 } }, status: 400 },
  { options: { tool: { ...defaults.tool, unknown_option: 1 } }, status: 400 },
])(
  "rejects invalid image options before calling Copilot: %j",
  async ({ options, status }) => {
    const forward = useUpstream(new Response())
    await expectFailure({ ...defaults, ...options } as Options, {
      response: { status },
    })
    expect(forward).not.toHaveBeenCalled()
  },
)

const invalidImages: Array<[string, () => Response]> = [
  ["empty image list", () => Response.json({ data: [] })],
  [
    "URL-only image",
    () => Response.json({ data: [{ url: "https://example.test/a" }] }),
  ],
  ["invalid base64", () => Response.json({ data: [{ b64_json: "Zm 9v" }] })],
  ["invalid JSON", () => new Response("{")],
  [
    "truncated image stream",
    () =>
      sse([
        [
          "image_generation.partial_image",
          { b64_json: preview, partial_image_index: 0 },
        ],
      ]),
  ],
  [
    "invalid preview index",
    () =>
      sse([
        [
          "image_generation.partial_image",
          { b64_json: preview, partial_image_index: -1 },
        ],
      ]),
  ],
  [
    "upstream stream error",
    () => sse([["error", { error: { message: "content blocked" } }]]),
  ],
]
test.each(invalidImages)(
  "rejects an unusable image response: %s",
  async (_, response) => {
    useUpstream(response())
    await expectFailure(
      {
        ...defaults,
        tool: { ...defaults.tool, partial_images: 1 },
        onPartialImage: mock(),
      },
      { response: { status: 502 } },
    )
  },
)

test("preserves upstream errors and retry headers", async () => {
  useUpstream(
    Response.json(
      { error: { message: "rate limited" } },
      { status: 429, headers: { "retry-after": "5" } },
    ),
  )
  const error = await executeCopilotToolImage(defaults).catch(
    (cause: unknown) => cause,
  )
  expect(error).toMatchObject({
    message: "rate limited",
    response: { status: 429 },
  })
  expect(
    (error as { response: Response }).response.headers.get("retry-after"),
  ).toBe("5")
})

test("propagates cancellation and stops delivering previews", async () => {
  const controller = new AbortController()
  const forward = useUpstream(
    sse([
      [
        "image_generation.partial_image",
        { b64_json: preview, partial_image_index: 0 },
      ],
      ["image_generation.completed", { b64_json: image }],
    ]),
  )
  const opts: Options = {
    ...defaults,
    signal: controller.signal,
    tool: { ...defaults.tool, partial_images: 1 },
    onPartialImage: () => controller.abort(),
  }
  await expectFailure(opts, { name: "AbortError" })
  expect(forward.mock.calls[0][0].signal.aborted).toBe(true)
  await expectFailure(opts, { name: "AbortError" })
  expect(forward).toHaveBeenCalledTimes(1)
})

function parentContext(
  apiKey: NonNullable<RequestContext["apiKey"]> = {
    id: "key-id",
    key: "test-key",
    allowedModels: ["chat-model"],
  },
) {
  return {
    traceId: "trace-image",
    startTime: Date.now(),
    userAgent: "test",
    parentSessionId: undefined,
    sessionAffinity: "test-session",
    apiKey,
    pluginRequest: {
      id: "outer",
      setModel: mock(),
      setActualModel: mock(),
      setSessionId: mock(),
      recordFirstToken: mock(),
      recordUsage: mock(),
    },
    requestTiming: {
      id: "outer",
      durationMs: null,
      firstTokenMs: null,
      outcome: null,
      hasUsage: false,
      recordFirstToken: mock(),
    },
  } satisfies RequestContext
}

test("checks nested key permissions and records one image charge without changing the chat context", async () => {
  const context = parentContext()
  const oldConfig = PATHS.CONFIG_PATH
  const oldDatabase = process.env.COPILOT_API_SQLITE_DB_PATH
  const oldToken = state.githubToken
  const oldFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "copilot-tool-image-"))
  try {
    PATHS.CONFIG_PATH = join(dir, "config.json")
    writeFileSync(PATHS.CONFIG_PATH, "{}")
    invalidateConfigCache()
    process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
    state.githubToken = "test-image-token"
    const fetch = mock(() =>
      Promise.resolve(
        Response.json({
          data: [{ b64_json: image }],
          usage: { input_tokens: 5, output_tokens: 10 },
          copilot_usage: { total_nano_aiu: 500_000_000 },
        }),
      ),
    )
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch
    await requestContext.run(context, async () => {
      await expectFailure(defaults, { response: { status: 403 } })
      expect(fetch).not.toHaveBeenCalled()
      context.apiKey.allowedModels!.push("github-copilot/" + model)
      expect((await executeCopilotToolImage(defaults)).result).toBe(image)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(context.pluginRequest?.setActualModel).not.toHaveBeenCalled()
      expect(context.pluginRequest?.recordUsage).not.toHaveBeenCalled()
      expect(context.requestTiming?.hasUsage).toBe(false)
    })
    const { items } = await getTokenUsageEventsPage({
      period: "today",
      pageSize: 10,
      page: 1,
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      api_key_id: "key-id",
      endpoint: "images_generations",
      model,
      total_nano_aiu: 500_000_000,
    })
  } finally {
    await closeUsageStore()
    globalThis.fetch = oldFetch
    state.githubToken = oldToken
    if (oldDatabase === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH
    else process.env.COPILOT_API_SQLITE_DB_PATH = oldDatabase
    PATHS.CONFIG_PATH = oldConfig
    invalidateConfigCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("blocks nested calls when the API key budget is exhausted or unavailable", async () => {
  const forward = useUpstream(new Response())
  const context = parentContext()
  context.apiKey.quota = { amount: 1, period: "day" }
  await requestContext.run(context, async () => {
    deps.quota = mock(() =>
      Promise.resolve({
        remainingCostNanos: 0,
        usedCostNanos: 1,
        startMs: 0,
        endMs: null,
      }),
    )
    await expectFailure(defaults, { response: { status: 429 } })
    deps.quota = mock(() => Promise.reject(new Error("storage unavailable")))
    await expectFailure(defaults, { response: { status: 503 } })
    expect(forward).not.toHaveBeenCalled()
  })
})
