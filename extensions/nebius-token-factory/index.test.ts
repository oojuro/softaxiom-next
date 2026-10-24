import { once } from "node:events";
import { createServer } from "node:http";
import type { Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { expect, it, onTestFinished } from "vitest";
import { discovery } from "./catalog.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

it("discovers the key-scoped verbose catalog through the registered provider", async () => {
  const requests: { url?: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [{ id: "openai/gpt-oss-synthetic", context_length: 16000, max_output_tokens: 2000 }],
      }),
    );
  }).listen(0, "127.0.0.1");
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing server port");
  }
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await provider.catalog?.run({
    config: {
      models: {
        providers: {
          [provider.id]: { baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [] },
        },
      },
    },
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "synthetic-key" }),
    resolveProviderAuth: () => ({ apiKey: "synthetic-key", mode: "api_key", source: "profile" }),
  });
  expect(requests).toEqual([
    { url: "/v1/models?verbose=true", authorization: "Bearer synthetic-key" },
  ]);
  expect(catalog && "provider" in catalog ? catalog.provider.models : []).toEqual([
    expect.objectContaining({
      id: "openai/gpt-oss-synthetic",
      contextWindow: 16000,
      maxTokens: 2000,
      reasoning: true,
    }),
  ]);
  expect(provider.auth[0]?.wizard?.choiceId).toBe("nebius-token-factory-api-key");
  expect(provider.envVars).toEqual(["NEBIUS_API_KEY", "NEBIUS_TOKEN_FACTORY_API_KEY"]);
});

it("projects supported reasoning and native tool requests without unsupported OpenAI fields", () => {
  const fallback = {
    api: "openai-completions" as const,
    baseUrl: manifest.modelCatalog.providers["nebius-token-factory"].baseUrl,
    models: [],
  };
  const row = discovery.projectRows?.([{ id: "Qwen/Qwen3-synthetic" }], fallback)[0];
  if (!row) {
    throw new Error("No projected model");
  }
  const model: Model<"openai-completions"> = {
    ...row,
    input: ["text"],
    contextWindow: row.contextWindow ?? 4096,
    api: "openai-completions",
    provider: "nebius-token-factory",
    baseUrl: fallback.baseUrl,
  };
  const payload = buildOpenAICompletionsParams(
    model,
    {
      messages: [{ role: "user", content: "Read memory", timestamp: 1 }],
      tools: [
        {
          name: "memory_search",
          description: "Search memory",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    },
    { reasoning: "high", maxTokens: 128 },
  );
  expect(payload).toMatchObject({
    reasoning_effort: "high",
    max_tokens: 128,
    tools: [{ type: "function", function: { name: "memory_search" } }],
  });
  expect(payload).not.toHaveProperty("store");
});
