import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import {
  buildOpenAICompatibleLiveModels,
  type OpenAICompatibleModelDiscoveryOptions,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";

export const isReasoningSolar = (id: string) => !/solar-mini(?:[-:.@]|$)|syn-pro/i.test(id);
export const thinkingProfile: ProviderThinkingProfile = {
  levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
  defaultLevel: "medium",
};

export const discovery: OpenAICompatibleModelDiscoveryOptions = {
  projectRows: (rows, fallback) =>
    buildOpenAICompatibleLiveModels(rows, fallback).map((model) => {
      model.reasoning = isReasoningSolar(model.id);
      model.compat = {
        ...model.compat,
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: isReasoningSolar(model.id),
        supportedReasoningEfforts: ["low", "medium", "high"],
        reasoningEffortMap: {
          off: "none",
          minimal: "none",
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
