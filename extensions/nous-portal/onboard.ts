import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const NOUS_PORTAL_BASE_URL = manifest.modelCatalog.providers["nous-portal"].baseUrl;
export const NOUS_PORTAL_DEFAULT_MODEL = "nous-portal/Hermes-4.3-36B";
export const buildNousPortalProvider = () =>
  buildManifestModelProviderConfig({
    providerId: "nous-portal",
    catalog: manifest.modelCatalog.providers["nous-portal"],
  });

export const { applyConfig: applyNousPortalConfig } = createProviderConnectionPresetAppliers<[]>({
  primaryModelRef: NOUS_PORTAL_DEFAULT_MODEL,
  resolveParams: () => ({
    providerId: "nous-portal",
    api: "openai-completions",
    baseUrl: NOUS_PORTAL_BASE_URL,
    catalogModels: buildNousPortalProvider().models,
  }),
});

export function validateNousPortalApiKey(value: string): string | undefined {
  // Portal access/inference JWTs and rotating refresh tokens are not API-key profiles.
  // Their owner must retain refresh custody; copying them here breaks rotation semantics.
  if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return "Enter a Portal-generated API key, not an OAuth access/inference JWT. Direct Portal OAuth requires a provider-registered Soft Axiom client; Hermes credentials must stay with Hermes.";
  }
  return undefined;
}
