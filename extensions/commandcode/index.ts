// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createDeepSeekV4OpenAICompatibleThinkingWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const anthropic = defineSingleProviderPluginEntry({
  id: "commandcode-anthropic",
  name: "CommandCode Anthropic Provider",
  description: "CommandCode's Bearer-authenticated Anthropic Messages route",
  manifest,
  provider: {
    label: "CommandCode (Anthropic)",
    aliases: ["commandcode-claude"],
    docsPath: "https://commandcode.ai/",
    catalog: {
      buildProvider: () => ({
        baseUrl: manifest.modelCatalog.providers["commandcode-anthropic"].baseUrl,
        api: "anthropic-messages",
        authHeader: true,
        models: [],
      }),
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: {
        authentication: "none",
        acceptUnknownModel: ({ id }) => id.startsWith("claude-"),
      },
    },
    normalizeResolvedModel: ({ model }) => ({ ...model, authHeader: true }),
    ...buildProviderReplayFamilyHooks({ family: "native-anthropic-by-model" }),
  },
});

export default defineSingleProviderPluginEntry({
  id: "commandcode",
  name: "CommandCode Provider",
  description: "CommandCode Chat Completions and Anthropic Messages routes",
  manifest,
  provider: {
    label: "CommandCode",
    aliases: ["commandcode-chat"],
    docsPath: "https://commandcode.ai/",
    catalog: {
      buildProvider: () => ({
        baseUrl: manifest.modelCatalog.providers.commandcode.baseUrl,
        api: "openai-completions",
        models: [],
      }),
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: { authentication: "none" },
    },
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
    wrapStreamFn: ({ streamFn, thinkingLevel }) =>
      createDeepSeekV4OpenAICompatibleThinkingWrapper({
        baseStreamFn: streamFn,
        thinkingLevel,
        shouldPatchModel: (model) => /^deepseek\/deepseek-v4/i.test(model.id),
      }),
  },
  register(api) {
    anthropic.register?.(api);
  },
});
