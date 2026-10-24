import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import type { ProviderAuthContext } from "openclaw/plugin-sdk/provider-auth";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { applyNousPortalConfig, buildNousPortalProvider } from "./onboard.js";

const secret = "sk-nous-synthetic-not-a-real-key";
const prompter: WizardPrompter = {
  intro: async () => {},
  outro: async () => {},
  note: async () => {},
  select: async (params) => {
    if (!params.options[0]) {
      throw new Error("missing fixture choice");
    }
    return params.options[0].value;
  },
  multiselect: async (params) => params.initialValues ?? [],
  text: async () => secret,
  confirm: async () => false,
  progress: () => ({ update() {}, stop() {} }),
};
function authContext(key: string): ProviderAuthContext {
  return {
    config: {},
    env: { NOUS_API_KEY: key },
    prompter: { ...prompter, text: async () => key, confirm: async () => true },
    runtime: createNonExitingRuntime(),
    isRemote: false,
    secretInputMode: "plaintext",
    allowSecretRefPrompt: false,
    openUrl: async () => {},
    oauth: { createVpsAwareHandlers: vi.fn() },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Nous Portal API-key boundary", () => {
  it("uses native API-key onboarding and preserves other provider selections", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const method = provider.auth.find((value) => value.id === "api-key");
    if (!method) {
      throw new Error("API-key method missing");
    }
    const result = await method.run(authContext(secret));
    expect(result.profiles).toMatchObject([
      {
        profileId: "nous-portal:default",
        credential: { provider: "nous-portal", type: "api_key", key: secret },
      },
    ]);
    expect(result.configPatch?.models?.providers?.["nous-portal"]).toMatchObject({
      baseUrl: "https://inference-api.nousresearch.com/v1",
      api: "openai-completions",
    });
    expect(
      provider.auth.some((value) => value.kind === "oauth" || value.kind === "device_code"),
    ).toBe(false);
    const selected = applyNousPortalConfig({
      agents: {
        defaults: {
          model: "openai/existing",
          models: {
            "openai/existing": { alias: "Existing" },
          },
        },
      },
    });
    expect(selected.agents?.defaults?.model).toEqual("openai/existing");
    expect(selected.agents?.defaults?.models?.["openai/existing"]).toEqual({ alias: "Existing" });
  });

  it("does not turn OAuth access/inference JWTs into static API-key profiles", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const method = provider.auth.find((value) => value.id === "api-key");
    if (!method) {
      throw new Error("API-key method missing");
    }
    const jwt =
      Buffer.from('{"alg":"RS256"}').toString("base64url") +
      "." +
      Buffer.from('{"scope":"inference:invoke","exp":9999999999}').toString("base64url") +
      ".signature";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(method.run(authContext(jwt))).rejects.toThrow("Portal-generated API key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "synthetic/discovered-model"])(
    "uses native token limits and credentials for selected model %s",
    async (requestedModel) => {
      const provider = buildNousPortalProvider();
      const definition = provider.models[0];
      if (!definition) {
        throw new Error("documented model missing");
      }
      const model: Model = {
        ...definition,
        input: ["text"],
        id: requestedModel ?? definition.id,
        provider: "nous-portal",
        api: "openai-completions",
        baseUrl: provider.baseUrl,
      };
      const registered = await registerSingleProviderPlugin(plugin);
      const selected =
        registered.normalizeResolvedModel?.({
          provider: "nous-portal",
          modelId: model.id,
          model: { ...model, compat: undefined },
        }) ?? model;
      const response =
        [
          {
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 0,
            model: model.id,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Synthetic answer" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 0,
            model: model.id,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join("") + "data: [DONE]\n\n";
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(response, { headers: { "content-type": "text/event-stream" } }),
      );
      vi.stubGlobal("fetch", fetch);
      mockPinnedHostnameResolution();
      const output = await streamSimple(
        selected,
        { messages: [{ role: "user", content: "Synthetic request", timestamp: 0 }] },
        { apiKey: secret, maxTokens: 32 },
      ).result();
      expect(output.stopReason).toBe("stop");
      expect(output.content).toEqual([{ type: "text", text: "Synthetic answer" }]);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [request, init] = fetch.mock.calls[0]!;
      expect(String(request)).toBe("https://inference-api.nousresearch.com/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
      expect(JSON.parse(await new Response(init?.body).text())).toMatchObject({
        model: requestedModel ?? "Hermes-4.3-36B",
        max_tokens: 32,
      });
    },
  );
});
