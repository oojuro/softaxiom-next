// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import type { ProviderAuthContext, ProviderAuthResult } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICompatibleLiveModels } from "openclaw/plugin-sdk/provider-catalog-live-runtime";

export function actualLocalBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Actual local mode requires a loopback HTTP(S) URL without credentials.");
  }
  return url.href.replace(/\/+$/, "");
}

export async function setupActualLocal(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const baseUrl = actualLocalBaseUrl(
    await ctx.prompter.text({
      message: "Actual local server URL",
      initialValue: "http://127.0.0.1:8080/v1",
      validate: (value) => {
        try {
          actualLocalBaseUrl(value);
          return undefined;
        } catch {
          return "Enter a loopback HTTP(S) URL, such as http://127.0.0.1:8080/v1";
        }
      },
    }),
  );
  const model = (
    await ctx.prompter.text({
      message: "Model ID loaded in your Actual local server",
      validate: (value) => (value?.trim() ? undefined : "A model ID is required"),
    })
  ).trim();
  const provider = {
    baseUrl,
    api: "openai-completions" as const,
    auth: "none" as const,
    models: [],
  };
  return {
    profiles: [],
    defaultModel: `actual-local/${model}`,
    configPatch: {
      models: {
        providers: {
          "actual-local": {
            ...provider,
            models: buildOpenAICompatibleLiveModels([{ id: model }], provider),
          },
        },
      },
    },
  };
}
