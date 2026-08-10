# Research Notes — P1.M4.T4.S1 — `mulligan_audit` execute()

## Work item
Implement the `mulligan_audit` tool's `execute()` in `src/tools/audit.ts` (currently a single-line
`export {};` stub): read `rt.lastFiltered` → estimateTokens per message → render the spec/05 §4 markdown
report. Read-only; persist NOTHING; never throw.

Dependencies: P1.M3.T2.S1 (filter.ts writes `rt.lastFiltered` ✅), P1.M2.T1.S1 (estimateTokens ✅),
P1.M1.T4.S1 (config ✅).

## 1. The stub + the structural template
- `src/tools/audit.ts` = `export {};` (one line). Sibling stubs checkpoint/audit were both `export {};`;
  checkpoint is now SHIPPED (P1.M4.T3). rewind.ts + shrink.ts + checkpoint.ts are the SHIPPED structural
  templates for the execute()/factory/defineTool/refusal/details idiom.
- `audit` is the SINGLE read-only exception in the tool set. It is ALSO the only tool that reads
  `rt.lastFiltered` and the only place that deliberately RE-RUNS `filterPipeline` (E16 fallback only).

## 2. CRITICAL DECISION — registration pattern: `export const auditTool` (NO `pi` factory)
The three sibling v1 tools use `makeXTool(pi)` factories because they WRITE (appendEntry/sendMessage/
setLabel). **Audit writes NOTHING** — every read goes through `ctx` (readMarkers, buildContextEntries,
getEntries, getBranch) or a pure helper (estimateTokens / runtime / getConfig). The proven oracle
(`/home/dustin/projects/pi-mulligan/src/tools/audit.ts`) deliberately chose a PLAIN `export const
auditTool` and documented it as "CRITICAL INSIGHT #1: the audit needs NO `pi` at all … There is no
`makeAuditTool(pi)` factory and no module-scoped `pi` — `auditTool` is a PLAIN `export const`."

**Decision for v1: use `export const auditTool: ToolDefinition<typeof AuditParams, AuditDetails>`** (plain
const, no factory). index.ts (P1.M7.T1.S1) will do `pi.registerTool(auditTool)` directly (no factory call).
Tests import `auditTool` and call `auditTool.execute(toolCallId, params, undefined, undefined, ctx)`
directly — NO fake `pi` needed (this SIMPLIFIES the test vs the sibling tools). Rationale: matches the
proven reference, is more honest (no unused param), and the work item's INPUT list omits `pi`.

## 3. Dependencies already SHIPPED (IMPORT — do NOT redefine)
- `src/tokens.ts` (P1.M2.T1): `estimateTokens(messages: MessageLike[] | null | undefined, _model?:
  unknown): TokenEstimate` where `TokenEstimate = { tokens: number; confidence: TokenConfidence }` and
  `TokenConfidence = "low" | "medium" | "high"` (default "medium"). For PER-MESSAGE tokens call
  `estimateTokens([msg])`. `resultBytes(content: ResultContentBlock[] | null | undefined): number` — UTF-8
  byte size of a content block array (text→byteLength, image→base64 len, else 0). Both NEVER throw.
  Also exports `MessageLike` (the Pi-free structural message type).
- `src/runtime.ts` (P1.M1.T2): `runtime(arg: string | { getSessionId(): string }): SessionRuntime`
  (get-or-create LIVE mutable obj keyed by sessionId). `SessionRuntime.lastFiltered: AgentMessage[] |
  null` (AgentMessage = `Record<string, unknown>` — runtime is Pi-free) — the FILTER'S cached output, the
  thing audit reads. Starts `null` until the first successful context fire (E16). Also `clearAll()` for
  tests. **NOTE: v1 exports `runtime(arg)`, NOT `getRuntime(sessionId)`** (the oracle evolved to
  `getRuntime`; v1 did not). Use `runtime(ctx.sessionManager)`.
- `src/filter.ts` (P1.M3.T2): `readMarkers(ctx): MarkersBundle` where `MarkersBundle = { rewinds:
  RewindMarker[], shrinks: ShrinkMarker[], metric: TurnMetric | null }`. Scans
  `ctx.sessionManager.getEntries()` FRESH (C12), buckets mulligan:rewind/mulligan:shrink/mulligan:turn-metric
  by (customType, kind), picks latest metric by highest seq. Checkpoints are LabelEntries (type "label")
  so readMarkers does NOT return them — audit scans them itself. `MarkersBundle` is structurally
  assignable to transforms.ts `MarkerBundle | undefined` (extra `metric` field is harmless for non-literal
  assignment). NEVER throws.
- `src/transforms.ts` (P1.M2.T6): `filterPipeline(messages: MessageLike[], markers: MarkerBundle |
  undefined, config: ProtectedConfig | undefined, branchEntries?: BranchEntry[]): MessageLike[]` —
  rewinds+shrinks ONLY (NO injectNudge — external_deps §3.1 seam). The E16 FALLBACK re-runs THIS so the
  audit reflects post-rewind/shrink reality. 4th arg is `branchEntries` DATA (`getBranch()`), NOT `ctx`.
- `src/config.ts` (P1.M1.T4): `getConfig(): MulliganConfig` (fresh structuredClone each call — read ONCE).
  Fields audit consumes: `.enabled` (master, E14 gate), `.audit.estimateConfidence` ("low"|"medium"|"high",
  default "medium" — the cached-path confidence label), `.nudges.bloatThresholdBytes` (default 8192 — the
  bloat flag threshold, in BYTES), `.rewind.protectedRoles` (default `["first:user","latest:user"]` —
  rendered on the "Protected:" line). `setConfig(undefined)` resets the cache to DEFAULT_CONFIG (tests).
- `src/log.ts`: `logError(event, sessionId, data?)` — only if logging is wanted; the oracle does NOT log
  inside audit (the catch path returns text). Optional.

## 4. Pi API surfaces (VERIFIED — Pi 0.84.1)
- `ctx.sessionManager.buildContextEntries(): SessionEntry[]` — active-branch entries with compaction
  applied (NOT the LLM message list). E16 fallback converts these to messages via Pi's canonical
  `sessionEntryToContextMessages(entry)` (re-exported from the pi package root — the SAME helper
  buildSessionContext uses, so the audit never invents a divergent conversion).
- `ctx.sessionManager.getEntries(): SessionEntry[]` — ALL entries (every branch); readMarkers + the
  checkpoint scan read this. `getBranch(): SessionEntry[]` — LEAF→ROOT order (filterPipeline wants root→leaf,
  so pass `getBranch()` and let filterPipeline consume it — it reverses internally OR the contextHandler
  pattern was `.slice().reverse()`; CONFIRMED: filterPipeline's checkpoint path walks branchEntries as
  root→leaf, and contextHandler passes `getBranch().slice().reverse()`. For audit's fallback, match
  contextHandler: `getBranch().slice().reverse()` cast to `BranchEntry[]`).
- `ctx.sessionManager.getSessionId(): string`.
- `sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[]` — each entry yields ≥0 messages;
  non-yielding entry types (compaction/branch_summary/label/custom) contribute nothing here (their effect
  is already baked into the buildContextEntries() list).
- `defineTool<TParams,TDetails,TState>(tool)` (types.d.ts:385) — preserves inference. `ToolDefinition<
  TParams, TDetails>`. `AgentToolResult<T> = { content: ContentBlock[]; details: T }` — `details` is
  REQUIRED (strict mode; the sibling tools all carry it on every path).
- NO `pi` surface is touched by audit (CRITICAL INSIGHT #1).

## 5. spec/05 §4 contract (VERBATIM — verified by reading spec/05-tools.md)
### Parameter schema
```ts
const AuditParams = Type.Object({
  top: Type.Optional(Type.Number({ description: "Report only the top N messages by token size. Default 8." })),
});
```
### Return shape
`{ content: [{ type:"text", text: <markdown report> }] }` (+ REQUIRED `details` — GOTCHA #4).
### Report format (the EXACT markdown to produce)
```md
## Mulligan audit — context you are currently carrying
Total (filtered): ~12,340 tokens  (estimate, confidence: medium)
Active markers: 1 rewind (last_tool_call_group), 0 shrink, 2 checkpoints [before-x, before-y]
Protected: will not rewind past system/first-user/latest-user.

Top messages by size:
  9,412  toolResult  read src/big.log           ⚠ above bloat threshold (8 KB)
  1,840  assistant   (thinking + toolCall x2)
    612  toolResult  grep "auth"
    ...

Suggestion: the `read src/big.log` result is the largest contributor. Consider mulligan_shrink.
```
### Behavior (5 steps)
1. Build the FILTERED message list: PRIMARY `rt.lastFiltered` (if a non-null array — the filter cached it);
   E16 FALLBACK (rt.lastFiltered is null — audit called before any inference, possible as a first action in
   print mode) → `buildContextEntries().flatMap(sessionEntryToContextMessages)` then re-run `filterPipeline`
   so the report reflects post-rewind/shrink reality; flag confidence "low" in that case.
2. `estimateTokens` per message; sort desc; take `top` (default 8). The TOTAL is over ALL filtered messages
   (`estimateTokens(filtered).tokens`); only the "Top messages" block is truncated to `top`.
3. Read active markers (readMarkers) + checkpoints (scanned from getEntries()).
4. Render the report. Suggestion heuristic: any message whose in-context BYTES exceed
   `config.nudges.bloatThresholdBytes` is flagged ⚠; the single largest message is named in the Suggestion.
5. Return. **Persist NOTHING** (no `pi.*` calls).
### spec/05 §5 Description (VERBATIM)
`"Show a token breakdown of the context you're currently carrying (what the model actually sees), flag the biggest contributors, and list active Mulligan markers. Use this to decide whether to rewind or shrink."`

## 6. D5 (the load-bearing correctness invariant)
spec/06 §7 + the work item RESEARCH NOTE: the audit MUST compute tokens from `rt.lastFiltered` (the filtered
view — what the model actually sees), NOT `ctx.getContextUsage()` (which still counts hidden/rewound
messages — bookkeeping drift). Reporting the raw count would mislead the agent into thinking a rewind "didn't
work." The audit's whole value is honesty about what the model sees. **NEVER call `ctx.getContextUsage()` for
the total.** (The oracle's `computeFilteredTotal` reads `.contextWindow` for a SEPARATE rewind stop-guard —
that is P4 and OUT of v1 scope; v1 audit does not touch getContextUsage at all.)

## 7. Edge cases (spec/08)
- **E13**: never throw — whole body in ONE try/catch; any exception → failure text +
  `details:{...,error:reason}`. The catch-path details MUST still satisfy the AuditDetails shape (all counts
  0, top [], confidence "low", source "fallback").
- **E14**: master `config.enabled === false` → refuse "Mulligan: refused — Mulligan is disabled." BEFORE any
  session access. Reason: when disabled the context handler is pass-through → the model sees the UNFILTERED
  view → running filterPipeline here would report a TRANSFORMED view the model does NOT see (D5 violation).
  No `config.audit.enabled` sub-gate exists (gate on master only, like the siblings).
- **E16**: rt.lastFiltered is null (audit called before any inference) → fallback path; confidence "low"; still
  useful; never crashes.
- **E12**: getContextUsage undefined — N/A; v1 audit does not call it.

## 8. v1 vs oracle divergences (OMIT these P3/P4 features — out of v1 scope)
The oracle's audit.ts (~600 LOC) evolved. v1 OMITS:
- `computeFilteredTotal` + the rewind context-fraction stop-guard (P4.M1.T2.S2) — v1 has no rewind stop-guard.
- `markers.cancelledIds` / `nCancelled` / `cancelledCount` (P3.M1.T4.S1 retired-marker retraction) — v1
  MarkersBundle = `{rewinds, shrinks, metric}` (NO cancelledIds). The "Active markers" line renders rewinds +
  shrinks + checkpoints ONLY (no ", N cancelled (retired)" clause).
- `bloatThresholdFor` (per-tool bloat threshold, imported from nudges.js in the oracle) — v1 nudges.ts does NOT
  export it. **v1 uses the single global `config.nudges.bloatThresholdBytes`** for ALL messages (confirmed by
  v1 nudges.ts bloatReminderHandler comment: "Per-tool thresholds are a known future enhancement (NOT v1)").
  The AuditRow carries `thresholdBytes` = `config.nudges.bloatThresholdBytes` (one value for every row), and
  the ⚠ flag renders `Math.round(thresholdBytes/1024)` KB.
- `getRuntime(sessionId)` — v1 exports `runtime(arg)` (get-or-create). Use `runtime(ctx.sessionManager)`.

## 9. Test idiom (test/tools/{rewind,shrink,checkpoint}.test.ts — VERIFIED)
- vitest: `{describe, it, expect, expectTypeOf, beforeEach, afterEach}`.
- `beforeEach`/`afterEach`: `clearAll()` (runtime.js) + `setConfig(undefined)` (config.js) — resets shared
  module-scoped runtime map + config cache.
- Hand-rolled fakes (NO `vi.fn`): `makeCtx(opts)` exposes a `sessionManager` fake with
  `getSessionId`/`getEntries`/`getBranch`/`buildContextEntries`. **Audit needs NO `makePi`** (it never writes)
  — this is the key test simplification. Tests that exercise the CACHED path must FIRST seed
  `runtime(ctx.sessionManager).lastFiltered = [...]` (the live mutable object) to simulate a filter fire.
- For the FALLBACK path, `makeCtx({ contextEntries })` returns SessionEntry[] that
  `sessionEntryToContextMessages` converts — but in a unit test we can SHORTCUT: seed
  `rt.lastFiltered = null` AND make `buildContextEntries` return entries whose `sessionEntryToContextMessages`
  yields the messages. Simplest: since audit calls `buildContextEntries().flatMap(sessionEntryToContextMessages)`,
  provide entries shaped as `{type:"message", message:{role,content}}` (sessionEntryToContextMessages maps
  `message` entries to their `.message`).
- `run(ctx, params)` helper: `auditTool.execute("call-1", params ?? {}, undefined, undefined, ctx)`.
  `firstText(res)` extracts `res.content[0].text`.

## 10. DOCS impact
Mode A: tool description from spec/05 §5 — the `AUDIT_DESC` string IS the LLM-facing doc, copied VERBATIM
into `src/tools/audit.ts`. No separate doc file is touched by this task.

## 11. Out of scope (hard boundaries)
- Do NOT modify `src/index.ts` (wiring = P1.M7.T1.S1).
- Do NOT modify tokens.ts/runtime.ts/filter.ts/transforms.ts/config.ts/markers.ts (all SHIPPED).
- Do NOT call `pi.*` (appendEntry/sendMessage/setLabel) — audit PERSISTS NOTHING.
- Do NOT call `ctx.getContextUsage()` (D5 violation).
- Do NOT add `config.audit.enabled` sub-gate (none exists; gate on master only).
- Do NOT add per-tool bloat thresholds / cancelledIds / computeFilteredTotal (P3/P4 — out of v1).
- Do NOT inject nudges in the fallback (filterPipeline handles rewinds+shrinks only; nudges are the
  contextHandler's job, not the audit's — the audit is a SNAPSHOT, not a transform site).
