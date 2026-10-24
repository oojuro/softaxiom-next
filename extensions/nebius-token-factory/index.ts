// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { discovery, thinkingProfile } from "./catalog.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export default defineSingleProviderPluginEntry({
  id: "nebius-token-factory",
  name: "Nebius Token Factory Provider",
  description: "Nebius Token Factory model access through the standard setup and model picker",
  manifest,
  provider: {
    label: "Nebius Token Factory",
    aliases: ["nebius", "nebius-tokenfactory", "nebius-tf", "token-factory", "tokenfactory"],
    envVars: ["NEBIUS_API_KEY", "NEBIUS_TOKEN_FACTORY_API_KEY"],
    docsPath: "https://tokenfactory.nebius.com/",
    catalog: {
      buildProvider: () => ({
        baseUrl: manifest.modelCatalog.providers["nebius-token-factory"].baseUrl,
        api: "openai-completions",
        models: [],
      }),
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: discovery,
    },
    wrapStreamFn: ({ streamFn, thinkingLevel }) =>
      createPayloadPatchStreamWrapper(streamFn, ({ payload }) => {
        if (thinkingLevel === "off") {
          delete payload.reasoning_effort;
        }
      }),
    resolveThinkingProfile: ({ reasoning }) => (reasoning ? thinkingProfile : undefined),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
  },
});
