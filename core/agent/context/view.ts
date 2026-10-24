// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
// Historical storage decoding and outside-content labels only. OpenClaw owns tool-result
// pairing, interruption repair and context selection; this adapter never invents results.
import { historicalMessages } from "./history.ts";
import type { Message } from "../provider.ts";
import type { ModelMessage } from "../../contracts/historical-model.ts";
import { z } from "zod";
import { clip } from "./clip.ts";
import { outside } from "./outside.ts";
import type { StoredLine } from "./ports.ts";

export interface ViewLine extends StoredLine {
  path: string;
}

export interface ViewOptions {
  allowAssistantStart?: boolean;
  isOutside(tool: string): boolean;
}

const messageBody = z.looseObject({
  text: z.string().default(""),
  attachments: z.array(z.object({ path: z.string().nullable(), contentType: z.string().nullable() })).default([]),
});
const modelBody = z.looseObject({
  text: z.string().default(""),
  messages: z.array(z.looseObject({ role: z.string() })).optional(),
});
const resultBody = z.looseObject({ id: z.string(), name: z.string(), result: z.unknown() });
export const noteBody = z.looseObject({ fact: z.string() });

const personWords = (line: ViewLine, body: z.output<typeof messageBody>) => {
  const files = body.attachments.map(({ path, contentType }) =>
    `\n[attachment: ${path ?? "not saved"}${contentType ? ` ${contentType}` : ""}]`);
  return `${line.channel ? `[${line.channel}] ` : ""}${body.text}${files.join("")}`;
};
const noteText = ({ fact, ...detail }: z.output<typeof noteBody>) =>
  [`[note] ${fact}`, ...Object.entries(detail).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)].join("; ");

export function toMessages(lines: ViewLine[], { isOutside, allowAssistantStart }: ViewOptions): Message[] {
  const messages: Message[] = [];
  for (const line of lines) {
    if (line.kind === "tool_result") {
      const body = resultBody.safeParse(line.body);
      if (!body.success) continue;
      const { id, name, result } = body.data;
      const full = typeof result === "string" ? result : JSON.stringify(result ?? null);
      const shown = clip(full, `${line.path}:${line.seq}`).text;
      messages.push({ role: "toolResult", toolCallId: id, toolName: name, timestamp: 0,
        content: [{ type: "text", text: isOutside(name) ? outside(name, line.op, shown) : shown }], isError: false });
    } else if (line.kind === "model") {
      const body = modelBody.safeParse(line.body);
      if (!body.success) continue;
      const stored = (body.data.messages ?? [{ role: "assistant", content: body.data.text }]) as ModelMessage[];
      messages.push(...historicalMessages(stored).filter(message => message.role !== "assistant" ||
        message.content.some(part => part.type === "toolCall" || (part.type === "text" && part.text.trim() !== ""))));
    } else if (line.kind === "note") {
      const body = noteBody.safeParse(line.body);
      if (body.success) messages.push({ role: "user", timestamp: 0, content: line.provenance === "operator"
        ? outside("operator", line.op, noteText(body.data)) : noteText(body.data) });
    } else if (line.kind === "message") {
      // A delivered reply already belongs to its stored model/tool exchange.
      if (line.role === "assistant" && line.run) continue;
      const body = messageBody.safeParse(line.body);
      if (!body.success) continue;
      if (line.role === "assistant") {
        messages.push(...historicalMessages([{ role: "assistant", content: body.data.text }]));
      } else {
        // A delegated task's own user/job line is distinct from an outside report.
        const trusted = line.provenance === "person" || (line.role === "user" && line.provenance === "agent");
        const text = personWords(line, body.data);
        messages.push({ role: "user", timestamp: 0, content: trusted ? text : outside(line.provenance, line.op, text) });
      }
    }
  }
  if (allowAssistantStart) return messages;
  const firstUser = messages.findIndex(message => message.role === "user");
  return firstUser < 0 ? [] : messages.slice(firstUser);
}
