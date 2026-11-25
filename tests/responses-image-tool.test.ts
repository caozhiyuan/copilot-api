import { rejects } from "node:assert/strict"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import type {
  ImageGenerationTool,
  ResponsesPayload,
  ResponsesResult,
} from "~/lib/types/responses"
import type { executeCopilotToolImage } from "~/routes/responses/copilot-tool-images"
import { copilotToolImageDependencies } from "~/routes/responses/copilot-tool-images"
import {
  bridgeImageToolJson,
  offerCodexImageTool,
  prepareCopilotImageTool,
} from "~/routes/responses/image-tool"
import { responsesHandlerDependencies } from "~/routes/responses/handler"
import { responsesMessagesDependencies } from "~/routes/responses/messages-handler"
import { responsesRoutes } from "~/routes/responses/route"
import { createResponsesResult } from "./fixtures/responses"

const config = { enabled: true, model: "gpt-image-2.5-flare" }
const image: ImageGenerationTool = { type: "image_generation", quality: "low" }
const other = {
  type: "function" as const,
  name: "lookup",
  parameters: {},
  strict: false,
}
const signal = new AbortController().signal
const app = new Hono().route("/v1/responses", responsesRoutes)
const saved = { ...responsesHandlerDependencies }
const original = {
  images: copilotToolImageDependencies.forward,
  messages: responsesMessagesDependencies.handleCompletionPayload,
}
const request = (extra: Partial<ResponsesPayload> = {}): ResponsesPayload => ({
  model: "gpt-6-luna",
  input: "Draw a blue circle.",
  tools: [image, other],
  ...extra,
})
const runImage = () =>
  mock<typeof executeCopilotToolImage>(({ id, prompt }) =>
    Promise.resolve({
      id,
      type: "image_generation_call",
      status: "completed",
      result: "aW1n",
      revised_prompt: prompt,
    }),
  )
const call = (name: string, call_id = "call_1") => ({
  type: "function_call" as const,
  name,
  call_id,
  arguments: JSON.stringify({
    prompt: "Draw a blue circle.",
    action: "generate",
  }),
})
afterEach(() => {
  Object.assign(responsesHandlerDependencies, saved)
  copilotToolImageDependencies.forward = original.images
  responsesMessagesDependencies.handleCompletionPayload = original.messages
})

describe("GHCP hosted image tool", () => {
  test("the HTTP route lets the chat model choose, executes via GHCP Images and returns a native item", async () => {
    responsesHandlerDependencies.getCopilotImageGenerationConfig = () => config
    responsesHandlerDependencies.resolveMappedModel = (model) => model
    responsesHandlerDependencies.findEndpointModel = () =>
      ({
        id: "gpt-6-luna",
        supported_endpoints: ["/responses"],
        capabilities: { limits: {} },
      }) as ReturnType<typeof responsesHandlerDependencies.findEndpointModel>
    const upstream = mock<typeof responsesHandlerDependencies.createResponses>(
      (payload) => {
        expect(payload.model).toBe("gpt-6-luna")
        expect(payload.tools?.map((t) => t.type)).toEqual([
          "function",
          "function",
        ])
        const selected = payload.tools?.[0]
        if (
          !selected
          || !("name" in selected)
          || typeof selected.name !== "string"
        )
          throw new Error("Missing function")
        expect(payload.tool_choice).toEqual({
          type: "function",
          name: selected.name,
        })
        return Promise.resolve({
          ...createResponsesResult(payload.model),
          tools: payload.tools ?? [],
          tool_choice: payload.tool_choice,
          output: [call(selected.name), call("lookup", "call_2")],
        })
      },
    )
    responsesHandlerDependencies.createResponses = upstream
    const images = mock<typeof copilotToolImageDependencies.forward>(
      async (req, operation) => {
        expect(operation).toBe("generations")
        expect(await req.json()).toMatchObject({
          model: config.model,
          prompt: "Draw a blue circle.",
          quality: "low",
        })
        return Response.json({
          data: [{ b64_json: "aW1n", revised_prompt: "blue circle" }],
        })
      },
    )
    copilotToolImageDependencies.forward = images
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        request({ tool_choice: { type: "image_generation" } }),
      ),
    })
    expect(response.status).toBe(200)
    const result = (await response.json()) as ResponsesResult
    expect(result).toMatchObject({
      status: "completed",
      model: "gpt-6-luna",
      tool_choice: { type: "image_generation" },
      tools: [image, other],
    })
    expect(result.output[0]).toMatchObject({
      type: "image_generation_call",
      result: "aW1n",
      status: "completed",
      revised_prompt: "blue circle",
    })
    expect(result.output[0].id).toMatch(/^ig_/u)
    expect(result.output[1]).toEqual(call("lookup", "call_2"))
    expect(images).toHaveBeenCalledTimes(1)
    expect(upstream).toHaveBeenCalledTimes(1)
  })
  test("a Codex custom provider can generate when its client only declares ordinary tools", async () => {
    responsesHandlerDependencies.getCopilotImageGenerationConfig = () => config
    responsesHandlerDependencies.findEndpointModel = () =>
      ({
        id: "gpt-6-luna",
        supported_endpoints: ["/responses"],
        capabilities: { limits: {} },
      }) as ReturnType<typeof responsesHandlerDependencies.findEndpointModel>
    responsesHandlerDependencies.createResponses = (payload) => {
      const hosted = payload.tools?.find(
        (t) => t.type === "function" && t.name !== "lookup",
      )
      const output =
        hosted && "name" in hosted && typeof hosted.name === "string" ?
          [call(hosted.name)]
        : []
      return Promise.resolve({
        ...createResponsesResult(payload.model),
        tools: payload.tools ?? [],
        output,
      })
    }
    const dispatch = mock<typeof copilotToolImageDependencies.forward>(() =>
      Promise.resolve(Response.json({ data: [{ b64_json: "aW1n" }] })),
    )
    copilotToolImageDependencies.forward = dispatch
    for (const [ua, expected] of [
      ["codex_cli_rs/0.153.4", true],
      ["other-api-client", false],
    ] as const) {
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": ua },
        body: JSON.stringify(request({ tools: [other] })),
      })
      expect(response.status).toBe(200)
      const result = (await response.json()) as ResponsesResult
      expect(result.output.map((i) => i.type)).toEqual(
        expected ? ["image_generation_call"] : [],
      )
      expect(result.tools.map((t) => t.type)).toEqual(
        expected ? ["function", "image_generation"] : ["function"],
      )
    }
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  test("auto advertising preserves explicit tool restrictions and replaces the image client namespace only once", () => {
    const namespace = {
      type: "namespace",
      name: "image_gen",
      tools: [{ ...other, name: "imagegen" }],
    }
    const codex = request({
      tools: [other, namespace],
      input: [
        { type: "additional_tools", role: "developer", tools: [namespace] },
      ],
    })
    offerCodexImageTool(codex)
    offerCodexImageTool(codex)
    expect(codex.tools).toEqual([other, { type: "image_generation" }])
    expect(codex.input).toMatchObject([{ tools: [] }])
    for (const choice of [
      "none",
      "required",
      { type: "function", name: "lookup" },
    ] as const) {
      const constrained = request({ tools: [other], tool_choice: choice })
      offerCodexImageTool(constrained)
      expect(constrained.tools).toEqual([other])
    }
    const toolFree = request({ tools: [] })
    offerCodexImageTool(toolFree)
    expect(toolFree.tools).toEqual([])
  })
  test("a Messages-backed GHCP chat model can select the same tool", async () => {
    responsesHandlerDependencies.resolveMappedModel = (model) => model
    responsesHandlerDependencies.findEndpointModel = () => undefined
    responsesHandlerDependencies.getCopilotImageGenerationConfig = () => config
    responsesMessagesDependencies.handleCompletionPayload = (_c, payload) => {
      const name = payload.tools?.[0]?.name
      if (!name) throw new Error("Missing translated tool")
      return Promise.resolve(
        Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: payload.model,
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name,
              input: { prompt: "A circle", action: "generate" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      )
    }
    const images = mock<typeof copilotToolImageDependencies.forward>(() =>
      Promise.resolve(Response.json({ data: [{ b64_json: "aW1n" }] })),
    )
    copilotToolImageDependencies.forward = images
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "user-agent": "codex_cli_rs/0.165.0",
        "content-type": "application/json",
      },
      body: JSON.stringify(request({ model: "claude-test" })),
    })
    expect(response.status).toBe(200)
    expect(
      ((await response.json()) as ResponsesResult).output[0],
    ).toMatchObject({
      type: "image_generation_call",
      result: "aW1n",
    })
    expect(images).toHaveBeenCalledTimes(1)
  })
  test("preserves ordinary output without generating, including a colliding user function", async () => {
    const payload = request({
      tools: [{ ...other, name: "copilot_generate_image" }, image],
    })
    const execute = runImage()
    const bridge = prepareCopilotImageTool(payload, config, execute)!
    expect(bridge.name).not.toBe("copilot_generate_image")
    const result = {
      ...createResponsesResult(payload.model),
      output: [call("copilot_generate_image")],
    }
    const out = await bridgeImageToolJson(Response.json(result), bridge, signal)
    expect(((await out.json()) as ResponsesResult).output).toEqual(
      result.output,
    )
    expect(execute).not.toHaveBeenCalled()
  })
  test("replays generated images as input and uses the latest references for an edit", async () => {
    const input = [
      {
        type: "image_generation_call",
        id: "ig_old",
        status: "completed",
        result: "/9j/aW1n",
        revised_prompt: "old",
      },
      {
        type: "image_generation_call",
        id: "ig_second",
        status: "completed",
        result: "UklGRg==",
      },
      { role: "user" as const, content: "Make them green." },
    ]
    const payload = request({ input })
    const execute = runImage()
    const bridge = prepareCopilotImageTool(payload, config, execute)!
    expect(input[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Previous image generation: old" },
        { type: "input_image", image_url: "data:image/jpeg;base64,/9j/aW1n" },
      ],
    })
    await bridge.run(
      '{"prompt":"Make them green.","action":"edit"}',
      "ig_test",
      signal,
    )
    expect(execute.mock.calls[0][0]).toMatchObject({
      tool: { action: "edit" },
      inputImages: [
        { image_url: "data:image/jpeg;base64,/9j/aW1n" },
        { image_url: "data:image/webp;base64,UklGRg==" },
      ],
    })
  })
  test("explicit current user images override older images, config pins the backend model", async () => {
    const payload = request({
      tools: [{ ...image, model: "client-default", action: "edit" }],
      input: [
        { role: "user", content: [{ type: "input_image", image_url: "old" }] },
        {
          role: "user",
          content: [
            { type: "input_image", file_id: "file1" },
            { type: "input_image", image_url: "new" },
            { type: "input_text", text: "edit these" },
          ],
        },
      ],
    })
    const execute = runImage()
    await prepareCopilotImageTool(
      payload,
      { enabled: true, model: "configured-ghcp-model" },
      execute,
    )!.run('{"prompt":"edit","action":"generate"}', "ig_test", signal)
    expect(execute.mock.calls[0][0]).toMatchObject({
      model: "configured-ghcp-model",
      tool: { action: "edit" },
      inputImages: [{ file_id: "file1" }, { image_url: "new" }],
    })
  })
  test("resolves additional_tools and hosted selections without duplicating declarations", async () => {
    const payload = request({
      tools: [other],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "image_generation" },
          { type: "function", name: "lookup" },
        ],
      },
      input: [
        { role: "developer", type: "additional_tools", tools: [image, image] },
      ],
    })
    const execute = runImage()
    const bridge = prepareCopilotImageTool(payload, config, execute)!
    expect(payload.input).toMatchObject([
      { tools: [{ type: "function", name: bridge.name }] },
    ])
    expect(payload.tool_choice).toMatchObject({
      tools: [
        { type: "function", name: bridge.name },
        { type: "function", name: "lookup" },
      ],
    })
    await bridge.run('{"prompt":"ok"}', "ig_test", signal)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  test("disabled mode keeps unrelated tools and reports a forced unavailable tool", () => {
    const off = { ...config, enabled: false }
    const payload = request({ tool_choice: "auto" })
    expect(prepareCopilotImageTool(payload, off)).toBeUndefined()
    expect(payload.tools).toEqual([other])
    const plain = request({ tools: [image], tool_choice: "auto" })
    prepareCopilotImageTool(plain, off)
    expect(plain.tool_choice).toBeUndefined()
    expect(() =>
      prepareCopilotImageTool(
        request({ tool_choice: { type: "image_generation" } }),
        off,
      ),
    ).toThrow("disabled")
    expect(() =>
      prepareCopilotImageTool(
        request({ tools: [image], tool_choice: "required" }),
        off,
      ),
    ).toThrow("disabled")
    expect(() =>
      prepareCopilotImageTool(
        request({ tools: [], tool_choice: { type: "image_generation" } }),
        config,
      ),
    ).toThrow("requires")
  })
  test("tool_choice none or another forced client tool cannot trigger an Images request", async () => {
    for (const choice of [
      "none",
      { type: "function", name: "lookup" },
      {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "lookup" }],
      },
    ] as const) {
      const execute = runImage()
      const bridge = prepareCopilotImageTool(
        request({
          tool_choice: structuredClone(
            choice,
          ) as ResponsesPayload["tool_choice"],
        }),
        config,
        execute,
      )!
      await rejects(
        bridge.run('{"prompt":"draw"}', "ig_test", signal),
        /Unexpected/u,
      )
      expect(execute).not.toHaveBeenCalled()
    }
  })
  test("invalid, incomplete and duplicate calls never cause extra image charges", async () => {
    const execute = runImage()
    const bridge = prepareCopilotImageTool(request(), config, execute)!
    for (const args of ["not json", "{}", "[]"]) {
      await rejects(bridge.run(args, "ig_test", signal), /invalid arguments/u)
    }
    const result = {
      ...createResponsesResult("gpt"),
      output: [
        call(bridge.name),
        call(bridge.name),
        { ...call(bridge.name, "unfinished"), status: "incomplete" },
      ],
    }
    const body = (await (
      await bridgeImageToolJson(Response.json(result), bridge, signal)
    ).json()) as ResponsesResult
    expect(execute).toHaveBeenCalledTimes(1)
    expect(body.output[0]).toEqual(body.output[1])
    expect(body.output[2]).toMatchObject({
      type: "image_generation_call",
      status: "failed",
      result: "",
    })
    await rejects(
      bridgeImageToolJson(Response.json({}), bridge, signal),
      /Invalid upstream/u,
    )
  })
})
