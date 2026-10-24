# Replace the engine, preserve the product

Owner decision, 2026-10-24: replace the complete superseded Soft Axiom runtime with
OpenClaw. Keep `sa` commands as thin product extensions. Do not ship a selectable legacy
runtime. This decision supersedes the incremental loop-wrapper design in PR #28.

## Ownership

| Responsibility | Owner after replacement |
| --- | --- |
| Agent state, turn lifecycle, message/tool sequencing, interruption | OpenClaw agent engine |
| Session replay, tool-result pairing, context estimation and compaction | OpenClaw engine and harness; host storage ports |
| Provider protocols, reasoning replay and usage normalization | OpenClaw provider transports |
| Tiered files, diary, lexical retrieval and cold journal | Soft Axiom memory extension and Oojuro |
| Radar, Bridge, Compass and specialist journeys | Soft Axiom extensions, using the same engine |
| Grants, approval, revocation, bounded spending, effect receipts | Soft Axiom enforcement at engine and tool boundaries |
| Hosted durable tasks, tenant credentials, billing and fleet | Private sa-cloud adapters; Temporal remains durable owner |

The public CLI remains model agnostic. The hosted composition admits only Fireworks.
No embedding model, vector service or automatic model download is enabled.

## Removal ledger

An item is only removed when its callers, security/recovery tests and packaging have moved.
Passing tests of the previous implementation are historical evidence, not replacement acceptance.

| Superseded implementation | Replacement | State |
| --- | --- | --- |
| `core/agent/engine.ts` callback loop wrapper | OpenClaw `Agent` lifecycle | Removed; source-preview checks pass, final install proof pending |
| Local `LocalAgent` message/tool loop and parallel model history | Engine state and tool hooks | Removed; source-preview checks pass, final install proof pending |
| Local AI SDK provider projection and replay cache | Upstream provider protocols | Removed; source-preview checks pass, final install proof pending |
| Custom context window, compaction and tool-batch cuts | Upstream session/context/compaction harness, with product-only request framing | Removed from current shared source; private context/receipt wiring pending |
| Hosted AI SDK execution and its provider packages | Upstream native transports behind the hosted admission/billing adapter | Removed from shared distribution; private native-provider CI passes; final lifecycle integration pending |
| Shared tool-batch scheduler in `tools/runtime.ts` | OpenClaw selects/sequences calls; `tools/executor.ts` enforces one call and receipts it | Removed from current source; cloud pin/wiring pending |
| Shared model-round context/compaction retry loop | `runs/sample.ts` receives engine-selected captured requests and indexed receipts | Removed from current source; cloud pin/wiring pending |
| Hosted hand-written run scheduler in sa-cloud | Temporal lifecycle around the shared engine | Pending |

The shared package no longer depends on `ai` or `@ai-sdk/*`. Historical transcript DTOs
are data-only compatibility; they cannot dispatch a model. Native assistant records retain
usage and opaque provider state, while rollback readers receive the existing text/tool projection.

## Native boundary cleanup

The comparison against the pinned OpenClaw source found duplicate compatibility machinery
after the first loop replacement. The follow-up removes it from production:

The comparison used upstream `agent-core/src/agent.ts` and `agent-loop.ts` for lifecycle/tool
scheduling, `llm-core/src/validation.ts` for arguments, `ai/src/transcript-transform.ts` for
provider replay/interruption repair, and the harness session/compaction modules for context.
Those files remain in the reviewed 229-module closure at the same immutable upstream revision.

| Previous Soft Axiom implementation | Current owner |
| --- | --- |
| `lib/engine-messages.ts`, local `ChatMessage`/`ToolCall` DTOs and `fixtureStream` | Native OpenClaw `Message`, `Tool` and `StreamFn`; old synthetic fixture conversion exists only under `test/` |
| `HttpModel.complete` and repeated OpenAI-shaped tool/argument serialization | Native request-scoped provider stream; upstream schema validation precedes product tool dispatch |
| Optional native history with a live legacy-provider fallback | Required `ModelRequest.engineHistory`; legacy or mixed live requests are rejected before dispatch |
| AI-SDK-shaped `ShapedPrompt` and tool dictionary | Native OpenClaw `Context` plus the host's affinity header |
| Historical viewer's open-call map and invented interruption results | Storage decoding returns native messages; upstream `transcript-transform.ts` owns repair |
| Local chat's extra 8,000-byte context-selection loop | Supply the bounded journal page to OpenClaw session admission/compaction |

The storage decoder in `context/history.ts` remains necessary for old encrypted records and
rollback-readable output. It never samples a model, executes tools, selects a context window
or retries work. Local readable evidence excludes opaque provider replay and thinking.

The remaining original runtime code supplies memory, folder grants, external-action approvals,
receipt persistence, model-profile/egress policy and resource limits. These enforce product
requirements at the engine's hooks; they do not implement a second agent loop. The five-tier
memory store, Radar delivery queue and Temporal host coordination are distinct state owners,
not replacements for OpenClaw's turn/tool scheduling.

### Consumer migration

This preview deliberately removes the old completion interface. Local injected models provide
`{ stream: StreamFn }`; local tool descriptors use `{ name, description, parameters }` directly.
`HttpModel` supplies `selection` and `stream`, not `complete`. Hosted request constructors must
provide native `engineHistory` and omit `history`; `shapePrompt` returns native `systemPrompt`,
`messages` and `tools`. `context/view.toMessages` now returns native messages and does not repair
tool-result pairs. Historical decoding moved from `gateway/legacy-history` to `context/history`.

The private cloud must migrate its consumers and rerun its checks before advancing its immutable
public dependency pin. A green run against the earlier pin is not verification of this cleanup.
This source change does not import the full OpenClaw Gateway or implement device pairing.

### Cleanup verification

The cleanup passes `npm run check` on Node 24.22.1: **163 tests, zero failures or skips**, with
the actual Oojuro executable built from reviewed source `3a17d1d`, Chrome, Bubblewrap and
PowerShell fixtures. This includes native request admission, upstream interruption repair and
schema validation, private replay/signature exclusion and redacted returned text. Strict builds,
core boundaries, unchanged upstream provenance and distribution/license checks pass. A fresh
production-only package passes CLI help and a strict Node-only TypeScript consumer with
`skipLibCheck: false`. No live model call or hosted deployment is established by these fixtures.

Storage adapters must preserve operation IDs, uncertain effects, durable receipts, account isolation
and historical readers. Retaining a historical reader does not permit retaining an executable
legacy engine. Neither draft is ready for review or merge until replacement verification passes.

Installer promotion, merging and deployment remain unauthorized for these drafts.
