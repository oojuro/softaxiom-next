import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import {
  buildOpenAICompatibleLiveModels,
  type OpenAICompatibleModelDiscoveryOptions,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";

const reasoningModel =
  /deepseek-r1|deepseek-v4|deepseek-reasoner|gpt-oss|glm-5|kimi-k2|minimax-m2|qwen3/i;

export const thinkingProfile: ProviderThinkingProfile = {
  levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
  defaultLevel: "medium",
};

export const discovery: OpenAICompatibleModelDiscoveryOptions = {
  endpointPath: "models?verbose=true",
  projectRows: (rows, fallback) =>
    buildOpenAICompatibleLiveModels(rows, fallback).map((model) => {
      model.reasoning = model.reasoning || reasoningModel.test(model.id);
      model.compat = {
        ...model.compat,
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: model.reasoning || reasoningModel.test(model.id),
        supportedReasoningEfforts: ["low", "medium", "high"],
        reasoningEffortMap: {
          off: "none",
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "high",
          max: "high",
        },
        maxTokensField: "max_tokens",
      };
      return model;
    }),
};
