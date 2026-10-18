import { Options as Config, connectionOf } from "../config.js"
import { parseModels, reasoningEfforts } from "../models.js"
import { gatewayHeaders } from "../transport.js"
import { MODEL_ID, MODEL_LIST } from "./fixtures.ts"
import { userAgent } from "@deepseek-ai/dsh-llm"

// Same unit cases run in Bun (gateway convention) and Vitest (Harness convention).
export function modelCases({ describe, expect, it }) {
  describe("copilot-api model metadata", () => {
    it("retains IDs, capacities, images and only advertised selectable thinking levels", () => {
      expect(parseModels(MODEL_LIST, Config({}))).toMatchObject([{
        id: MODEL_ID, name: "Gateway Model", contextWindow: 128000, maxTokens: 16000, input: ["text", "image"],
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      }, { id: "provider/text-only", contextWindow: 8192, maxTokens: 1024, input: ["text"], reasoning: false }])
    })
    it("does not infer capabilities from model names or unknown effort values", () => {
      expect(parseModels({ data: [{ id: "claude-opus-vision", context_window: -1, max_output_tokens: "100", input_modalities: ["audio"], reasoning_efforts: ["future"] }] }, Config({})))
        .toMatchObject([{ contextWindow: 8192, maxTokens: 1024, input: ["text"], reasoning: false }])
      expect(reasoningEfforts(["off", "high"], "openai-responses")).toEqual({ high: "high" })
      expect(reasoningEfforts(["none"], "openai-responses")).toBe(false)
      expect(reasoningEfforts(undefined, "openai-responses")).toBe(false)
    })
    it("limits Messages efforts to values conveyed by its native thinking/effort mechanism", () => {
      expect(parseModels(MODEL_LIST, Config({ protocol: "anthropic-messages" }))[0]).toMatchObject({
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
        compat: { forceAdaptiveThinking: true },
      })
    })
    it("overrides one model without renaming its ID or erasing unrelated capabilities", () => {
      const models = parseModels(MODEL_LIST, Config({ modelOverrides: {
        [MODEL_ID]: { name: "Local name", contextWindow: 64000, maxTokens: 8000, input: ["text"], reasoningEfforts: { high: "high" } },
      } }))
      expect(models[0]).toMatchObject({ id: MODEL_ID, name: "Local name", contextWindow: 64000, maxTokens: 8000, input: ["text"], thinkingLevelMap: { high: "high", off: null, minimal: null, max: null } })
      expect(models[1]?.id).toBe("provider/text-only")
      expect(parseModels(MODEL_LIST, Config({ modelOverrides: { [MODEL_ID]: { name: "Renamed" } } }))[0])
        .toMatchObject({ name: "Renamed", input: ["text", "image"], thinkingLevelMap: { high: "high", xhigh: "xhigh" } })
      expect(parseModels(MODEL_LIST, Config({ modelOverrides: { [MODEL_ID]: { reasoningEfforts: false, input: [] } } }))[0])
        .toMatchObject({ reasoning: false, input: ["text", "image"] })
    })
    it("does not allow a manual off mapping to turn omission into claimed off support", () => {
      expect(parseModels(MODEL_LIST, Config({ modelOverrides: { [MODEL_ID]: { reasoningEfforts: { off: "", high: "high" } } } }))[0].thinkingLevelMap.off).toBeNull()
      expect(parseModels(MODEL_LIST, Config({ protocol: "anthropic-messages", modelOverrides: { [MODEL_ID]: { reasoningEfforts: { off: "none", high: "bogus" } } } }))[0].reasoning).toBe(false)
    })
    it.each([{}, { data: [{}] }, { data: [{ id: "duplicate" }, { id: "duplicate" }] }])("rejects a malformed complete catalog", payload => {
      expect(() => parseModels(payload, Config({}))).toThrow(expect.objectContaining({ code: "MODEL_DISCOVERY_FAILED" }))
    })
    it("normalizes both endpoint forms and validates configuration without echoing secrets", () => {
      for (const baseURL of ["http://localhost:4141", "http://localhost:4141/", "http://localhost:4141/v1/"]) {
        expect(connectionOf(Config({ baseURL, apiKey: "MY_COPILOT_KEY" }))).toEqual({ baseURL: "http://localhost:4141/v1", keyRef: "MY_COPILOT_KEY" })
      }
      for (const settings of [
        { baseURL: "invalid" }, { baseURL: "file:///tmp/example" }, { baseURL: "https://user:secret@example.com/v1" },
        { apiKey: "MY_KEY", apiKeyEnv: "OTHER_KEY" }, { headers: { "X-Key": "secret\nvalue" } }, { apiKey: "not a credential ref" },
      ]) expect(() => connectionOf(Config(settings))).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }))
    })
  })
  describe("copilot-api header precedence", () => {
    it("protects reserved headers, preserves SDK requirements and merges static headers case-insensitively", () => {
      const config = Config({ sessionAffinity: true, protocol: "anthropic-messages", headers: {
        AUTHORIZATION: "wrong", "X-API-KEY": "wrong", "Anthropic-Version": "wrong", "User-Agent": "claude-cli/wrong",
        "Content-Type": "text/plain", "X-Session-Affinity": "wrong", "x-deepseek-harness-session-id": "wrong",
        "X-Custom-Header": "custom", "Anthropic-Beta": "custom-beta,required-beta",
      } })
      const headers = gatewayHeaders(config, "real-key", new Headers({ "anthropic-beta": "required-beta", accept: "text/event-stream" }), { sessionId: "current-session" })
      expect(Object.fromEntries(headers)).toMatchObject({
        "x-api-key": "real-key", "anthropic-version": "2023-06-01", "user-agent": userAgent(),
        "content-type": "application/json", "x-custom-header": "custom", accept: "text/event-stream",
        "x-deepseek-harness-session-id": "current-session", "x-session-affinity": "current-session", "anthropic-beta": "required-beta,custom-beta",
      })
      expect(headers.has("authorization")).toBe(false)
      const discovery = gatewayHeaders(config, "real-key")
      expect(discovery.has("x-session-affinity")).toBe(false)
      expect(discovery.has("x-deepseek-harness-session-id")).toBe(false)
      expect(gatewayHeaders(Config({}), "key").get("authorization")).toBe("Bearer key")
    })
  })
}
