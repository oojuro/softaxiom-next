// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import {
  buildOpenAICompatibleLiveModels,
  type OpenAICompatibleModelDiscoveryOptions,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const recognizedEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const discovery: OpenAICompatibleModelDiscoveryOptions = {
  projectRows: (rows, fallback) => {
    const capabilitiesByModel = new Map<string, Record<string, unknown>>();
    const normalized = rows.map((row) => {
      const value = asOptionalRecord(row);
      const capabilities = asOptionalRecord(asOptionalRecord(value?.router)?.capabilities);
      const reasoning = asOptionalRecord(capabilities?.reasoning);
      if (typeof value?.id === "string" && reasoning) {
        capabilitiesByModel.set(value.id.trim(), reasoning);
      }
      return Object.assign(
        {},
        value,
        typeof reasoning?.supported === "boolean" ? { reasoning: reasoning.supported } : {},
      );
    });
    return buildOpenAICompatibleLiveModels(normalized, fallback).map((model) => {
      const reasoning = capabilitiesByModel.get(model.id);
      const efforts = Array.isArray(reasoning?.efforts)
        ? reasoning.efforts
            .map((value) => asOptionalRecord(value)?.value)
            .filter(
              (value): value is string => typeof value === "string" && recognizedEfforts.has(value),
            )
        : [];
      if (efforts.length) {
        model.compat = {
          ...model.compat,
          supportsReasoningEffort: true,
          supportedReasoningEfforts: efforts,
        };
      }
      return model;
    });
  },
};
