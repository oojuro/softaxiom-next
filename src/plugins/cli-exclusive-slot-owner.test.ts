/** Exclusive CLI roots follow the selected slot without disabling setup discovery. */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, expect, it, onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  loadPluginCliRegistrationEntriesWithDefaults,
  resolvePluginCliRootOwnerIds,
} from "./cli-registry-loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function setup(slot?: string): OpenClawConfig {
  useNoBundledPlugins();
  const paths = ["memory-core", "softaxiom-memory"].map((id) => {
    const dir = makePluginLoaderTempDir();
    writePlugin({
      id,
      dir,
      filename: "index.cjs",
      body: `module.exports = { id: ${JSON.stringify(id)}, kind: "memory", register(api) {
        api.registerCli(({ program }) => {
          program.command("memory").description(${JSON.stringify(id)})
            .command("usage").action(() => { program.result = ${JSON.stringify(id)}; });
        }, { commands: ["memory"], descriptors: [
          { name: "memory", description: ${JSON.stringify(id)}, hasSubcommands: true }
        ] });
      } };`,
    });
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        kind: "memory",
        configSchema: { type: "object", additionalProperties: false },
        cliCommands: [{ name: "memory", description: id, hasSubcommands: true }],
        activation: { onCommands: id === "memory-core" ? ["core-setup"] : [] },
      }),
    );
    return path.join(dir, "index.cjs");
  });
  return {
    plugins: {
      allow: ["memory-core", "softaxiom-memory"],
      load: { paths },
      ...(slot ? { slots: { memory: slot } } : {}),
    },
  };
}

it.each([
  [undefined, "softaxiom-memory"],
  ["memory-core", "memory-core"],
] as const)("dispatches the selected memory CLI (slot %s)", async (slot, owner) => {
  const cfg = setup(slot);
  const session = createPluginCliLoadSession();
  onTestFinished(() => session.close());
  const params = { cfg, env: {}, primaryCommand: "memory", session };
  expect(await resolvePluginCliRootOwnerIds(params)).toEqual([owner]);
  expect(await loadPluginCliDescriptors(params)).toEqual([
    { name: "memory", description: owner, hasSubcommands: true },
  ]);
  const entries = await loadPluginCliRegistrationEntriesWithDefaults(params, "metadata");
  expect(entries.map((entry) => entry.pluginId)).toEqual([owner]);
  const runtimeEntries = await loadPluginCliRegistrationEntriesWithDefaults(params);
  expect(runtimeEntries.map((entry) => entry.pluginId)).toEqual([owner]);
  const program = new Command() as Command & { result?: string };
  await entries[0]!.register(program);
  await program.parseAsync(["memory", "usage"], { from: "user" });
  expect(program.result).toBe(owner);
});

it("retains an inactive exclusive plugin's unrelated setup command", async () => {
  const session = createPluginCliLoadSession();
  onTestFinished(() => session.close());
  expect(
    await resolvePluginCliRootOwnerIds({
      cfg: setup(),
      env: {},
      primaryCommand: "core-setup",
      session,
    }),
  ).toEqual(["memory-core"]);
});
