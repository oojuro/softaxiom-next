// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import { check, excerpt, hash } from "./common.js";
import type { Store } from "./store.js";

export function readMemoryLines(
  store: Pick<Store, "memories" | "journal" | "diary">,
  reference: string,
  from: number,
  lines: number,
) {
  check(
    Number.isSafeInteger(from) &&
      from > 0 &&
      Number.isSafeInteger(lines) &&
      lines > 0 &&
      lines <= 200,
    "INVALID_MEMORY_LINES",
  );
  const match = /^(memory:([a-z0-9][a-z0-9-]{0,63})|journal:(\d+)|diary:(\d{4}-\d{2}-\d{2}))$/.exec(
    reference,
  );
  check(match, "INVALID_MEMORY_REFERENCE");
  let text: string, revision: string;
  if (match[2]) {
    const memory = store.memories().find((value) => value.id === match[2]);
    check(memory, "MEMORY_NOT_FOUND");
    text = memory.body;
    revision = memory.revision;
  } else if (match[3]) {
    const record = store.journal.call(["get", match[3]]);
    check(record && record.writer === "softaxiom:local", "EVIDENCE_NOT_FOUND");
    text = record.text;
    revision = hash(text);
  } else {
    const diary = store.diary(match[4]!);
    check(diary.text !== null && diary.revision !== null, "MEMORY_NOT_FOUND");
    text = diary.text;
    revision = diary.revision;
  }
  const all = text.split("\n");
  const selected = all.slice(from - 1, from - 1 + lines);
  const bounded = excerpt(selected.join("\n"), 8000);
  const more = from - 1 + selected.length < all.length;
  return {
    text: bounded.text,
    revision,
    from,
    lines: selected.length,
    truncated: bounded.partial || more,
    ...(!bounded.partial && more ? { nextFrom: from + selected.length } : {}),
  };
}
