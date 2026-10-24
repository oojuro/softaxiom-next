import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import { discovery } from "./catalog.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

it("registers an account-scoped Responses-native route without invented catalog models", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.aliases).toEqual(["router", "ramp", "router.com"]);
  expect(provider.auth[0]?.wizard?.choiceId).toBe("ramp-router-api-key");
  expect(manifest.modelCatalog.providers["ramp-router"]).toMatchObject({
    api: "openai-responses",
    baseUrl: "https://api.router.com/v1",
    models: [],
    headers: { "User-Agent": "SoftAxiom/2026.10.4" },
  });
});

it("uses only account-catalog-declared reasoning effort capabilities", () => {
  const rows = discovery.projectRows?.(
    [
      {
        id: "synthetic-reasoner",
        router: {
          capabilities: {
            reasoning: {
              supported: true,
              efforts: [{ value: "low" }, { value: "high" }, { value: "unknown-native-tier" }],
            },
          },
        },
      },
      { id: "synthetic-plain", router: { capabilities: { reasoning: { supported: false } } } },
    ],
    { api: "openai-responses", baseUrl: "https://api.router.com/v1", models: [] },
  );
  expect(
    rows?.find((model) => model.id === "synthetic-reasoner")?.compat?.supportedReasoningEfforts,
  ).toEqual(["low", "high"]);
  expect(rows?.find((model) => model.id === "synthetic-plain")?.reasoning).toBe(false);
});

it("builds native Responses tool payloads rather than Chat Completions messages", async () => {
  const { streamSimple } = await import("openclaw/plugin-sdk/llm");
  const model = {
    id: "synthetic-router-model",
    name: "Synthetic",
    provider: "ramp-router",
    api: "openai-responses" as const,
    baseUrl: "https://api.router.com/v1",
    reasoning: true,
    input: ["text" as const],
    contextWindow: 4096,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let sent: unknown;
  const result = streamSimple(
    model,
    {
      messages: [{ role: "user", content: "Read memory", timestamp: 1 }],
      tools: [
        {
          name: "memory_search",
          description: "Search memory",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    {
      apiKey: "synthetic-key",
      onPayload: (payload) => {
        sent = payload;
        throw new Error("Synthetic stop before HTTP dispatch");
      },
    },
  );
  await result.result();
  expect(sent).toMatchObject({
    model: model.id,
    input: expect.any(Array),
    tools: [{ type: "function", name: "memory_search" }],
    store: false,
  });
  expect(sent).not.toHaveProperty("messages");
});
