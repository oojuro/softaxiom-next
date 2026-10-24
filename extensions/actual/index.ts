// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { actualLocalBaseUrl, setupActualLocal } from "./local.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { thinkingProfile, wrapActualThinking } from "./thinking.js";

const local = defineSingleProviderPluginEntry({
  id: "actual-local",
  name: "Actual Local Provider",
  description: "Keyless Actual inference on an explicitly selected loopback server",
  manifest,
  provider: {
    label: "Actual Computer (local)",
    docsPath: "https://actual.inc/",
    auth: [],
    extraAuth: [
      {
        id: "local",
        label: "Actual local server (no key)",
        kind: "custom",
        wizard: {
          choiceId: "actual-local",
          choiceLabel: "Actual local server (no key)",
          groupId: "actual",
          groupLabel: "Actual Computer",
          methodId: "local",
        },
        run: setupActualLocal,
      },
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const configured = ctx.config.models?.providers?.["actual-local"];
        if (!configured) {
          return null;
        }
        return buildOpenAICompatibleLiveProviderCatalog({
          providerId: "actual-local",
          providerConfig: {
            baseUrl: actualLocalBaseUrl(configured.baseUrl),
            api: "openai-completions",
            auth: "none",
            models: configured.models,
          },
          modelDiscovery: { authentication: "none" },
          discoveryMode: "strict",
          signal: ctx.signal,
        });
      },
    },
    normalizeResolvedModel: ({ model }) => ({
      ...model,
      baseUrl: actualLocalBaseUrl(model.baseUrl),
    }),
    wrapStreamFn: wrapActualThinking,
    resolveThinkingProfile: () => thinkingProfile,
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
  },
});

export default defineSingleProviderPluginEntry({
  id: "actual",
  name: "Actual Computer Provider",
  description: "Separate hosted-key and local-keyless Actual Computer model routes",
  manifest,
  provider: {
    label: "Actual Computer",
    aliases: ["actual-computer", "actualcomputer", "aci"],
    docsPath: "https://actual.inc/",
    catalog: {
      buildProvider: () => ({
        baseUrl: manifest.modelCatalog.providers.actual.baseUrl,
        api: "openai-completions",
        models: [],
      }),
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    wrapStreamFn: wrapActualThinking,
    resolveThinkingProfile: () => thinkingProfile,
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
  },
  register(api) {
    local.register?.(api);
  },
});
