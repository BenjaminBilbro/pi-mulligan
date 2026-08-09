# External Dependencies & Module Architecture — pi-mulligan

> Verified against installed `.d.ts` on Pi 0.84.1 (2026-08-08). Canonical contract
> = the spec (`spec/05-09-11`); this file records verified signatures + the
> internal module boundary that downstream subtasks hand off across.

## 1. Runtime dependencies

| Package | Source | Role | Notes |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | resolved by Pi at extension load (jiti) | `ExtensionAPI`, `ExtensionContext`, events, `AgentMessage` | For editor IntelliSense: `npm install` in the ext dir; consult `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts` (authoritative). Present in sibling `/home/dustin/projects/pi-mulligan/node_modules`. |
| `typebox` | resolved by Pi at load | tool parameter schemas (`Type.Object`, `Type.Union`, `Type.Literal`, …) | `import { Type } from "typebox"`. |
| `@earendil-works/pi-ai` | transitive | base `Message`/`TextContent`/`ImageContent` types | imported indirectly via pi-coding-agent re-exports. |
| `node:*` built-ins | always | `node:fs` (logger append), `node:crypto`/`crypto.randomUUID` (marker ids) | no other node deps required. |

No other runtime deps. No network. No long-lived resources (per spec/01: defer
to `session_start`, tear down in `session_shutdown`; Mulligan has none).

## 2. Dev dependencies
- `typescript ^5` (strict, `target ES2022`, `module ESNext`, `moduleResolution Bundler`).
- `vitest ^1` (or `node:test`) — the pure-helper unit suite is the bulk of correctness.

## 3. Internal module boundary (the coherence map for subtask handoffs)

```
PURE (no Pi import; fully unit-testable) ─────────────────────────────────
  tokens.ts     estimateTokens, resultBytes, approxTokens   ──► (none)
  ledger.ts     extractFileLedger                            ──► (none)
  notes.ts      validateNote, renderNote, renderBloatReminder, renderDriftNudge
                                                          ──► ledger, tokens
  transforms.ts partitionIntoUnits; resolve{LastToolCallGroup,LastTurn,Checkpoint};
                 applyRewind, applyShrink, resolveShrinkTarget, protectedOk,
                 filterPipeline (rewinds+shrinks ONLY — nudge injected in filter.ts)
                                                          ──► tokens(none req), pure

PI-COUPLED (thin glue; integration-tested) ───────────────────────────────
  config.ts     getConfig(): validated+defaulted MulliganConfig (never throws)
  log.ts        structured JSONL logger (deferred open, path-safe)
  runtime.ts    Map<sessionId, SessionRuntime> {seq, tokenBaseline, lastTurnIndex,
                 lastFiltered, lastFilterTs}; created on session_start
  markers.ts    appendRewindMarker/appendShrinkMarker/appendTurnMetric/leaveNote/
                 setCheckpoint — wrap pi.appendEntry/sendMessage/setLabel;
                 capture leaf id via getLeafId() immediately after appendEntry (C7);
                 bump rt.seq
  nudges.ts     [Pi] tool_result annotator (Nudge A) + turn_end metric (Phase 1);
                 [pure] shouldNudge, injectNudge (Phase 2 — extends filter.ts)
  filter.ts     context handler: read markers → filterPipeline → cache lastFiltered
                 → (after M3.T3) injectNudge → return {messages}; fail-open try/catch
  tools/*.ts    thin execute(): validate → write marker(s)/note via markers.ts →
                 return text result. NEVER throw; NEVER read event.messages
                 (EXCEPTION: mulligan_audit reads runtime.lastFiltered, read-only)

ENTRY ────────────────────────────────────────────────────────────────────
  index.ts      default factory: getConfig; register 4 tools; attach handlers
                 (session_start, context, tool_result, turn_end); wire runtime
```

### 3.1 The one architectural-seam decision downstream agents MUST honor
The spec's pseudocode (spec/06 §1, §12) shows `filterPipeline` calling
`injectNudge`. If taken literally, the **pure** `transforms.ts` would depend on
`nudges.ts` (which has Pi-coupled handlers), breaking testability and creating a
build-order cycle (spec/11 Step 5 filter → Step 7 nudges). **Resolution for this
plan:** `filterPipeline` (M2.T6, pure) handles **rewinds + shrinks + protectedOk
only**. Nudge injection is applied in `filter.ts` (M3.T2, then extended in
M3.T3) **after** calling the pure pipeline, on the already-transformed array.
This keeps `transforms.ts` Pi-free, preserves the spec/11 build order, and is
semantically identical (the nudge appends one ephemeral message at the tail).
Every relevant `context_scope` restates this seam.

## 4. Persisted shapes (contracts the tools write & the filter reads)

All persisted via `pi.appendEntry`/`sendMessage`/`setLabel`; all
JSON-serializable. Every Mulligan `CustomEntry` data carries
`{ schema:"pi-mulligan", v:1, kind, … }`.

| Pi customType | Pi entry `type` | data.kind | In LLM ctx? | Writer | Reader |
|---|---|---|---|---|---|
| `mulligan:rewind` | `custom` | `"rewind"` | no | rewind tool | filter |
| `mulligan:shrink` | `custom` | `"shrink"` | no | shrink tool | filter |
| `mulligan:turn-metric` | `custom` | `"turn-metric"` | no | nudges(turn_end) | filter (latest only) |
| `mulligan:note` | `custom_message` | — | **yes** | rewind tool (via markers.leaveNote) | (the model) |
| `mulligan:checkpoint:<name>` | `label` | — | no | checkpoint tool | filter (resolveCheckpoint) |
| `mulligan:nudge` | (never persisted) | — | (ephemeral copy-only) | filter (injectNudge) | (the model) |

Marker fields are exactly as specified in spec/04 §3–5 (RewindMarker:
`{schema,v,kind:"rewind",id,granularity,options{to_previous_prompt?,protect?},
excludeToolCallId?,seq,note,ledger,ts}`; ShrinkMarker:
`{schema,v,kind:"shrink",id,target,replacement,reason?,seq,ts}`; TurnMetric:
`{schema,v,kind:"turn-metric",seq,ts,deltaTokens,bloatHit,bloatHits,
grewOverThreshold,turnIndex}`). `seq` = per-session monotonic counter from
`runtime.ts`; markers are ordered by `seq` (stable; ties impossible).

## 5. Tool execute contracts (spec/05, verified against ToolDefinition shape)
`execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>`.
Return shape: `{ content: [{type:"text", text:string}] }`. Bodies wrapped in
try/catch → on error, return a text result (never throw). The `toolCallId` arg
is passed into the rewind marker as `excludeToolCallId` (so the filter can skip
the rewind's own tool group when resolving `last_tool_call_group` — spec/06 §3).

## 6. References (authoritative; do not re-derive)
- Spec: `spec/01..12` (this project + sibling). Build order: `spec/11`.
- Pi `.d.ts` (authoritative for signatures):
  `…/pi-coding-agent/dist/core/extensions/types.d.ts` (ExtensionAPI, events,
  ToolDefinition), `…/dist/core/session-manager.d.ts` (ReadonlySessionManager),
  `…/dist/core/messages.d.ts` (CustomMessage etc.), `…/@earendil-works/pi-ai` +
  `pi-agent-core` (base Message union).
- Pi docs read during spike: `docs/{extensions,session-format,compaction,settings,packages}.md`.
- Pi examples (referenced in spec/12): `examples/extensions/{truncated-tool,
  send-user-message,trigger-compact,bookmark,custom-compaction}.ts` — all present.
- Proven spike harness: `spec/reference/looper-smoke.proto.ts` (precursor to the
  integration `test/integration/smoke.ts`).
- Reference implementation (read-only oracle): sibling `/home/dustin/projects/pi-mulligan/src` (see system_context.md §3).
