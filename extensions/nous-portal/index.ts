// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyModelCompatPatch } from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyNousPortalConfig,
  validateNousPortalApiKey,
  buildNousPortalProvider,
  NOUS_PORTAL_BASE_URL,
} from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const protocol = buildNousPortalProvider().models[0]?.compat;
if (!protocol) {
  throw new Error("Nous Portal manifest must declare its request protocol contract");
}

export default defineSingleProviderPluginEntry({
  id: "nous-portal",
  name: "Nous Portal Provider",
  description: "Nous Portal API-key inference through the native provider/auth lifecycle.",
  manifest,
  provider: {
    label: "Nous Portal",
    docsPath: "https://portal.nousresearch.com/api-docs",
    manifestAuth: {
      applyConfig: applyNousPortalConfig,
      preserveExistingPrimary: true,
      validateApiKey: validateNousPortalApiKey,
      noteTitle: "Nous Portal API key",
      noteMessage: [
        "Create an API key at https://portal.nousresearch.com. API credits or an eligible subscription are required.",
        "This route uses a Portal API key, not Hermes OAuth tokens. Direct OAuth needs a separately registered provider client.",
        "Hermes manages its own short-lived inference JWT and single-use rotating refresh token; do not copy that token store.",
        "Model pricing is not bundled; check current Portal charges before use.",
      ].join("\n"),
    },
    catalog: { discoveryMode: "strict", liveModelDiscovery: true },
    normalizeResolvedModel: ({ model }) =>
      model.api === "openai-completions" &&
      model.baseUrl.replace(/\/+$/, "") === NOUS_PORTAL_BASE_URL
        ? applyModelCompatPatch(model, protocol)
        : model,
  },
});
