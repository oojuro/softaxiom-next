import type { Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { expect, it } from "vitest";
import { discovery } from "./catalog.js";
import plugin from "./index.js";

it("exposes Solar setup and keeps legacy non-reasoning models distinct", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.aliases).toEqual(["solar"]);
  expect(provider.auth[0]?.wizard?.choiceId).toBe("upstage-api-key");
  expect(
    provider.resolveThinkingProfile?.({ provider: "upstage", modelId: "solar-pro3" })?.defaultLevel,
  ).toBe("medium");
  expect(
    provider.resolveThinkingProfile?.({ provider: "upstage", modelId: "solar-mini-250422" }),
  ).toBeUndefined();
  const fallback = {
    api: "openai-completions" as const,
    baseUrl: "https://api.upstage.ai/v1",
    models: [],
  };
  const rows = discovery.projectRows?.(
    [{ id: "solar-pro3" }, { id: "solar-mini-250422" }],
    fallback,
  );
  const reasoning = rows?.find((model) => model.id === "solar-pro3");
  const plain = rows?.find((model) => model.id === "solar-mini-250422");
  expect(plain?.reasoning).toBe(false);
  if (!reasoning) {
    throw new Error("Missing reasoning model");
  }
  const model: Model<"openai-completions"> = {
    ...reasoning,
    input: ["text"],
    contextWindow: reasoning.contextWindow ?? 4096,
    provider: "upstage",
    api: "openai-completions",
    baseUrl: fallback.baseUrl,
  };
  const payload = buildOpenAICompletionsParams(
    model,
    { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
    { reasoning: "high", maxTokens: 100 },
  );
  expect(payload).toMatchObject({ reasoning_effort: "high", max_tokens: 100 });
  expect(payload).not.toHaveProperty("store");
});
