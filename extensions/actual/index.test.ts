import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugins,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import plugin from "./index.js";
import { actualLocalBaseUrl } from "./local.js";
import { wrapActualThinking } from "./thinking.js";

it("keeps hosted credentials separate from explicit loopback-only keyless setup", async () => {
  const providers = await registerProviderPlugins(plugin);
  const hosted = requireRegisteredProvider(providers, "actual");
  const local = requireRegisteredProvider(providers, "actual-local");
  expect(hosted.auth[0]?.wizard?.choiceId).toBe("actual-api-key");
  expect(local.auth.map((method) => method.kind)).toEqual(["custom"]);
  expect(local.auth[0]?.wizard?.choiceId).toBe("actual-local");
  expect(actualLocalBaseUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1");
  for (const unsafe of [
    "https://api.actual.inc/v1",
    "http://localhost.attacker.test/v1",
    "http://user:secret@localhost/v1",
    "http://localhost/v1?key=secret",
  ]) {
    expect(() => actualLocalBaseUrl(unsafe)).toThrow();
  }
});

it("projects the relay's explicit reasoning-off control and preserves caller payload hooks", async () => {
  const payload: Record<string, unknown> = { messages: [] };
  const base: StreamFn = async (model, _context, options) => {
    await options?.onPayload?.(payload, model);
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  };
  const model: Model<"openai-completions"> = {
    id: "synthetic",
    name: "Synthetic",
    api: "openai-completions",
    provider: "actual",
    baseUrl: "https://api.actual.inc/v1",
    contextWindow: 4096,
    maxTokens: 100,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const wrapped = wrapActualThinking({
    provider: "actual",
    modelId: model.id,
    model,
    streamFn: base,
    thinkingLevel: "off",
  });
  await wrapped(
    model,
    { messages: [] },
    {
      onPayload: (value) => {
        expect(value).toMatchObject({ thinking: { type: "disabled" }, reasoning_effort: "none" });
      },
    },
  );
  expect(payload).toMatchObject({ thinking: { type: "disabled" }, reasoning_effort: "none" });
});

it("discovers the local route anonymously even when hosted credentials exist", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { onTestFinished } = await import("vitest");
  const authorization: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    authorization.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "synthetic-model" }] }));
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
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const providers = await registerProviderPlugins(plugin);
  for (const provider of providers) {
    const result = await provider.catalog?.run({
      config: { models: { providers: { [provider.id]: { baseUrl, models: [] } } } },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "synthetic-hosted-key" }),
      resolveProviderAuth: () => ({
        apiKey: "synthetic-hosted-key",
        mode: "api_key",
        source: "profile",
      }),
    });
    expect(
      result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
    ).toEqual(["synthetic-model"]);
  }
  expect(authorization).toEqual(["Bearer synthetic-hosted-key", undefined]);
});
