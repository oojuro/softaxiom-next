import {
  registerProviderPlugins,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

it("keeps Chat Completions and Bearer Messages as distinct selectable auth/model routes", async () => {
  const providers = await registerProviderPlugins(plugin);
  const chat = requireRegisteredProvider(providers, "commandcode");
  const anthropic = requireRegisteredProvider(providers, "commandcode-anthropic");
  expect(chat.auth[0]?.wizard?.choiceId).toBe("commandcode-api-key");
  expect(anthropic.auth[0]?.wizard?.choiceId).toBe("commandcode-anthropic-api-key");
  expect(chat.envVars).toEqual(["COMMANDCODE_API_KEY"]);
  expect(anthropic.envVars).toEqual(["COMMANDCODE_API_KEY"]);
  const chatConfig = manifest.modelCatalog.providers.commandcode;
  const anthropicConfig = manifest.modelCatalog.providers["commandcode-anthropic"];
  expect(chatConfig).toMatchObject({
    api: "openai-completions",
    baseUrl: "https://api.commandcode.ai/provider/v1",
  });
  expect(anthropicConfig).toMatchObject({
    api: "anthropic-messages",
    authHeader: true,
    baseUrl: chatConfig.baseUrl,
  });
  expect(anthropic.aliases).toEqual(["commandcode-claude"]);
});

it("uses the public catalog without disclosing keys and filters the Messages route", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { onTestFinished } = await import("vitest");
  const authorization: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    authorization.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "claude-synthetic" }, { id: "deepseek/synthetic" }] }));
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
      resolveProviderApiKey: () => ({ apiKey: "synthetic-secret" }),
      resolveProviderAuth: () => ({
        apiKey: "synthetic-secret",
        mode: "api_key",
        source: "profile",
      }),
    });
    const config = result && "provider" in result ? result.provider : undefined;
    expect(config?.models.map((model) => model.id)).toEqual(
      provider.id === "commandcode"
        ? ["claude-synthetic", "deepseek/synthetic"]
        : ["claude-synthetic"],
    );
    if (provider.id === "commandcode-anthropic") {
      expect(config).toMatchObject({ api: "anthropic-messages", authHeader: true });
    }
  }
  expect(authorization).toEqual([undefined, undefined]);
});
