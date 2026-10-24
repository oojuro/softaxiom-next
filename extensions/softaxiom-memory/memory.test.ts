// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryClient } from "./client.js";
import plugin, { readReference, recall } from "./index.js";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "sa-memory-plugin-"));
  roots.push(root);
  return root;
}
const options = { oojuro: process.env.OOJURO_BIN ?? "oojuro" };
const change = (id: string, body: string, expectedRevision: string | null = null) => ({
  id,
  title: id,
  body,
  tier: "hot",
  status: "active",
  expectedRevision,
  supersededBy: [],
  sources: [],
  origin: "agent",
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Soft Axiom memory plugin with real Oojuro", () => {
  it("persists real tiered memory, bounded context and revision-checked edits across restart", async () => {
    const root = await workspace();
    const client = new MemoryClient({ workspaceDir: root, agentId: "main" }, options);
    const initialized = await client.call("initialize");
    expect(initialized.id).toMatch(/^\d+$/);
    expect(await readdir(client.root)).toEqual(
      expect.arrayContaining(["hot", "warm", "cool", "diary", "cold"]),
    );
    await client.call("curate", {
      changes: [change("project", "The compiler project uses Rust.")],
    });
    const saved = await readReference(client, "memory:project");
    expect(saved).toMatchObject({ text: "The compiler project uses Rust.", partial: false });
    await expect(
      client.call("curate", { changes: [change("project", "stale overwrite")] }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const restarted = new MemoryClient({ workspaceDir: root, agentId: "main" }, options);
    expect(await restarted.call("context", { query: "compiler" })).toMatchObject({
      hot: { records: expect.any(Array) },
    });
    const result = await recall(restarted, "compiler");
    expect(JSON.stringify(result.curated)).toContain("Rust");
    const record = await client.call("record", {
      kind: "tool_result",
      body: { text: "Build finished compiler artifact" },
    });
    expect(JSON.stringify((await recall(restarted, "compiler")).journal)).toContain(record.id);
  }, 60000);

  it("isolates agents and private/conversation audiences while preserving diary/checkpoint generations", async () => {
    const root = await workspace();
    const owner = new MemoryClient({ workspaceDir: root, agentId: "main" }, options);
    const other = new MemoryClient({ workspaceDir: root, agentId: "other" }, options);
    const shared = new MemoryClient(
      {
        workspaceDir: root,
        agentId: "main",
        audience: {
          kind: "conversation",
          agentId: "main",
          sessionKey: "group:synthetic",
          sessionId: "session-one",
        },
      },
      options,
    );
    await owner.call("initialize");
    await owner.call("curate", { changes: [change("private", "A private project fact")] });
    expect((await other.call("list")).total).toBe(0);
    expect((await shared.call("list")).total).toBe(0);
    await owner.call("writeDiary", {
      day: "2026-10-24",
      text: "# 2026-10-24\nThe compiler was inspected.",
      expectedRevision: null,
    });
    const snapshot = await owner.call("checkpoint", { destination: join(root, "snapshot") });
    const fresh = new MemoryClient({ workspaceDir: root, agentId: "restored" }, options);
    const { restoreCheckpoint } = await import("./checkpoint.js");
    restoreCheckpoint(snapshot.destination, fresh.root, snapshot.manifestSha256);
    expect(await fresh.call("diary", { day: "2026-10-24" })).toMatchObject({
      text: "# 2026-10-24\nThe compiler was inspected.",
    });
    expect((await fresh.call("list")).total).toBe(1);
    await expect(
      owner.call("curate", { changes: [change("overflow", "a".repeat(5000))] }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  }, 60000);

  it("uses Oojuro redaction for evidence and refuses curated credentials", async () => {
    const client = new MemoryClient({ workspaceDir: await workspace(), agentId: "main" }, options);
    await client.call("initialize");
    const secret = "ghp_" + "A1b2C3d4".repeat(5);
    const record = await client.call("record", {
      kind: "tool_result",
      body: { text: `Bearer ${secret}` },
    });
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(await readReference(client, `journal:${record.id}`))).not.toContain(
      secret,
    );
    await expect(
      client.call("curate", { changes: [change("secret", `Bearer ${secret}`)] }),
    ).rejects.toMatchObject({ code: "SECRET_IN_CURATED_CONTENT" });
    await expect(readReference(client, "../../outside")).rejects.toMatchObject({
      code: "INVALID_MEMORY_REFERENCE",
    });
    const config = JSON.parse(await readFile(join(client.root, "config.json"), "utf8"));
    expect(config.oojuro).toBe(options.oojuro);
    await writeFile(
      join(client.root, "config.json"),
      JSON.stringify({ ...config, oojuro: "/bin/false" }),
    );
    const anchored = await client.call("record", {
      kind: "tool_result",
      body: { text: "trusted host executable" },
    });
    expect(anchored.id).toMatch(/^\d+$/);
  }, 60000);
});

it("registered prompt hook injects bounded facts; revoked tool authority cannot mutate memory", async () => {
  const root = await workspace();
  const memory = new MemoryClient({ workspaceDir: root, agentId: "main" }, options);
  await memory.call("curate", { changes: [change("preference", "Use Rust for the compiler.")] });
  const on = vi.fn<OpenClawPluginApi["on"]>();
  let create: OpenClawPluginToolFactory<2>["create"] | undefined;
  plugin.register(
    createTestPluginApi({
      pluginConfig: options,
      on,
      registerTool(factory) {
        if (typeof factory === "object" && "contextVersion" in factory) {
          create = factory.create;
        }
      },
    }),
  );
  const before = on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1] as (
    event: { prompt: string; currentUserMessage?: string; messages: unknown[] },
    context: {
      workspaceDir: string;
      agentId: string;
      sessionId: string;
      trigger: string;
      hookInvocation: { assertActive(): void };
      memoryAudience: { kind: "owner-private"; agentId: string };
    },
  ) => Promise<{ prependContext: string }>;
  const prompt = await before(
    { prompt: "compiler", currentUserMessage: "compiler", messages: [] },
    {
      workspaceDir: root,
      agentId: "main",
      sessionId: "synthetic",
      trigger: "user",
      memoryAudience: { kind: "owner-private", agentId: "main" },
      hookInvocation: { assertActive() {} },
    },
  );
  expect(prompt.prependContext).toContain("Use Rust for the compiler.");
  expect(prompt.prependContext).toContain('trust="untrusted-context"');
  expect(Buffer.byteLength(prompt.prependContext)).toBeLessThan(12000);
  const nativePrompt = await before(
    { prompt: "CompositeOnlyMarker compiler", messages: [] },
    {
      workspaceDir: root,
      agentId: "main",
      sessionId: "synthetic",
      trigger: "user",
      memoryAudience: { kind: "owner-private", agentId: "main" },
      hookInvocation: { assertActive() {} },
    },
  );
  expect(nativePrompt.prependContext).toContain("Use Rust for the compiler.");
  const contextEvidence = await memory.call("journalSearch", { query: "CompositeOnlyMarker" });
  expect(contextEvidence.length).toBeGreaterThan(0);
  const capturedContext = contextEvidence.map((hit) => hit.text).join("\n");
  expect(capturedContext).toContain('"kind":"request_context"');
  expect(capturedContext).toContain('"source":"runtime"');
  expect(capturedContext).not.toContain('"kind":"user_request"');
  let active = true;
  const ctx: OpenClawPluginToolContext<2> = {
    workspaceDir: root,
    agentId: "main",
    memoryAudience: { kind: "owner-private", agentId: "main" },
    assertInvocationCurrent() {
      if (!active) {
        throw new Error("revoked");
      }
    },
  };
  expect(
    create?.({ workspaceDir: root, agentId: "main", assertInvocationCurrent() {} }),
  ).toBeNull();
  const tools = create?.(ctx);
  expect(Array.isArray(tools)).toBe(true);
  if (!Array.isArray(tools)) {
    throw new Error("memory tools not registered");
  }
  const curate = tools.find((tool) => tool.name === "softaxiom_memory");
  if (!curate) {
    throw new Error("curation tool not registered");
  }
  active = false;
  await expect(
    curate.execute("synthetic", {
      operation: "curate",
      args: { changes: [change("blocked", "Must not persist")] },
    }),
  ).rejects.toThrow("revoked");
  expect((await memory.call("list")).total).toBe(1);
}, 60000);

it("registers a real native memory provider with caller-bound search/get/health and closed-handle rejection", async () => {
  const root = await workspace();
  const memory = new MemoryClient({ workspaceDir: root, agentId: "main" }, options);
  await memory.call("curate", {
    changes: [change("compiler", "First compiler line.\nSecond compiler line.")],
  });
  let runtime: NonNullable<MemoryPluginCapability["providerRuntime"]> | undefined;
  plugin.register(
    createTestPluginApi({
      pluginConfig: options,
      registerMemoryCapability(capability) {
        runtime = capability.providerRuntime;
      },
    }),
  );
  if (!runtime) {
    throw new Error("native provider runtime missing");
  }
  const cfg = { agents: { entries: { main: { workspace: root } } } };
  let active = true;
  const context = {
    authority: {
      kind: "session" as const,
      sessionKey: "agent:main:synthetic",
      sandboxed: false,
      audience: { kind: "owner-private" as const, agentId: "main" },
    },
    assertCurrent() {
      if (!active) {
        throw new Error("revoked");
      }
    },
  };
  const opened = await runtime.open({ cfg, agentId: "main", context });
  if (!opened.provider) {
    throw new Error(opened.error ?? "native memory provider missing");
  }
  const provider = opened.provider;
  expect(await provider.health()).toEqual({ status: "ready" });
  const page = await provider.search({ query: "compiler", sources: ["memory"], maxResults: 5 });
  const hit = page.hits.find((value) => value.reference.id === "memory:compiler");
  if (!hit) {
    throw new Error("native memory search did not read curated memory");
  }
  expect(await provider.get({ reference: hit.reference, from: 2, lines: 1 })).toMatchObject({
    status: "ok",
    text: "Second compiler line.",
    from: 2,
    lines: 1,
    truncated: false,
  });
  const guest = await runtime.open({
    cfg,
    agentId: "main",
    context: {
      ...context,
      authority: {
        kind: "session",
        sessionKey: "group:synthetic",
        sandboxed: false,
        audience: {
          kind: "conversation",
          agentId: "main",
          sessionKey: "group:synthetic",
          sessionId: "one",
        },
      },
    },
  });
  if (!guest.provider) {
    throw new Error("conversation memory provider missing");
  }
  expect((await guest.provider.search({ query: "compiler" })).hits).toEqual([]);
  await guest.provider.close();
  active = false;
  await expect(provider.search({ query: "compiler" })).rejects.toThrow("revoked");
  active = true;
  await provider.close();
  await expect(provider.get({ reference: hit.reference })).rejects.toMatchObject({
    code: "MEMORY_HANDLE_CLOSED",
  });
  const status = await runtime.open({
    cfg,
    agentId: "main",
    purpose: "status",
    context: {
      authority: { kind: "host", operation: "status" },
      assertCurrent() {},
    },
  });
  if (!status.provider) {
    throw new Error("status provider missing");
  }
  expect(await status.provider.health()).toEqual({ status: "ready" });
  await expect(status.provider.search({ query: "compiler" })).rejects.toMatchObject({
    code: "MEMORY_CONTENT_NOT_AVAILABLE_FOR_STATUS",
  });
  await status.provider.close();
}, 60000);
