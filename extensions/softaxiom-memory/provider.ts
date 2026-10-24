// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import type { ActiveMemoryProviderResult } from "openclaw/plugin-sdk/memory-host-search";
import { MemoryClient, type MemoryOptions } from "./client.js";
import { check, MemoryError } from "./common.js";

type NativeRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type Handle = NonNullable<ActiveMemoryProviderResult["provider"]>;

export function createMemoryProviderRuntime(options: MemoryOptions): NativeRuntime {
  return {
    async open({ cfg, agentId, context, purpose }) {
      context.assertCurrent();
      const caller = context.authority;
      if (caller.kind === "session" && !caller.audience) {
        return { provider: null, error: "The host must provide this session's memory audience." };
      }
      const memory = new MemoryClient(
        {
          workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
          agentId,
          ...(caller.kind === "session" ? { audience: caller.audience } : {}),
        },
        options,
      );
      let closed = false;
      const assertCurrent = () => {
        check(!closed, "MEMORY_HANDLE_CLOSED");
        context.assertCurrent();
        context.signal?.throwIfAborted();
      };
      const assertRead = () => {
        assertCurrent();
        check(purpose !== "status", "MEMORY_CONTENT_NOT_AVAILABLE_FOR_STATUS");
        if (caller.kind === "operator") {
          check(
            caller.scopes.includes("operator.read") || caller.scopes.includes("operator.admin"),
            "MEMORY_READ_SCOPE_REQUIRED",
          );
        }
      };
      const handle: Handle = {
        capabilities: {
          sources: ["memory"],
          pagination: false,
          candidates: [],
          projectFilter: false,
        },
        async search(request) {
          assertRead();
          check(request.cursor === undefined, "MEMORY_CURSOR_UNSUPPORTED");
          if (request.sources && !request.sources.includes("memory")) {
            return { hits: [], coverage: "complete" };
          }
          const limit = Math.max(1, Math.min(request.maxResults ?? 10, 30));
          const rows = await memory.call(
            "search",
            { query: request.query, tiers: ["hot", "warm", "cool"], limit },
            assertRead,
            context.signal,
          );
          const journal =
            (request.minScore ?? 0) <= 0
              ? await memory.call(
                  "journalSearch",
                  { query: request.query },
                  assertRead,
                  context.signal,
                )
              : [];
          assertRead();
          const curatedHits = rows
            .filter((row) => row.score >= (request.minScore ?? 0))
            .map((row) => ({
              reference: {
                providerId: "softaxiom-memory",
                id: `memory:${row.id}`,
                revision: row.revision,
              },
              excerpt: row.text,
              score: row.score,
              source: "memory",
            }));
          const journalHits = journal.map((row) => ({
            reference: { providerId: "softaxiom-memory", id: `journal:${row.id}` },
            excerpt: row.text,
            source: "memory",
          }));
          return {
            hits: [...curatedHits, ...journalHits].slice(0, limit),
            coverage: "partial",
            ...((request.minScore ?? 0) > 0
              ? {
                  warning:
                    "Oojuro evidence has no comparable numeric score and is omitted for minScore.",
                }
              : {}),
          };
        },
        async get(request) {
          assertRead();
          if (request.reference.providerId !== "softaxiom-memory") {
            return { status: "not_found" };
          }
          try {
            const value = await memory.call(
              "readLines",
              {
                reference: request.reference.id,
                from: request.from ?? 1,
                lines: request.lines ?? 100,
              },
              assertRead,
              context.signal,
            );
            assertRead();
            if (request.reference.revision && request.reference.revision !== value.revision) {
              return { status: "not_found" };
            }
            return {
              status: "ok",
              reference: { ...request.reference, revision: value.revision },
              text: value.text,
              from: value.from,
              lines: value.lines,
              truncated: value.truncated,
              ...(value.nextFrom ? { nextFrom: value.nextFrom } : {}),
            };
          } catch (error) {
            if (
              error instanceof MemoryError &&
              ["MEMORY_NOT_FOUND", "EVIDENCE_NOT_FOUND"].includes(error.code)
            ) {
              return { status: "not_found" };
            }
            throw error;
          }
        },
        async health() {
          assertCurrent();
          try {
            await memory.call("journalStats", {}, assertCurrent, context.signal);
            assertCurrent();
            return { status: "ready" };
          } catch (error) {
            assertCurrent();
            return {
              status: "unavailable",
              message: error instanceof MemoryError ? error.code : "MEMORY_UNAVAILABLE",
            };
          }
        },
        async close() {
          closed = true;
        },
      };
      return { provider: handle };
    },
  };
}
