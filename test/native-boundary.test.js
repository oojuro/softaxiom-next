// SPDX-FileCopyrightText: 2026 Soft Axiom contributors
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapePrompt } from '../lib/core/agent/gateway/prompt.js';
import { toMessages } from '../lib/core/agent/context/view.js';
import { transformMessages } from '../lib/core/upstream/openclaw/ai/src/transcript-transform.js';
import { createAssistantMessageEventStream } from '../lib/core/agent/provider.js';
import { createEmptyTransportUsage } from '../lib/core/upstream/openclaw/ai/src/transports/transport-stream-shared.js';
import { Memory } from '../lib/store.js';
import { LocalAgent } from '../lib/runtime.js';
import { Journal } from '../lib/journal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const route = { provider: 'fireworks', model: 'fixture', maxInputTokens: 32000, maxOutputTokens: 1024 };
const request = { operationId: 'native-request', role: 'chat', system: 'Synthetic instructions',
  tools: [], engineHistory: [{ role: 'user', content: 'Current question', timestamp: 0 }] };

test('hosted admission rejects legacy or mixed histories rather than choosing a second live transcript', () => {
  const { engineHistory, ...legacy } = request;
  for (const input of [{ ...legacy, history: [] }, { ...request, history: [] },
    { ...request, engineHistory: undefined }]) {
    assert.throws(() => shapePrompt(route, input, 'fixture'), error => error.code === 'invalid_input');
  }
  const prompt = shapePrompt(route, { ...request, context: 'Outside product context' }, 'fixture');
  assert.equal(prompt.messages[0], engineHistory[0]);
  assert.deepEqual(prompt.messages[1], { role: 'user', content: 'Outside product context', timestamp: 0 });
});

test('historical decoding leaves interrupted tool repair to the actual upstream transport', () => {
  const row = (kind, role, provenance, body, seq) => ({ kind, role, provenance, body, seq,
    op: `fixture:${seq}`, path: 'conversations/fixture.jsonl', at: '2026-10-24T12:00:00Z' });
  const decoded = toMessages([
    row('message', 'user', 'person', { text: 'Read the synthetic file' }, 1),
    row('model', 'assistant', 'agent', { messages: [{ role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'missing', toolName: 'read', input: {} },
      { type: 'tool-call', toolCallId: 'saved', toolName: 'read', input: {} },
    ] }] }, 2),
    row('tool_result', 'assistant', 'agent', { id: 'saved', name: 'read', result: 'Outside file content' }, 3),
    row('message', 'user', 'person', { text: 'Continue after the interruption' }, 4),
  ], { isOutside: () => true });
  assert.equal(decoded.filter(message => message.role === 'toolResult').length, 1,
    'the storage adapter must not manufacture missing results');
  assert.match(decoded[2].content[0].text, /outside|untrusted/i);
  assert.match(decoded[2].content[0].text, /Outside file content/);
  const model = { ...route, id: 'fixture', name: 'fixture', api: 'openai-completions',
    baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'],
    contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const replay = transformMessages(decoded, model);
  const results = replay.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 2);
  assert.equal(results.find(message => message.toolCallId === 'missing').isError, true);
  assert.equal(results.find(message => message.toolCallId === 'saved').isError, false);
  assert.equal(decoded.filter(message => message.role === 'toolResult').length, 1,
    'upstream repair must not mutate stored evidence');
});

test('local callers use native streams and upstream argument validation before product dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sa-native-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = new Memory(join(root, 'memory'));
  memory.initialize({ oojuro: process.env.OOJURO_BIN || 'oojuro' });
  let rounds = 0, invalidDispatches = 0;
  const hidden = 'NATIVE_PRIVATE_PROVIDER_STATE';
  const credential = 'ghp_' + 'A1b2C3d4'.repeat(5);
  const agent = new LocalAgent(root, { stream: async (_model, context) => {
    assert(context.tools.some(tool => tool.name === 'memory' && !('function' in tool)));
    const first = rounds++ === 0;
    if (!first) {
      const results = context.messages.filter(message => message.role === 'toolResult');
      assert.equal(results.find(message => message.toolCallId === 'usage').isError, false);
      assert.equal(results.find(message => message.toolCallId === 'invalid').isError, true);
      assert.match(results.find(message => message.toolCallId === 'usage').content[0].text, /accounting/);
    }
    const message = { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture',
      timestamp: 0, usage: createEmptyTransportUsage(), stopReason: first ? 'toolUse' : 'stop',
      content: first ? [
        { type: 'toolCall', id: 'usage', name: 'memory', arguments: { operation: 'usage', args: {} }, thoughtSignature: hidden },
        { type: 'toolCall', id: 'invalid', name: 'inspect', arguments: { operation: 'delete', args: [] } },
      ] : [{ type: 'thinking', thinking: hidden }, { type: 'text', text: `Native lifecycle complete. ${credential}` }],
      providerReplay: { syntheticPrivate: hidden },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: message.stopReason, message });
    return stream;
  } });
  const result = await agent.run('Inspect usage without dispatching malformed tools.', {
    tools: [{ name: 'inspect', description: 'Synthetic read-only tool', parameters: {
      type: 'object', properties: { operation: { type: 'string', enum: ['read'] },
        args: { type: 'object' } }, required: ['operation', 'args'], additionalProperties: false,
    } }], execute: () => { invalidDispatches++; return {}; },
  });
  assert.match(result.text, /^Native lifecycle complete\./);
  assert(!result.text.includes(credential), 'returned text comes from the redacted journal receipt');
  assert.equal(rounds, 2);
  assert.equal(invalidDispatches, 0);
  const records = new Journal(memory.root, memory.call('settings')).range(
    new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 1000).toISOString(), 40);
  assert(!JSON.stringify(records).includes(hidden), 'readable evidence excludes private provider state and thinking');
  assert(!JSON.stringify(records).includes(credential));
});
