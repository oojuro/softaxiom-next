// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { check, hash, MemoryError } from "./common.js";
import type { OperationResults } from "./store.js";

export type MemoryScope = {
  workspaceDir: string;
  agentId: string;
  audience?:
    | { kind: "owner-private"; agentId: string }
    | {
        kind: "conversation";
        agentId: string;
        sessionKey: string;
        sessionId: string;
      };
};
export type MemoryOptions = { oojuro?: string; timezone?: string };

export function memoryRoot(scope: MemoryScope) {
  check(/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(scope.agentId), "INVALID_AGENT_ID");
  check(!scope.audience || scope.audience.agentId === scope.agentId, "MEMORY_AUDIENCE_MISMATCH");
  const partition =
    scope.audience?.kind === "conversation"
      ? `conversation-${hash(JSON.stringify([scope.audience.sessionKey, scope.audience.sessionId])).slice(0, 32)}`
      : "private";
  return join(resolve(scope.workspaceDir), "memory", "softaxiom", scope.agentId, partition);
}

export class MemoryClient {
  readonly root: string;
  constructor(
    readonly scope: MemoryScope,
    readonly options: MemoryOptions = {},
  ) {
    this.root = memoryRoot(scope);
  }

  async call<K extends keyof OperationResults>(
    operation: K,
    args: unknown = {},
    authority: () => void = () => {},
    signal?: AbortSignal,
  ): Promise<OperationResults[K]> {
    // Never follow workspace-created memory links into another agent's private files.
    let directory = resolve(this.scope.workspaceDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const component of [
      "memory",
      "softaxiom",
      this.scope.agentId,
      this.root.split("/").at(-1)!,
    ]) {
      directory = join(directory, component);
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") {
          throw error;
        }
      });
      const stat = await lstat(directory);
      check(
        stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.(),
        "UNSAFE_MEMORY_DIRECTORY",
      );
    }
    const lock = join(this.root, ".lock");
    const handle = await open(lock, "a", 0o600);
    await handle.close();
    const lockStat = await lstat(lock);
    check(
      lockStat.isFile() &&
        !lockStat.isSymbolicLink() &&
        lockStat.nlink === 1 &&
        lockStat.uid === process.getuid?.(),
      "UNSAFE_MEMORY_LOCK",
    );
    signal?.throwIfAborted();
    authority();
    const worker = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "store-worker",
      distWorkerPath: "extensions/softaxiom-memory/store-worker.js",
      package: { name: "@softaxiom/memory", distWorkerPath: "store-worker.js" },
    });
    return new Promise((done, reject) => {
      const child = spawn(
        "flock",
        [
          "--exclusive",
          "--timeout",
          "10",
          lock,
          process.execPath,
          ...resolveRuntimeWorkerArgv(worker),
          this.root,
        ],
        {
          cwd: this.root,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: process.env.LANG,
            TZ: process.env.TZ,
          },
          stdio: ["pipe", "pipe", "pipe"],
          signal,
          timeout: 120000,
        },
      );
      const chunks: Buffer[] = [];
      let bytes = 0,
        failed = false;
      const fail = (error: Error) => {
        if (!failed) {
          failed = true;
          child.kill();
          reject(error);
        }
      };
      child.on("error", () => fail(new MemoryError("MEMORY_WORKER_FAILED")));
      child.stdin.on("error", () => fail(new MemoryError("MEMORY_WORKER_FAILED")));
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          fail(new MemoryError("MEMORY_RESPONSE_TOO_LARGE"));
        } else {
          chunks.push(chunk);
        }
      });
      // Native error streams can include private input; expose bounded error codes only.
      child.stderr.resume();
      child.on("close", (code) => {
        if (failed) {
          return;
        }
        if (code !== 0) {
          return fail(new MemoryError("MEMORY_WORKER_FAILED"));
        }
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.error) {
            throw new MemoryError(response.error.code);
          }
          done(response.value);
        } catch (error) {
          fail(error instanceof MemoryError ? error : new MemoryError("INVALID_MEMORY_RESPONSE"));
        }
      });
      child.stdin.end(JSON.stringify({ operation, args, settings: this.options }));
    });
  }
}
