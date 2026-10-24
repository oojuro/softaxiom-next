// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
// Hosted request policy around the native OpenClaw provider context.
import type { Context, Message } from "../provider.ts";
import { createHash } from "node:crypto";
import type { OperationId, PersonId } from "../../contracts/ids.ts";
import type { Budget } from "../../money/ports.ts";
import type { ModelRole, ModelRoute } from "./catalog.ts";
import { assertFireworks } from "./fireworks.ts";
import { assertInputBound } from "./input-bound.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema. The model sees it; nothing here runs the tool.
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  operationId: OperationId;
  role: ModelRole;
  // Stable text for this role. Anything that changes each round belongs in `context`.
  system: string;
  tools: ToolDefinition[];
  // Live state comes only from OpenClaw. Historical storage is decoded before this boundary.
  engineHistory: Message[];
  // What is new this round and not part of the record: the time, recall matches, fact notes.
  context?: string;
  // Set on the one retry after a charged answer was lost: the platform pays and the person does
  // not (see `createGateway`). Its independent paid attempt still has a durable dispatch mark.
  fundedBy?: "platform";
  // Durable operator-alert funding, selected from the saved run by worker code.
  funding?: "platform";
  // A daily allowance the work may not exceed (the summarizer's); a call over it is declined.
  budget?: Budget;
  signal?: AbortSignal;
}

/**
 * The cache a person's hosted requests share at Fireworks, where routing decides whether a
 * prefix is found again. It is a hash, so no provider learns a person id; roles get their own so
 * a work run never crowds out the chat prefix.
 */
export const cacheKeyFor = (personId: PersonId, role: ModelRole) =>
  `sa-${createHash("sha256").update(`${personId}:${role}`).digest("hex").slice(0, 32)}`;

export interface ShapedPrompt extends Context {
  headers: Record<string, string>;
}

export function shapePrompt(route: ModelRoute, request: ModelRequest, key: string): ShapedPrompt {
  assertFireworks(route.provider);
  assertInputBound(route, request);
  return {
    systemPrompt: request.system,
    messages: [...request.engineHistory, ...(request.context
      ? [{ role: "user" as const, content: request.context, timestamp: 0 }] : [])],
    tools: [...request.tools]
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema })),
    headers: { "x-session-affinity": key },
  };
}
