// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs";
import { MemoryError } from "./common.js";
import { Store, prepare } from "./store.js";

process.umask(0o077);
try {
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  prepare(process.argv[2]!, request.settings);
  const store = new Store(process.argv[2]!, undefined, request.settings?.oojuro ?? "oojuro");
  const value = store.dispatch(request.operation, request.args);
  process.stdout.write(JSON.stringify({ value }));
} catch (error) {
  const value =
    error instanceof MemoryError
      ? { code: error.code, details: error.details }
      : { code: "STORE_IO_ERROR" };
  process.stdout.write(JSON.stringify({ error: value }));
}
