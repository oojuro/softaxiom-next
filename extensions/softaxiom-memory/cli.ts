import type { Command } from "commander";
// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MemoryClient, type MemoryOptions } from "./client.js";
import { check } from "./common.js";
import { readReference, recall } from "./index.js";

const print = (value: unknown) => {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
};

async function input() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    check(bytes <= 256 * 1024, "MEMORY_INPUT_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function registerMemoryCli(
  program: Command,
  config: OpenClawConfig,
  options: MemoryOptions,
) {
  const group = program
    .command("memory")
    .description("Soft Axiom tiered memory and Oojuro evidence")
    .option("--agent <id>", "Agent whose memory to inspect")
    .option("--workspace <directory>", "Explicit operator workspace override");
  const memory = () => {
    const args = group.opts<{ agent?: string; workspace?: string }>();
    const agentId = args.agent ?? resolveDefaultAgentId(config);
    return new MemoryClient(
      { agentId, workspaceDir: args.workspace ?? resolveAgentWorkspaceDir(config, agentId) },
      options,
    );
  };
  group
    .command("init")
    .description("Create five tiers and verify the real Oojuro journal")
    .action(async () => print(await memory().call("initialize")));
  for (const name of ["status", "usage"]) {
    group
      .command(name)
      .description("Inspect tier capacities and overflow")
      .action(async () => {
        const client = memory();
        print({ root: client.root, ...(await client.call("usage")) });
      });
  }
  group
    .command("list")
    .description("List curated memory IDs and revisions")
    .option("--offset <number>", "Pagination offset", "0")
    .action(async (args: { offset: string }) =>
      print(await memory().call("list", { offset: Number(args.offset) })),
    );
  group
    .command("search <query>")
    .description("Search curated memory and Oojuro evidence")
    .action(async (query: string) => print(await recall(memory(), query)));
  group
    .command("get <reference>")
    .description("Read memory:ID, journal:ID or diary:YYYY-MM-DD")
    .option("--offset <number>", "UTF-8 byte offset", "0")
    .action(async (reference: string, args: { offset: string }) =>
      print(await readReference(memory(), reference, Number(args.offset))),
    );
  group
    .command("curate")
    .description("Apply revision-checked {changes:[...]} JSON from stdin")
    .action(async () => print(await memory().call("curate", await input())));
  group
    .command("days")
    .description("List diaries and days awaiting curation")
    .action(async () => print(await memory().call("days")));
  group
    .command("diary <day>")
    .description("Read a bounded diary excerpt")
    .option("--offset <number>", "UTF-8 byte offset", "0")
    .action(async (day: string, args: { offset: string }) =>
      print(await memory().call("diary", { day, offset: Number(args.offset) })),
    );
  group
    .command("write-diary")
    .description("Write {day,text,expectedRevision} JSON from stdin")
    .action(async () => print(await memory().call("writeDiary", await input())));
  group
    .command("record")
    .description("Record an untrusted operator note from {kind,body} JSON stdin")
    .action(async () => {
      const value = await input();
      print(
        await memory().call("record", {
          kind: value.kind,
          body: value.body,
          meta: { source: "tool", session: "operator" },
        }),
      );
    });
  group
    .command("checkpoint <destination>")
    .description("Save all five tiers as a complete immutable snapshot")
    .action(async (destination: string) =>
      print(await memory().call("checkpoint", { destination })),
    );
  group
    .command("restore <snapshot> <sha256>")
    .description("Restore a verified snapshot into fresh agent memory only")
    .action(async (snapshot: string, sha256: string) => {
      const { restoreCheckpoint } = await import("./checkpoint.js");
      print(restoreCheckpoint(snapshot, memory().root, sha256));
    });
}
