export const modelsDevReleaseModelsFixture = {
  "qwen-plus": { id: "qwen-plus", release_date: "2024-01-25" },
  "before-cutoff": { id: "before-cutoff", release_date: "2026-04-30" },
  "on-cutoff": { id: "on-cutoff", release_date: "2026-05-01" },
  "after-cutoff": { id: "after-cutoff", release_date: "2026-05-02" },
  "unknown-date": { id: "unknown-date" },
  "invalid-date": { id: "invalid-date", release_date: "invalid" },
}

// A small, stable models.dev response for catalog and route tests.
export const modelsDevCatalogFixture = {
  "opencode-go": {
    id: "opencode-go",
    npm: "@ai-sdk/openai-compatible",
    models: {
      hy3: {
        id: "hy3",
        name: "Hy3",
        family: "Hy",
        reasoning_options: [{ type: "effort", values: ["none", "high"] }],
        limit: { context: 1_024_000, output: 64_000 },
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0.14, output: 0.58, cache_read: 0.035 },
      },
      "hy4-preview": {
        id: "hy4-preview",
        name: "Hy4 Preview",
        family: "Hy",
        reasoning_options: [{ type: "effort", values: ["none", "high"] }],
        limit: { context: 1_024_000, output: 64_000 },
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0.834, output: 2.501, cache_read: 0.042 },
      },
      "gpt-6-luna": {
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        provider: { npm: "@ai-sdk/openai" },
        reasoning_options: [
          { type: "effort", values: ["none", "low", "high", "max"] },
        ],
        limit: { context: 1_050_000, output: 128_000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        cost: {
          input: 0.1,
          output: 0.5,
          cache_read: 0.01,
          cache_write: 0.125,
          tiers: [
            {
              input: 0.2,
              output: 0.75,
              cache_read: 0.02,
              cache_write: 0.25,
              tier: { type: "context", size: 272_000 },
            },
          ],
        },
      },
      "gpt-5.6-luna": {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: { npm: "@ai-sdk/openai" },
        cost: { input: 0.1, output: 0.5 },
      },
      "glm-5.3-flash": {
        id: "glm-5.3-flash",
        name: "GLM-5.3-Flash",
        limit: { context: 1_000_000, output: 131_072 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
      },
      "deepseek-v4.1-flash": {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        limit: { context: 1_000_000, output: 384_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        limit: { context: 1_000_000, output: 64_000 },
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0.66, output: 1.98, cache_read: 0.022 },
      },
      "qwen3.7-plus": {
        id: "qwen3.7-plus",
        name: "Qwen3.7 Plus",
        limit: { context: 1_000_000, output: 64_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0.4, output: 1.6, cache_read: 0.04 },
      },
      "qwen3.8-max": {
        id: "qwen3.8-max",
        name: "Qwen3.8 Max",
        cost: { input: 2, output: 6, cache_read: 0.25 },
      },
      "qwen3.8-flash": {
        id: "qwen3.8-flash",
        name: "Qwen3.8 Flash",
        provider: { npm: "@ai-sdk/anthropic" },
        status: "beta",
        cost: { input: 0.15, output: 0.47, cache_read: 0.016 },
      },
      "minimax-m3": {
        id: "minimax-m3",
        name: "MiniMax M3",
        provider: { npm: "@ai-sdk/anthropic" },
        cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
      },
      "grok-4.7": {
        id: "grok-4.7",
        name: "Grok 4.7",
        provider: { npm: "@ai-sdk/openai" },
        family: "grok",
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high", "xhigh"] },
        ],
        cost: { input: 2, output: 6, cache_read: 0.5 },
      },
      "grok-4.5": {
        id: "grok-4.5",
        name: "Grok 4.5",
        status: "deprecated",
        cost: { input: 2, output: 6 },
      },
      "ox-alpha-free": {
        id: "ox-alpha-free",
        name: "Ox Alpha Free",
        status: "deprecated",
        cost: { input: 0, output: 0 },
      },
      "gpt-provider-only": {
        id: "gpt-provider-only",
        name: "GPT Provider Only",
        cost: { input: 1, output: 2 },
      },
    },
  },
}

export const modelsDevProviderCatalogFixture = {
  ...modelsDevCatalogFixture,
  "alibaba-cn": {
    models: {
      "deepseek-v4.1-flash": {
        ...modelsDevCatalogFixture["opencode-go"].models["deepseek-v4.1-flash"],
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
      "glm-5.3": {
        id: "glm-5.3",
        name: "GLM 5.3",
        limit: { context: 1_000_000, output: 64_000 },
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
      "qwen3.7-plus": {
        ...modelsDevCatalogFixture["opencode-go"].models["qwen3.7-plus"],
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "xhigh"] },
        ],
      },
      "qwen3.8-max": {
        ...modelsDevCatalogFixture["opencode-go"].models["qwen3.8-max"],
        limit: { context: 1_000_000, output: 64_000 },
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "xhigh"] },
        ],
      },
      "qwen3.8-flash": {
        ...modelsDevCatalogFixture["opencode-go"].models["qwen3.8-flash"],
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "xhigh"] },
        ],
      },
      "kimi-k3": {
        id: "kimi-k3",
        name: "Kimi K3",
        limit: { context: 1_048_576, output: 64_000 },
        reasoning_options: [{ type: "effort", values: ["max"] }],
        cost: { input: 3, output: 15, cache_read: 0.3 },
      },
    },
  },
  deepseek: {
    models: {
      "deepseek-flash": {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        limit: { context: 1_000_000, output: 393_216 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
      },
      "deepseek-v4-pro":
        modelsDevCatalogFixture["opencode-go"].models["deepseek-v4-pro"],
    },
  },
  "kimi-code-plan-cn": {
    models: {
      k3: {
        id: "k3",
        name: "Kimi K3",
        limit: { context: 1_048_576, output: 64_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        cost: { input: 0, output: 0, cache_read: 0 },
      },
      "k3-256k": {
        id: "k3-256k",
        name: "Kimi K3 256K",
        limit: { context: 262_144, output: 64_000 },
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
  xai: {
    npm: "@ai-sdk/xai",
    models: {
      "grok-4.7": {
        ...modelsDevCatalogFixture["opencode-go"].models["grok-4.7"],
        limit: { context: 500_000, output: 500_000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      },
      "grok-catalog-only": { id: "grok-catalog-only", name: "Catalog Grok" },
    },
  },
  openrouter: {
    npm: "@openrouter/ai-sdk-provider",
    models: {
      "openai/gpt-5.1-codex": {
        id: "openai/gpt-5.1-codex",
        name: "OpenAI: GPT-5.1-Codex",
        limit: { context: 400_000, output: 128_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
    },
  },
}
