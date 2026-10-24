// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { discovery, thinkingProfile, isReasoningSolar } from "./catalog.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export default defineSingleProviderPluginEntry({
  id: "upstage",
  name: "Upstage Solar Provider",
  description: "Upstage Solar model access through the standard setup and model picker",
  manifest,
  provider: {
    label: "Upstage Solar",
    aliases: ["solar"],
    envVars: ["UPSTAGE_API_KEY"],
    docsPath: "https://console.upstage.ai/",
    catalog: {
      buildProvider: () => ({
        baseUrl: manifest.modelCatalog.providers["upstage"].baseUrl,
        api: "openai-completions",
        models: [],
      }),
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: discovery,
    },
    wrapStreamFn: ({ streamFn, thinkingLevel }) =>
      createPayloadPatchStreamWrapper(streamFn, ({ payload }) => {
        if (thinkingLevel === "off" || thinkingLevel === "minimal") {
          delete payload.reasoning_effort;
        }
      }),
    resolveThinkingProfile: ({ modelId }) =>
      isReasoningSolar(modelId) ? thinkingProfile : undefined,
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
  },
});
