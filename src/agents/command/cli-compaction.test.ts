// Covers CLI turn compaction lifecycle and external CLI resume-state cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerContextEngineInRegistry } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../plugins/registry-inspection.test-support.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  clearPreparedEmbeddedAgentSettings,
  createPreparedEmbeddedAgentSettingsManager,
} from "../agent-project-settings.js";
import { shouldPreemptivelyCompactBeforePrompt } from "../embedded-agent-runner/run/preemptive-compaction.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import {
  buildContextEngine,
  createPreparedRuntimeLease,
  defaultSettingsManager,
  prepareCompactionScenario as prepare,
  resolveContextEngineFromRegistry,
  setCliCompactionTestDeps,
  type CliCompactionTestDeps,
} from "./cli-compaction.test-support.js";

type CompactParams = Parameters<ContextEngine["compact"]>[0];
type NativeCompaction = NonNullable<CliCompactionTestDeps["maybeCompactAgentHarnessSession"]>;
type CompactResult = NonNullable<Awaited<ReturnType<ContextEngine["compact"]>>["result"]>;
type Scenario = Awaited<ReturnType<typeof prepare>>;
const successfulCompaction = (result: CompactResult) => ({ ok: true, compacted: true, result });
const expectNoCalls = (...mocks: unknown[]) => {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
};
const staleBinding = { ok: false, compacted: false, reason: "thread not found: thread-1" };
const resumeState = (ids: Record<string, string>, claudeCliSessionId?: string) => ({
  cliSessionIds: ids,
  cliSessionBindings: Object.fromEntries(
    Object.entries(ids).map(([provider, sessionId]) => [provider, { sessionId }]),
  ),
  ...(claudeCliSessionId ? { claudeCliSessionId } : {}),
});

describe("runCliTurnCompactionLifecycle", () => {
  let tmpDir: string;
  type ScenarioOptions = Omit<Parameters<typeof prepare>[0], "tmpDir" | "suffix">;
  const prepareScenario = (suffix: string, params: ScenarioOptions = {}) =>
    prepare({ tmpDir, suffix, ...params });
  const prepareHarness = async (
    suffix: string,
    compact: NativeCompaction,
    params: ScenarioOptions = {},
  ) => {
    const nativeCompact = vi.fn(compact);
    const scenario = await prepareScenario(suffix, {
      provider: "codex",
      model: "gpt-5.5",
      ...params,
      sessionEntry: { agentHarnessId: "codex", ...params.sessionEntry },
      deps: { ...params.deps, maybeCompactAgentHarnessSession: nativeCompact },
    });
    return { ...scenario, nativeCompact };
  };
  const prepareSuccessor = async (
    suffix: string,
    result: (
      target: Pick<Scenario, "sessionId" | "sessionKey" | "storePath">,
    ) => Awaited<ReturnType<ContextEngine["compact"]>> | ReturnType<ContextEngine["compact"]>,
  ) => {
    const scenario: Scenario = await prepareScenario(`cli-successor-${suffix}`, {
      compact: async () => result(scenario),
      recordCliCompactionInStore: vi.fn(async (input) => input.sessionStore[input.sessionKey]),
    });
    return scenario;
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-"));
    setCliCompactionTestDeps({
      resolveCliBackendConfig: () => null,
      acquirePreparedModelRuntime: async (input) => createPreparedRuntimeLease(input),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    await closeOpenClawAgentDatabasesAsync(tmpDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each(["context", "native", "fallback", "failure", "stale", "abort-tail"] as const)(
    "retains its resolved engine until work and cleanup settle (%s)",
    async (mode) => {
      const abortTail = mode === "abort-tail";
      const retired = createDeferred();
      const retire = vi.fn(() => retired.resolve());
      const registry = createEmptyPluginRegistry();
      const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
      resources.attach(registry);
      resources.register("fixture", { id: "resource", dispose: retire });
      const compactStarted = createDeferred();
      const compactGate = createDeferred();
      const cleanupStarted = createDeferred();
      const cleanupGate = createDeferred();
      const cleanupFile = path.join(tmpDir, `owned-${mode}-cleanup.txt`);
      const controller = new AbortController();
      const staleError = new Error("compaction owner retired");
      const calls: CompactParams[] = [];
      const dispose = vi.fn(async () => {
        cleanupStarted.resolve();
        await cleanupGate.promise;
        if (!abortTail) {
          await fs.writeFile(cleanupFile, "disposed", { signal: getAsyncWorkSignal() });
        }
        if (mode === "failure") {
          throw new Error("cleanup failed too");
        }
      });
      const raw = {
        ...buildContextEngine({ compactCalls: calls }),
        dispose,
        ...(abortTail
          ? {
              compact: async () => {
                compactStarted.resolve();
                await compactGate.promise;
                expect(retire).not.toHaveBeenCalled();
                return { ok: false, compacted: false, reason: "aborted" };
              },
            }
          : {}),
      };
      const initialize = vi.fn(() => {
        registerContextEngineInRegistry(registry, "legacy", () => raw, "core");
      });
      let engine: ContextEngine | undefined;
      const scenario = await prepareScenario(`owned-${mode}`, {
        provider: abortTail ? "claude-cli" : "github-copilot",
        sessionEntry: mode === "native" || mode === "fallback" ? { agentHarnessId: "copilot" } : {},
        maintenance: async () => {
          expect(retire).not.toHaveBeenCalled();
          if (mode === "failure") {
            throw new Error("maintenance failed");
          }
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        },
        deps: {
          ensureContextEnginesInitialized: initialize,
          resolveContextEngine: async (cfg, options) => {
            engine = await withPluginRuntimeRegistryScope(registry, () =>
              resolveContextEngineFromRegistry(cfg, options),
            );
            if (mode === "stale") {
              controller.abort(staleError);
            }
            return engine;
          },
          maybeCompactAgentHarnessSession: async () => {
            expect(retire).not.toHaveBeenCalled();
            return mode === "fallback"
              ? {
                  ok: false,
                  compacted: false,
                  reason: "unsupported",
                  failure: { reason: "unsupported_harness_compaction" },
                }
              : { ok: true, compacted: true };
          },
        },
      });
      const result = scenario.run({ abortSignal: controller.signal }).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        if (abortTail) {
          await compactStarted.promise;
          controller.abort(new Error("compaction cancelled"));
          expect(await result).toEqual(
            expect.objectContaining({ message: expect.stringContaining("compaction cancelled") }),
          );
          await resources.release();
          expect(dispose).not.toHaveBeenCalled();
          expect(retire).not.toHaveBeenCalled();
          compactGate.resolve();
          await cleanupStarted.promise;
        } else {
          expect(
            await Promise.race([
              cleanupStarted.promise.then(() => "cleanup"),
              result.then(() => "returned"),
            ]),
          ).toBe("cleanup");
          await resources.release();
        }
        expect(retire).not.toHaveBeenCalled();
        cleanupGate.resolve();
        const error = await result;
        if (!abortTail) {
          if (mode === "failure") {
            expect(error).toEqual(new Error("maintenance failed"));
          } else {
            expect(error).toBe(mode === "stale" ? staleError : undefined);
          }
          expect(calls).toHaveLength(mode === "native" || mode === "stale" ? 0 : 1);
          expect(await fs.readFile(cleanupFile, "utf8")).toBe("disposed");
        }
        if (abortTail) {
          await retired.promise;
        }
        expect(retire).toHaveBeenCalledTimes(1);
        expect(initialize).toHaveBeenCalledOnce();
      } finally {
        compactGate.resolve();
        cleanupGate.resolve();
        await result;
        if (abortTail) {
          await engine?.dispose?.();
        } else {
          await engine?.dispose?.().catch(() => {});
        }
        await resources.release();
      }
    },
  );

  it.each([true, false])("propagates empty-transcript compaction success=%s", async (ok) => {
    const scenario = await prepareScenario("no-compactable-entries", {
      provider: "test-provider",
      model: "test-model",
      compact: async () => ({ ok, compacted: false, reason: "no real conversation messages" }),
      deps: {
        openSessionManager: async () =>
          ({ getBranch: () => [], buildSessionContext: () => ({ messages: [] }) }) as never,
      },
    });
    if (ok) {
      await expect(scenario.run()).resolves.toBe(scenario.sessionEntry);
    } else {
      await expect(scenario.run()).rejects.toThrow(
        "CLI transcript compaction failed for test-provider/test-model: no real conversation messages",
      );
    }
  });

  it.each(["admitted", "current"] as const)(
    "refreshes the CLI compaction budget with the %s plugin generation",
    async (source) => {
      const pluginRoot = path.join(tmpDir, "settings-bundle");
      await fs.mkdir(pluginRoot);
      const settingsFile = path.join(pluginRoot, "settings.json");
      const plugin = {
        id: "settings-bundle",
        rootDir: pluginRoot,
        format: "bundle" as const,
        settingsFiles: ["settings.json"],
      };
      const createSnapshot = (cache: ReturnType<typeof createPluginCache>) =>
        withPluginCache(cache, () => createPluginMetadataSnapshotFixture({ plugins: [plugin] }));
      await using initialCache = createPluginCache();
      await using replacementCache = createPluginCache();
      await fs.writeFile(settingsFile, JSON.stringify({ compaction: { reserveTokens: 20_000 } }));
      const scenario = await prepareScenario(`settings-${source}`, {
        cfg: { plugins: { entries: { "settings-bundle": { enabled: true } } } },
        sessionEntry: { contextTokens: 128_000, totalTokens: 100_000 },
        deps: {
          createPreparedEmbeddedAgentSettingsManager,
          shouldPreemptivelyCompactBeforePrompt,
          ensureContextEnginesInitialized: vi.fn(),
        },
      });
      const run = (snapshot: ReturnType<typeof createSnapshot>) =>
        source === "admitted"
          ? scenario.run({
              pluginGeneration: {
                remoteCatalog: null,
                configuredCatalogEntries: [],
                inlineProviderModels: [],
                pluginMetadataSnapshot: snapshot,
              },
            })
          : withPluginMetadataSnapshotScope(snapshot, () => scenario.run(), {
              trustConfigIdentity: true,
            });
      try {
        const initial = createSnapshot(initialCache);
        await run(initial);
        expect(scenario.calls).toHaveLength(0);
        await fs.writeFile(settingsFile, JSON.stringify({ compaction: { reserveTokens: 32_000 } }));
        await run(initial);
        expect(scenario.calls).toHaveLength(0);
        await run(createSnapshot(replacementCache));
        expect(scenario.calls).toHaveLength(1);
        expect(scenario.calls[0]?.currentTokenCount).toBe(100_000);
      } finally {
        clearPreparedEmbeddedAgentSettings([scenario.sessionId]);
      }
    },
  );

  it.each(["target", "legacy-marker"] as const)(
    "records a %s compaction successor",
    async (kind) => {
      const successorSessionId = "session-cli-rotated";
      const taskCwd = path.join(tmpDir, "task-repo");
      await fs.mkdir(taskCwd, { recursive: true });
      const settingsCwds: string[] = [];
      const scenario = await prepareScenario("cli-rotates", {
        cwd: taskCwd,
        sessionEntry: resumeState(
          { codex: "stale-cli-session", "claude-cli": "stale-claude-session" },
          "stale-claude-session",
        ),
        compact: async () =>
          successfulCompaction({
            tokensBefore: 950,
            tokensAfter: 100,
            sessionId: successorSessionId,
            ...(kind === "target"
              ? {
                  sessionTarget: {
                    sessionKey: "agent:main:cli-rotates",
                    storePath: path.join(tmpDir, "cli-rotates.sqlite"),
                  },
                }
              : {
                  sessionFile: `sqlite:main:${successorSessionId}:${path.join(tmpDir, "cli-rotates.sqlite")}`,
                }),
          }),
        deps: {
          createPreparedEmbeddedAgentSettingsManager: (params) => {
            settingsCwds.push(params.cwd);
            return defaultSettingsManager();
          },
        },
      });
      const { calls, maintenance, sessionKey, storePath } = scenario;
      const updatedEntry = await scenario.run();

      expect(calls[0]?.runtimeContext).toMatchObject({ workspaceDir: tmpDir, cwd: taskCwd });
      expect(settingsCwds).toEqual([taskCwd]);
      expect(maintenance.mock.calls[0]?.[0]).toMatchObject({
        sessionId: successorSessionId,
        sessionFile:
          kind === "target" ? sessionKey : `sqlite:main:${successorSessionId}:${storePath}`,
        sessionTarget: { agentId: "main", sessionId: successorSessionId, sessionKey, storePath },
      });
      expect(updatedEntry).toMatchObject({
        sessionId: successorSessionId,
        compactionCount: 1,
        totalTokens: 100,
      });
      expect(updatedEntry?.cliSessionBindings).toBeUndefined();
      expect(updatedEntry?.cliSessionIds).toBeUndefined();
      expect(updatedEntry?.claudeCliSessionId).toBeUndefined();
    },
  );

  it("rejects an engine that changes the host row before successor acceptance", async () => {
    const successorId = "session-cli-key-successor";
    const scenario = await prepareSuccessor("session-key", async ({ sessionKey, storePath }) => {
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: successorId, updatedAt: Date.now() },
      );
      return successfulCompaction({
        tokensBefore: 950,
        sessionId: successorId,
        sessionFile: sessionKey,
      });
    });

    await expect(scenario.run()).rejects.toThrow();
    expectNoCalls(scenario.maintenance, scenario.record);
  });

  it.each([
    { label: "conflicting ids", override: () => ({}), reportedId: "reported-successor" },
    { label: "agent", override: () => ({ agentId: "other" }) },
    { label: "session key", override: () => ({ sessionKey: "agent:main:other" }) },
    {
      label: "store",
      override: () => ({ storePath: path.join(tmpDir, "other-openclaw-sessions.sqlite") }),
    },
  ])("rejects a CLI successor with invalid $label", async ({ label, override, reportedId }) => {
    const scenario = await prepareSuccessor(
      label.replaceAll(" ", "-"),
      ({ sessionKey, storePath }) =>
        successfulCompaction({
          tokensBefore: 950,
          ...(reportedId ? { sessionId: reportedId } : {}),
          sessionTarget: {
            agentId: "main",
            sessionId: "outside-successor",
            sessionKey,
            storePath,
            ...override(),
          },
        }),
    );
    await expect(scenario.run()).rejects.toThrow(
      reportedId
        ? "successor identity is inconsistent"
        : "successor target changed the active session binding",
    );
  });

  it("ignores an unversioned fresh total on the first upgraded turn", async () => {
    const scenario = await prepareScenario("legacy-unversioned-total", {
      sessionEntry: { totalTokens: 950, totalTokensFresh: true, totalTokensVersion: undefined },
    });
    expect(await scenario.run()).toBe(scenario.sessionEntry);
    expect(scenario.calls).toEqual([]);
  });

  it("treats already-compacted CLI transcript compaction as a no-op", async () => {
    const scenario = await prepareScenario("qwen-already-compacted", {
      provider: "ollama",
      model: "qwen3:14b",
      compact: async () => {
        throw new Error("Already compacted");
      },
    });
    expect(await scenario.run()).toBe(scenario.sessionEntry);
    expect(scenario.calls).toHaveLength(1);
    expectNoCalls(scenario.maintenance, scenario.record);
  });

  it.each([
    { suffix: "codex", ownsNative: false, locked: true },
    { suffix: "codex-with-ownership", ownsNative: true, locked: false },
  ])(
    "routes native compaction without accepting native result ids as host successors ($suffix)",
    async ({ suffix, ownsNative, locked }) => {
      const authProfileId = locked ? "github-copilot:work" : undefined;
      const tokensAfter = locked ? 42 : 100;
      const selection = { agentHarnessId: "codex", modelSelectionLocked: locked, authProfileId };
      const lease = createPreparedRuntimeLease({
        config: {},
        agentId: "main",
        agentDir: tmpDir,
        workspaceDir: tmpDir,
      });
      const pluginGeneration = lease.pluginGeneration;
      const guard = vi.fn(() => ({ supported: true, disabled: false }));
      const scenario = await prepareHarness(
        suffix,
        async () =>
          successfulCompaction({
            tokensBefore: 950,
            tokensAfter,
            sessionId: "foreign-native-id",
            sessionFile: "foreign-native-file",
          }),
        {
          provider: "openai",
          sessionEntry: {
            modelSelectionLocked: locked,
            authProfileOverride: authProfileId,
            authProfileOverrideSource: locked ? "auto" : undefined,
          },
          deps: {
            ensureContextEnginesInitialized: vi.fn(),
            acquirePreparedModelRuntime: async (_input, options) => {
              expect(options?.pluginGeneration).toBe(pluginGeneration);
              return lease;
            },
            applyAgentAutoCompactionGuard: guard,
            resolveCliBackendConfig: () =>
              ownsNative
                ? {
                    id: "codex",
                    config: { command: "codex" },
                    bundleMcp: false,
                    ownsNativeCompaction: true,
                  }
                : null,
          },
        },
      );
      const { nativeCompact, sessionId } = scenario;
      const updatedEntry = await scenario.run({
        pluginGeneration,
        cliBackendId: ownsNative ? "codex" : undefined,
      });
      expect(guard.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
        nativeCompact.mock.invocationCallOrder[0] ?? 0,
      );
      const [nativeInput, nativeOptions] = nativeCompact.mock.calls[0] ?? [];
      expect(nativeInput?.contextEngine).toBe(scenario.contextEngine);
      expect(nativeInput).toMatchObject({ sessionId, ...selection });
      expect(nativeInput?.contextEngineRuntimeContext).toMatchObject(selection);
      expect(nativeOptions?.preparedModelRuntime).toBe(lease.snapshot);
      expect(lease[Symbol.asyncDispose]).toHaveBeenCalledOnce();
      expect(scenario.calls).toHaveLength(0);
      expect(updatedEntry).toMatchObject({
        sessionId,
        totalTokens: tokensAfter,
        compactionCount: 1,
      });
    },
  );

  it("ignores stale native harness ids when the active provider no longer matches", async () => {
    const nativeCompact = vi.fn();
    const scenario = await prepareScenario("openclaw-after-codex", {
      provider: "openclaw",
      model: "sonnet-4.6",
      sessionEntry: { agentHarnessId: "codex" },
      deps: { maybeCompactAgentHarnessSession: nativeCompact as never },
    });
    const { calls, sessionEntry, sessionKey } = scenario;
    await scenario.run();

    expect([nativeCompact.mock.calls.length, calls.length]).toEqual([0, 1]);

    const lockedEntry: SessionEntry = { ...sessionEntry, modelSelectionLocked: true };
    await expect(
      scenario.run({ sessionEntry: lockedEntry, sessionStore: { [sessionKey]: lockedEntry } }),
    ).rejects.toThrow("CLI compaction cannot replace a model-locked native harness runtime");
    expect([nativeCompact.mock.calls.length, calls.length]).toEqual([0, 1]);
  });

  it.each([
    { initialHarness: "copilot", updatedHarness: "other", nativeCalls: 1, contextCalls: 0 },
    { initialHarness: "other", updatedHarness: "copilot", nativeCalls: 0, contextCalls: 1 },
  ])(
    "keeps the initial compaction route when the harness changes from $initialHarness to $updatedHarness during engine resolution",
    async ({ initialHarness, updatedHarness, nativeCalls, contextCalls }) => {
      const nativeCompact = vi.fn<NativeCompaction>(async () => ({ ok: true, compacted: true }));
      const scenario = await prepareScenario(`harness-change-${initialHarness}`, {
        provider: "github-copilot",
        sessionEntry: { agentHarnessId: initialHarness },
        deps: {
          resolveContextEngine: async (): Promise<ContextEngine> => {
            scenario.sessionEntry.agentHarnessId = updatedHarness;
            return scenario.contextEngine;
          },
          maybeCompactAgentHarnessSession: nativeCompact,
        },
      });

      const updatedEntry = await scenario.run();

      expect(scenario.sessionEntry.agentHarnessId).toBe(updatedHarness);
      expect(nativeCompact).toHaveBeenCalledTimes(nativeCalls);
      expect(scenario.calls).toHaveLength(contextCalls);
      expect(updatedEntry?.compactionCount).toBe(1);
    },
  );

  it.each([false, true])(
    "respects native automatic compaction ownership (locked=%s)",
    async (locked) => {
      const scenario = await prepareHarness(
        "codex-native-auto-compaction",
        async () => ({
          ok: true,
          compacted: false,
          reason: "codex app-server owns automatic compaction",
        }),
        { sessionEntry: { modelSelectionLocked: locked } },
      );
      const { calls, record, sessionEntry } = scenario;
      expect(await scenario.run()).toBe(sessionEntry);
      expect(scenario.nativeCompact).toHaveBeenCalledOnce();
      expect(calls).toHaveLength(0);
      expect(record).not.toHaveBeenCalled();
    },
  );

  it("does not fall back when native harness compaction returns no result", async () => {
    const scenario = await prepareHarness("codex-native-empty", async () => undefined);

    await expect(scenario.run()).rejects.toThrow(
      "CLI native harness compaction failed for codex/gpt-5.5: native harness compaction did not reduce context",
    );
    expect(scenario.calls).toHaveLength(0);
  });

  it("clears stale Codex native binding when context-engine fallback is below target", async () => {
    const scenario = await prepareHarness(
      "codex-stale-binding-under-target",
      async () => ({ ...staleBinding, failure: { reason: "stale_thread_binding" } }),
      {
        sessionEntry: resumeState({ codex: "thread-1" }),
        compact: async () => ({ ok: true, compacted: false, reason: "already under target" }),
      },
    );
    const { nativeCompact, calls, maintenance, record, sessionKey, sessionStore } = scenario;
    const updatedEntry = await scenario.run();

    expect(nativeCompact).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expectNoCalls(maintenance, record);
    expect(updatedEntry?.compactionCount).toBeUndefined();
    expect(updatedEntry?.cliSessionBindings?.codex).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.codex).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionBindings?.codex).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.codex).toBeUndefined();
  });

  it("keeps successful context-engine fallback when post-compaction maintenance fails", async () => {
    const maintenance = vi.fn(async () => {
      throw new Error("maintenance rotated stale binding");
    });
    const scenario = await prepareHarness(
      "codex-stale-maintenance",
      async () => ({ ...staleBinding }),
      { maintenance },
    );
    expect((await scenario.run())?.compactionCount).toBe(1);
    expect(maintenance).toHaveBeenCalledOnce();
    expect(scenario.calls).toHaveLength(1);
  });

  it("bounds a hung CLI context-engine compaction and leaves resume state intact", async () => {
    const compactStarted = createDeferred();
    const compactGate = createDeferred();
    const disposed = createDeferred();
    const scenario = await prepareScenario("cli-timeout", {
      cfg: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } } as OpenClawConfig,
      sessionEntry: resumeState({ "claude-cli": "claude-session" }, "claude-session"),
      contextEngine: (calls) => ({
        ...buildContextEngine({ compactCalls: calls }),
        async compact(compactParams) {
          calls.push(compactParams);
          compactStarted.resolve();
          await compactGate.promise;
          return { ok: false, compacted: false };
        },
        async dispose() {
          disposed.resolve();
        },
      }),
    });
    const { calls, maintenance, record, sessionKey, sessionStore } = scenario;

    vi.useFakeTimers();
    const pending = scenario.run();

    const rejection = expect(pending).rejects.toThrow(
      "CLI transcript compaction failed for claude-cli/opus: Compaction timed out",
    );
    try {
      await compactStarted.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;

      expect(calls).toHaveLength(1);
      expect(calls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(calls[0]?.abortSignal?.aborted).toBe(true);
      expectNoCalls(maintenance, record);
      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
        "claude-session",
      );
    } finally {
      compactGate.resolve();
      await pending.catch(() => undefined);
      await disposed.promise;
      vi.useRealTimers();
    }
  });

  it("does not compact reset-discarded tool output in the post-turn lifecycle", async () => {
    const manager = SessionManager.inMemory(tmpDir);
    const userId = manager.appendMessage({ role: "user", content: "kept question", timestamp: 1 });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(20_000) }],
      isError: false,
      timestamp: 2,
    });
    manager.appendResetBoundary("new", userId);
    manager.appendMessage({ role: "user", content: "new turn after reset", timestamp: 4 });
    const scenario = await prepareScenario("reset-lifecycle-proof", {
      sessionEntry: { sessionFile: undefined, contextTokens: 4_096, totalTokens: 400 },
      deps: {
        shouldPreemptivelyCompactBeforePrompt,
        openSessionManager: async () => manager,
        createPreparedEmbeddedAgentSettingsManager: () =>
          SettingsManager.inMemory({ compaction: { reserveTokens: 512, keepRecentTokens: 0 } }),
      },
    });
    expect(await scenario.run()).toBe(scenario.sessionEntry);
    expect(scenario.calls).toEqual([]);
    expect(scenario.record).not.toHaveBeenCalled();
  });
});
