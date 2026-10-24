// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  ProviderThinkingProfile,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

export const thinkingProfile: ProviderThinkingProfile = {
  levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
  defaultLevel: "medium",
  preserveWhenCatalogReasoningFalse: true,
};

export function wrapActualThinking({ streamFn, thinkingLevel }: ProviderWrapStreamFnContext) {
  return createPayloadPatchStreamWrapper(streamFn, ({ payload }) => {
    if (thinkingLevel === undefined) {
      return;
    }
    const effort =
      thinkingLevel === "off"
        ? "none"
        : thinkingLevel === "minimal"
          ? "none"
          : thinkingLevel === "xhigh"
            ? "high"
            : thinkingLevel;
    payload.thinking = { type: effort === "none" ? "disabled" : "enabled" };
    payload.reasoning_effort = effort;
  });
}
