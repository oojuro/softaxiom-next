// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { discovery } from "./catalog.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export default defineSingleProviderPluginEntry({
  id: "ramp-router",
  name: "Ramp Router Provider",
  description: "Ramp Router model access through the standard setup and model picker",
  manifest,
  provider: {
    label: "Ramp Router",
    aliases: ["router", "ramp", "router.com"],
    envVars: ["RAMP_ROUTER_API_KEY", "ROUTER_API_KEY"],
    docsPath: "https://router.com/",
    catalog: {
      buildProvider: () => ({
        baseUrl: manifest.modelCatalog.providers["ramp-router"].baseUrl,
        api: "openai-responses",
        models: [],
        headers: manifest.modelCatalog.providers["ramp-router"].headers,
      }),
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: discovery,
    },
  },
});
