import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("Bun receives compressed frames even when a bundled undici client is present", () => {
  // Isolate native networking from the shared undici mocks in the protocol suites.
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
      import assert from "node:assert/strict"
      import { mock } from "bun:test"
      await mock.module("undici", () => ({ WebSocket: class {
        static CONNECTING = 0
        static OPEN = 1
        constructor() { throw new Error("bundled undici must not be used on Bun") }
      } }))
      const { createPooledWebSocketStream } = await import("./src/services/responses-websocket")
      let extensions = ""
      let authorization = ""
      const content = "compressed-response-".repeat(2048)
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request, server) {
          extensions = request.headers.get("sec-websocket-extensions") ?? ""
          authorization = request.headers.get("authorization") ?? ""
          if (server.upgrade(request)) return
          return new Response("upgrade required", { status: 426 })
        },
        websocket: {
          perMessageDeflate: true,
          message(ws, data) {
            assert.equal(JSON.parse(String(data)).model, "test-local")
            ws.sendText(JSON.stringify({ type: "response.completed", content }), true)
          },
        },
      })
      try {
        const stream = createPooledWebSocketStream({
          headers: { authorization: "Bearer local-test-only" },
          payload: { model: "test-local" }, poolKey: "native-bun-compression",
          url: "ws://127.0.0.1:" + server.port + "/responses",
        }, {
          createChunk: (data) => JSON.parse(data), getTerminalDisposition: () => "discard",
          maxBufferedBytes: 1024 * 1024, maxBufferedMessages: 16,
          openErrorMessage: "open failed", openTimeoutMs: 2000, poolIdleTimeoutMs: 100,
          streamErrorMessage: "stream failed", streamInactivityTimeoutMs: 2000,
          terminalChunkMissingMessage: "terminal missing",
        })
        const chunks = []
        for await (const chunk of stream) chunks.push(chunk)
        assert.ok(extensions.includes("permessage-deflate"))
        assert.equal(authorization, "Bearer local-test-only")
        assert.deepEqual(chunks, [{ type: "response.completed", content }])
      } finally {
        await server.stop(true)
      }
    `,
    ],
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
    },
    timeout: 10_000,
  })
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
}, 15_000)
