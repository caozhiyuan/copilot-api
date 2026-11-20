import { describe, expect, test } from "bun:test"

import {
  CODEX_MODEL_CATALOG_MAX_BYTES,
  normalizeCodexInstructions,
  resolveCodexCatalogCompatibility,
  serializeCodexModelCatalog,
} from "~/lib/catalog/codex-model-catalog"
import {
  FULL_MODEL_CATALOG_HEADER,
  stripInternalRequestHeaders,
} from "~/lib/http/internal-headers"
import type { CodexModel, CodexModelsResponse } from "~/lib/types/codex-models"
import catalog from "~/routes/models/models.json"

const fallback: CodexModel["model_messages"] = {
  instructions_template: "fallback",
  instructions_variables: null,
  approvals: null,
  auto_review: null,
  permissions: null,
}
function model(slug: string): CodexModel {
  return {
    ...(catalog.models[0] as unknown as CodexModel),
    slug,
    model_messages: { ...fallback, instructions_template: "canonical" },
    base_instructions: "legacy",
  }
}
function serialize(
  response: CodexModelsResponse,
  overrides: Partial<Parameters<typeof serializeCodexModelCatalog>[1]> = {},
) {
  return serializeCodexModelCatalog(response, {
    headers: new Headers(),
    modern: true,
    supportsLargeCatalog: false,
    explicitSlugs: new Set(),
    fallback,
    ...overrides,
  })
}
function parse(body: string | null): CodexModelsResponse {
  expect(body).not.toBeNull()
  return JSON.parse(body!) as CodexModelsResponse
}

describe("Codex model catalog", () => {
  test.each([
    ["0.159.9", false, false],
    ["0.160.0", true, false],
    ["0.160.0-alpha.1", true, false],
    ["0.165.9", true, false],
    ["0.166.0-alpha.1", true, false],
    ["0.166.0", true, true],
    ["0.166.0+build.1", true, true],
    ["0.166.1-rc.1", true, true],
    ["0.167.0-alpha.1", true, true],
    ["1.0.0", true, true],
  ])(
    "recognizes client_version %s",
    (version, modern, supportsLargeCatalog) => {
      expect(
        resolveCodexCatalogCompatibility(
          `http://localhost/models?client_version=${encodeURIComponent(version)}`,
          new Headers(),
        ),
      ).toEqual({ modern, supportsLargeCatalog })
    },
  )
  test("uses valid versions in query, header, and UA priority order", () => {
    const headers = new Headers({
      version: "0.165.0",
      "user-agent": "codex-tui/0.169.0",
    })
    expect(
      resolveCodexCatalogCompatibility(
        "http://localhost/models?client_version=0.165.0&client_version=0.166.0",
        headers,
      ),
    ).toEqual({ modern: true, supportsLargeCatalog: true })
    expect(
      resolveCodexCatalogCompatibility(
        "http://localhost/models?client_version=invalid",
        headers,
      ),
    ).toEqual({ modern: true, supportsLargeCatalog: false })

    headers.delete("version")
    expect(
      resolveCodexCatalogCompatibility("http://localhost/models", headers),
    ).toEqual({ modern: true, supportsLargeCatalog: true })
    headers.set("user-agent", "codex-tui/0.166.0-alpha.1 (Linux)")
    expect(
      resolveCodexCatalogCompatibility("http://localhost/models", headers),
    ).toEqual({ modern: true, supportsLargeCatalog: false })
    expect(
      resolveCodexCatalogCompatibility(
        "http://localhost/models",
        new Headers(),
      ),
    ).toEqual({ modern: false, supportsLargeCatalog: false })
  })
  test("preserves canonical templates and unknown fields without mutating inputs", () => {
    const original = { ...model("canonical"), custom: { retained: true } }
    const normalized = normalizeCodexInstructions(original, true, fallback)
    expect(normalized).not.toHaveProperty("base_instructions")
    expect(normalized.model_messages.instructions_template).toBe("canonical")
    expect(normalized.custom).toEqual({ retained: true })
    expect(original.base_instructions).toBe("legacy")
    expect(normalizeCodexInstructions(original, false, fallback)).toBe(original)
  })
  test("promotes legacy-only instructions and falls back when both are missing", () => {
    const legacy = model("legacy")
    // Older upstream catalogs can omit Model Messages entirely.
    Reflect.deleteProperty(legacy, "model_messages")
    expect(
      normalizeCodexInstructions(legacy, true, fallback).model_messages
        .instructions_template,
    ).toBe("legacy")
    delete legacy.base_instructions
    expect(
      normalizeCodexInstructions(legacy, true, fallback).model_messages
        .instructions_template,
    ).toBe("fallback")
    legacy.model_messages = {
      ...fallback,
      instructions_template: undefined as unknown as string,
    }
    expect(
      normalizeCodexInstructions(legacy, true, fallback).model_messages
        .instructions_template,
    ).toBe("fallback")
  })
  test("returns more than 20 models within the byte budget and retains their original order", () => {
    const models = Array.from({ length: 25 }, (_, i) => model(`model-${i}`))
    const body = parse(
      serialize(
        { models, extra: { preserved: true } },
        { explicitSlugs: new Set(["model-24"]) },
      ),
    )
    expect(body.models).toHaveLength(25)
    expect(body.models.at(-1)?.slug).toBe("model-24")
    expect(body.models.map((m) => m.slug)).toEqual(models.map((m) => m.slug))
    expect(body.extra).toEqual({ preserved: true })
  })
  test("prioritizes explicit models when the byte budget cannot fit every model", () => {
    const models = Array.from({ length: 25 }, (_, i) => model(`model-${i}`))
    for (const item of models)
      item.model_messages.instructions_template = "x".repeat(50_000)
    const body = parse(
      serialize({ models }, { explicitSlugs: new Set(["model-24"]) }),
    )
    expect(body.models.length).toBeLessThan(25)
    expect(body.models.at(-1)?.slug).toBe("model-24")
    expect(body.models.some((item) => item.slug === "model-23")).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      CODEX_MODEL_CATALOG_MAX_BYTES,
    )
  })
  test("accepts exactly 1 MiB, counts UTF-8 bytes, and skips oversized entries", () => {
    const boundary = model("boundary")
    delete boundary.base_instructions
    boundary.model_messages.instructions_template = ""
    const overhead = Buffer.byteLength(JSON.stringify({ models: [boundary] }))
    boundary.model_messages.instructions_template = "x".repeat(
      CODEX_MODEL_CATALOG_MAX_BYTES - overhead,
    )
    const body = serialize({ models: [boundary, model("small")] })!
    expect(Buffer.byteLength(body)).toBe(CODEX_MODEL_CATALOG_MAX_BYTES)
    expect(parse(body).models.map((m) => m.slug)).toEqual(["boundary"])
    boundary.model_messages.instructions_template += "🙂"
    expect(
      parse(serialize({ models: [boundary, model("small")] })).models.map(
        (m) => m.slug,
      ),
    ).toEqual(["small"])
  })
  test("accounts for envelope metadata and rejects metadata alone above the budget", () => {
    expect(
      serialize({
        models: [],
        metadata: "x".repeat(CODEX_MODEL_CATALOG_MAX_BYTES),
      }),
    ).toBeNull()
    expect(parse(serialize({ models: [] })).models).toEqual([])
  })
  test("full export bypasses the size limit but still normalizes instructions", () => {
    const models = Array.from({ length: 30 }, (_, i) => model(`model-${i}`))
    models[0].model_messages.instructions_template = "x".repeat(
      CODEX_MODEL_CATALOG_MAX_BYTES,
    )
    const headers = new Headers({ "X-Full-Model-Catalog": " TRUE " })
    const body = serialize({ models }, { headers })!
    expect(Buffer.byteLength(body)).toBeGreaterThan(
      CODEX_MODEL_CATALOG_MAX_BYTES,
    )
    expect(parse(body).models).toHaveLength(30)
    expect(parse(body).models[0]).not.toHaveProperty("base_instructions")
    headers.set(FULL_MODEL_CATALOG_HEADER, "false")
    expect(parse(serialize({ models }, { headers })).models).toHaveLength(29)
  })
  test("excludes older models above 20 candidates, including aliases, unless explicitly selected", () => {
    const old = [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5",
      "claude-sonnet-5",
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gpt-5.3-codex",
      "gpt-5.4-mini",
      "gpt-5.4",
      "grok-4.5",
      "gpt-5-mini",
      "mai-code-1.1-flash",
    ]
    const oldModels = old.flatMap((id) => [model(id), model(`codex/${id}`)])
    const models = [
      ...oldModels,
      model("gpt-5.6-luna"),
      model("codex/gpt-5.6-luna"),
      ...Array.from({ length: 20 }, (_, i) => model(`new-${i}`)),
    ]
    const ordinary = parse(serialize({ models }))
    expect(ordinary.models.map((m) => m.slug)).toEqual(
      models.slice(oldModels.length).map((m) => m.slug),
    )
    expect(
      parse(serialize({ models }, { supportsLargeCatalog: true })),
    ).toEqual(ordinary)
    const explicit = parse(
      serialize({ models }, { explicitSlugs: new Set(["codex/gpt-5.5"]) }),
    )
    expect(explicit.models[0].slug).toBe("codex/gpt-5.5")
    expect(
      parse(serialize({ models: oldModels.slice(0, 20) })).models,
    ).toHaveLength(20)
    expect(
      parse(
        serialize(
          { models },
          { headers: new Headers({ [FULL_MODEL_CATALOG_HEADER]: "true" }) },
        ),
      ).models,
    ).toHaveLength(models.length)
  })
  test.each(["true", "false", "1"])(
    "strips internal header value %s and preserves the request",
    (value) => {
      const headers = new Headers({
        "X-FULL-MODEL-CATALOG": value,
        "x-request-id": "test",
      })
      const forwarded = stripInternalRequestHeaders(headers)
      expect(forwarded.has(FULL_MODEL_CATALOG_HEADER)).toBe(false)
      expect(forwarded.get("x-request-id")).toBe("test")
      expect(headers.get(FULL_MODEL_CATALOG_HEADER)).toBe(value)
    },
  )
})
