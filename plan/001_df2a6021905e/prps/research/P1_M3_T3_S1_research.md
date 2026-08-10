# Research Notes — P1.M3.T3.S1 (nudges.ts: Nudge A + turn_end metric + shouldNudge/injectNudge/suppressCheck)

## Task (one sentence)
Replace the `export {};` stub in `src/nudges.ts` with: (A) the `tool_result` bloat-reminder handler,
(B-phase1) the `turn_end` turn-metric handler, and (B-phase2) the PURE `shouldNudge` + `injectNudge` +
`suppressCheck` helpers; EXTEND `src/filter.ts`'s `contextHandler` to call them after `filterPipeline`;
ADD `pendingBloatHits` to `SessionRuntime` (`src/runtime.ts`); ship 3 vitest suites + update runtime.test.ts.

## Dependencies (all verified Complete + present in THIS repo)
- **P1.M2.T1.S1** → `src/tokens.ts` (DONE). Exports: `resultBytes(content: ResultContentBlock[]): number`
  (UTF-8 BYTE length — multibyte-aware), `approxTokens(bytes): number` (`Math.ceil(bytes/CHARS_PER_TOKEN)`,
  `approxTokens(8192)=2048`), `estimateTokens(messages): {tokens,confidence}`, `CHARS_PER_TOKEN=4`,
  `ResultContentBlock` (indexed, BROADER than Pi's `TextContent|ImageContent` → cast through `unknown`).
- **P1.M2.T3.S1** → `src/notes.ts` (DONE). Exports: `renderBloatReminder(_toolName, bytes, thresholdBytes): string`
  (`_toolName` ACCEPTED but NOT interpolated in v1 — reserved; returns `\n---\n` + 4-line body; bad numbers→0 KB),
  `renderDriftNudge(metric: DriftNudgeInput): string` (3 lines; first line varies by delta!=null × bloat non-empty;
  deltaTokens===null → delta clause DROPPED, NOT "~0k"), `DriftNudgeInput{deltaTokens:number|null; bloatHits:ReadonlyArray<{toolName,approxTokens}>}`.
  NOTE: these renderers are ALREADY fully unit-tested in test/notes.test.ts — DO NOT re-test them here.
- **P1.M3.T1.S1** → `src/markers.ts` (DONE). Exports: `appendTurnMetric(pi, ctx, data: TurnMetricInput): string|null`
  (stamps envelope+seq+ts, NO id — TurnMetric has no id; never throws, returns null on failure),
  `TurnMetric`, `TurnMetricInput = Omit<TurnMetric,"schema"|"v"|"kind"|"seq"|"ts">` = the 5 data fields
  `{deltaTokens, bloatHit, bloatHits, grewOverThreshold, turnIndex}`.
- **P1.M3.T2.S1** → `src/filter.ts` (DONE — THIS TASK EXTENDS IT). Exports `MarkersBundle{rewinds,shrinks,metric:TurnMetric|null}`,
  `readMarkers(ctx)`, `contextHandler(event,ctx)`. Current `contextHandler`: getConfig().enabled gate →
  runtime(ctx.sessionManager) → readMarkers → branchEntries=getBranch().slice().reverse() →
  `filterPipeline(messages,markers,config,branchEntries)` → cache `rt.lastFiltered`+`lastFilterTs` → return `{messages}`.
  **NO nudge injection yet** (metric read but unused). THIS TASK inserts the injection BETWEEN filterPipeline and the cache write.
- **P1.M1.T2.S1** → `src/config.ts` (DONE). `MulliganConfig.nudges = {bloatReminder:boolean, perTurnDrift:boolean,
  bloatThresholdBytes:number(8192 BYTES), driftThresholdTokens:number(3000 TOKENS)}`. NO driftWindowTurns, NO highWaterFraction
  (those are oracle P3/P4 — OMIT). `getConfig()` returns a fresh clone each call.
- **P1.M1.T4.S1** → `src/runtime.ts` (DONE — THIS TASK ADDS A FIELD). `SessionRuntime{sessionId, seq, tokenBaseline,
  lastTurnIndex, lastFiltered, lastFilterTs}`. Exports `runtime(arg)` (NOT `getRuntime` — naming diff from oracle!),
  `nextSeq(rt)`, `clearAll()`, `resetRuntime()`, `AgentMessage = Record<string,unknown>`. **`pendingBloatHits` is ABSENT**
  — test/runtime.test.ts:55 EXPLICITLY asserts `expect(rt).not.toHaveProperty("pendingBloatHits")` + `Object.keys(rt)).toHaveLength(6)`.
  THIS TASK must ADD `pendingBloatHits: {toolName:string; approxTokens:number}[]` to the interface, init `[]` in freshRuntime,
  and UPDATE that test (6 → 7 keys; flip the `.not.toHaveProperty` assertion).

## Oracle (read-only sibling — architecture/system_context.md §3 designates it THE reference)
`/home/dustin/projects/pi-mulligan/src/nudges.ts` (33 KB, COMPLETE passing impl). Captured this session.
**v1 DEVIATIONS from oracle** (per task contract + system_context §7):
1. **NO `bloatThresholdFor(toolName, config)`** (oracle line 92 = per-tool thresholds). v1 uses the SINGLE
   `config.nudges.bloatThresholdBytes` verbatim. (system_context.md §7: per-tool is a documented future enhancement,
   NOT v1 — note in code as a TODO/Future comment where the threshold is read.)
2. **`shouldNudge(metric, config)` takes a SINGLE TurnMetric** (oracle line 324 takes `recentMetrics: TurnMetric[]`
   + windowed moving-average — that's P3.M3.T3.S1 driftWindowTurns). v1 = `metric.grewOverThreshold || metric.bloatHit`
   (boolean OR; both arms retained per task contract item 1).
3. **NO high-water nudge** (`shouldHighWater`/`renderHighWaterNudge`/`injectHighWaterNudge` — oracle lines 443-540).
   OMIT entirely.
4. **NO `mulligan:cancel`/recentMetrics/RewindDiag/rewindRefusedTurnIndex** — all oracle P3/P4. OMIT.
5. `suppressCheck` + `injectNudge` + `NUDGE_TURN_WINDOW_MS` + `bloatReminderHandler` + `turnEndMetricHandler` +
   `registerBloatReminder`/`registerTurnEndMetric` — REUSE oracle verbatim (they are v1-clean).

## Oracle exports to reproduce (verified via grep, v1-compatible subset)
```
NUDGE_TURN_WINDOW_MS = 10 * 60 * 1000          // exported const; suppress window (spec/07 §2 "Simple heuristic")
shouldNudge(metric, config): boolean            // PURE: metric.grewOverThreshold || metric.bloatHit  [v1 SIMPLIFIED]
suppressCheck(metric, markers): boolean         // PURE: some marker.ts ∈ (metric.ts − WINDOW, metric.ts]
injectNudge(messages: MessageLike[], metric): MessageLike[]   // PURE: [...messages, ephemeral mulligan:nudge]
bloatReminderHandler(event: ToolResultEvent, ctx): {content?} | void   // Nudge A; reads config+threshold; pushes rt.pendingBloatHits
turnEndMetricHandler(pi, event: TurnEndEvent, ctx): void              // Nudge B Phase 1; appendTurnMetric; roll baseline; clear pendingBloatHits
registerBloatReminder(pi): void     // pi.on("tool_result", bloatReminderHandler)  — CALLED BY P1.M5.T1, not this task
registerTurnEndMetric(pi): void     // closure captures pi; pi.on("turn_end", (e,ctx)=>turnEndMetricHandler(pi,e,ctx)) — P1.M5.T1
```
Module-private (mirror tokens.ts/notes.ts — each pure module keeps its own copy): `isRecord`, `readOwn`.

## Pi event shapes (VERIFIED against dist/core/extensions/types.d.ts lines 555-740, 795, 887-897)
- **`TurnEndEvent`** = `{ type:"turn_end"; turnIndex:number; message:AgentMessage; toolResults:ToolResultMessage[] }`.
  **NO `messages` array** → `deltaTokens` MUST use the in-memory `rt.tokenBaseline` (P1.M1.T4) + `rt.lastFiltered`
  / `ctx.getContextUsage()?.tokens ?? 0`. This is the load-bearing reason for the baseline. (task contract item 1.)
- **`ToolResultEvent`** = per-tool discriminated UNION (`Bash|Read|Edit|Write|Grep|Find|Ls|Custom` ToolResultEvent),
  all extend `ToolResultEventBase{ type:"tool_result"; toolCallId; input; content:(TextContent|ImageContent)[];
  isError:boolean; usage? }` + narrowed `toolName` (literal for built-ins, `string` for Custom). Reading
  `event.content` + `event.toolName` is SAFE on the base (task contract item 1). `event.toolName.startsWith("mulligan_")`
  typechecks because the union includes CustomToolResultEvent whose toolName is `string` — but TS narrows per-literal;
  use a runtime guard: `const tn = event.toolName; if (tn.startsWith("mulligan_")) return;` (the comparison widens to string).
- **`ToolResultEventResult`** = `{ content?; details?; isError?; usage? }` → return `{ content }` (the appended-content array).
- **ALL of `ToolResultEvent`, `TurnEndEvent`, `ExtensionContext`, `ExtensionAPI`, `ContextEvent` are re-exported from
  package root `@earendil-works/pi-coding-agent`** (verified dist/index.d.ts line 7). Import directly: `import type {
  ToolResultEvent, TurnEndEvent, ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";`
- **`TextContent|ImageContent` are NOT re-exported from package root** → for the appended block type use the indexed-access
  `ToolResultEvent["content"][number]` (oracle GOTCHA #2). Define a local alias `type ToolResultContentBlock = ToolResultEvent["content"][number]`.

## KEY GOTCHAS (from oracle, load-bearing — implementer MUST honor)
1. **`recordBloatHit` is PSEUDOCODE** (spec/07 §1). "Record a bloat hit" = INLINE `rt.pendingBloatHits.push({toolName, approxTokens: approxTokens(bytes)})`.
   Do NOT clear pendingBloatHits here — it accumulates across the turn and is read+cleared by turn_end.
2. **APPEND, never replace** the result content (spec/07 §1): `content = [...event.content, {type:"text", text: reminder}]`.
   The agent may need the data NOW; the hint is about FUTURE turns.
3. **BOTH config gates short-circuit BEFORE any measurement/recording** (oracle GOTCHA #8):
   `if (!config.enabled || !config.nudges.bloatReminder) return;` FIRST in bloatReminderHandler;
   `if (!config.enabled || !config.nudges.perTurnDrift) return;` FIRST in turnEndMetricHandler. Else Nudge B could
   fire on bloat when Nudge A is off (cross-contamination).
4. **`turnEndMetricHandler` needs `pi`** (for appendTurnMetric) but the `turn_end` callback only gets `(event, ctx)`.
   → the register helper CLOSES OVER `pi`: `pi.on("turn_end", (event, ctx) => turnEndMetricHandler(pi, event, ctx))`.
5. **`appendTurnMetric` stamps seq** (it calls nextSeq internally) — the handler must NOT call nextSeq or add `seq`
   to the TurnMetricInput (double-increment). Build ONLY the 5 data fields.
6. **`now` uses the FILTERED view (D5)**: `rt.lastFiltered ? estimateTokens(rt.lastFiltered).tokens : (ctx.getContextUsage()?.tokens ?? 0)`.
   `rt.lastFiltered` is `AgentMessage[]` (= `Record<string,unknown>[]`) — structurally assignable to estimateTokens'
   `MessageLike[]` with NO cast (verified by tsc in the oracle).
7. **bloat snapshot+clear pattern**: `const bloat = rt.pendingBloatHits; rt.pendingBloatHits = [];` — grab the OLD
   array reference (frozen snapshot for the metric), then REASSIGN to a fresh `[]` for next turn. NOT `.length = 0`
   (that would mutate the snapshot we just stored).
8. **fail-open on EVERY handler** (spec/03 #4, spec/08 E13): try/catch; log via `logError("nudge.bloat"|"nudge.turn_end", sessionId, {error})`;
   return nothing on error. `sessionId` captured FIRST (so the catch can log it) — `logError` takes a STRING, not ctx.
9. **`suppressCheck` uses a wall-clock window** (spec/07 §2 "Simple heuristic") NOT a pure upper bound: at fire time
   the latest metric + ALL markers both have `ts <= metric.ts` (no future markers), so `ts <= metric.ts` alone
   OVER-SUPPRESSES (one rewind ever → nudge never fires again). Window = `(metric.ts − NUDGE_TURN_WINDOW_MS, metric.ts]`.
10. **`suppressCheck` takes a STRUCTURAL markers param** `{rewinds:ReadonlyArray<RewindMarker>; shrinks:ReadonlyArray<ShrinkMarker>}`
    (NOT the full MarkersBundle) → filter.ts's MarkersBundle is structurally assignable (extra `metric` ignored),
    and nudges.ts does NOT import from filter.ts (no cycle). Call site: `suppressCheck(markers.metric, markers)`.
11. **`injectNudge` takes `MessageLike[]`** (from transforms.ts), NOT `AgentMessage[]` — the filter.ts call site is
    `messages = injectNudge(messages, markers.metric)` where `messages` is filterPipeline's `MessageLike[]` return;
    the cast to Pi AgentMessage[] happens only at contextHandler's RETURN boundary. The nudge object literal assigns
    to `MessageLike` with NO cast (MessageLike has an index signature). NEVER calls `pi.sendMessage` (ephemeral).
12. **filter.ts injection ORDER** (spec/06 §1 pseudocode, external_deps §3.1 seam): `messages = filterPipeline(...)`
    → (if `config.nudges.perTurnDrift && metric && shouldNudge(metric,config) && !suppressCheck(metric,markers)`)
    `messages = injectNudge(messages, metric)` → `rt.lastFiltered = messages` → return. The nudge IS cached in
    lastFiltered (honest — audit reports what the model sees, including the ~30-token nudge; turn-metric delta
    includes it — negligible, acceptable, advisory subsystem).
13. **naming**: oracle calls the runtime getter `getRuntime(sessionId)`; THIS repo's runtime.ts exports **`runtime(arg)`**.
    Use `const rt = runtime(ctx.sessionManager);` (the ExtensionContext's sessionManager satisfies `{getSessionId():string}`),
    OR `runtime(sessionId)` after capturing sessionId. Do NOT invent `getRuntime`.

## Spec contracts (verified verbatim against spec/07 this session)
- **spec/07 §1 (Nudge A)**: gates `!enabled||!bloatReminder`→return; skip `mulligan_*`; `bytes=resultBytes(content)`;
  `bytes<bloatThresholdBytes`→return; APPEND `renderBloatReminder(toolName,bytes,threshold)`; record into pendingBloatHits;
  return `{content}`; fail-open. **bloatThresholdBytes is BYTES** (not tokens).
- **spec/07 §2 (Nudge B)**: turn_end computes `now`/`delta`/bloat; builds metric `{deltaTokens, bloatHit, bloatHits,
  grewOverThreshold: delta!=null && delta>driftThresholdTokens, turnIndex}`; `appendTurnMetric`; `rt.tokenBaseline=now`;
  `rt.lastTurnIndex=event.turnIndex`; fail-open. **driftThresholdTokens is TOKENS.** Phase2 filter: `shouldNudge`=
  `grewOverThreshold||bloatHit`, suppress if marker created during the turn; `injectNudge` = append inline
  `{role:"custom",customType:"mulligan:nudge",content:renderDriftNudge(metric),display:false,details:{ephemeral:true,turnIndex},timestamp:Date.now()}`
  — NOT persisted. **D4 (zero extra requests)** is the central constraint — both nudges ride events that fire anyway.
- **spec/07 §2 edge**: suppress avoids nagging after the agent already acted (rewind/shrink during the metric's turn).

## Test conventions (from test/filter.test.ts + test/markers.test.ts — VITEST GLOBALS, mirror them)
- `import { describe, it, expect, beforeEach, afterEach } from "vitest";`
- `beforeEach(() => { clearAll(); setLogFile(null); }); afterEach(() => { clearAll(); setLogFile(null); setConfig(undefined); });`
- fake-ctx builder `makeCtx({sessionId, entries, branch, throwOnGetEntries, throwOnGetBranch, throwOnGetSessionId})` returning
  `ExtensionContext` via `as unknown as ExtensionContext` (sessionManager stub with getSessionId/getEntries/getBranch/getLeafId).
- fake-pi builder capturing `appendEntry`/`sendMessage`/`setLabel` calls into arrays (for assert "nudge NEVER persisted" =
  assert `pi.sendMessage` was NOT called with customType `mulligan:nudge`).
- entry builders: `metricEntry({seq, deltaTokens, bloatHit, bloatHits, grewOverThreshold, turnIndex, ts})`,
  `rewindEntry({seq, ts, ...})`, `shrinkEntry({seq, ts, ...})`.
- Test import path: `from "../src/nudges.js"` (.js MANDATORY — moduleResolution Bundler resolves to .ts).
- `import type { ExtensionContext, ToolResultEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";`
- `expectTypeOf` available (tsconfig types include "vitest/globals") for shape assertions.

## F-scenario determinism (task contract items 5/6 — the FULL `pi -p` smoke is owned by P1.M5.T3.S1; THIS task
   asserts the observables at the handler/filter level with fakes, which is deterministic + model-free)
- **F-shrink-preventive** (>8KB result annotated; turn-metric bloatHit:true): drive `bloatReminderHandler` with a
  fake `ToolResultEvent` whose content is >8192 bytes → assert returned `{content}` has the appended `[mulligan]` block
  AND `rt.pendingBloatHits` has one entry; then drive `turnEndMetricHandler` → assert `appendTurnMetric` was called
  with a metric whose `bloatHit===true` + `bloatHits.length===1`.
- **F-nudge-drift** (>3k-token turn → next context.fire ends with mulligan:nudge; ZERO persisted): drive
  `contextHandler` with a metricEntry (`grewOverThreshold:true`) → assert the RETURNED messages end with a
  `customType:"mulligan:nudge"` message; assert the fake-pi's `sendMessage` was NEVER called with `mulligan:nudge`
  (ephemeral — copy-only). Then with a rewindEntry whose `ts` is inside the window → assert NO nudge appended (suppress).

## Scope boundaries (CRITICAL — do NOT cross; siblings own these)
- **index.ts wiring** (`pi.on("tool_result",...)`, `pi.on("turn_end",...)`, calling `register*`) → **P1.M5.T1.S1**.
  THIS task EXPORTS `registerBloatReminder`/`registerTurnEndMetric` + raw handlers but does NOT touch index.ts.
- **Full `pi -p` model-driven smoke harness + the 9 F-* scenarios** → **P1.M5.T3.S1**. THIS task's "integration smoke"
  = the deterministic handler/filter-level assertions above (test/turn_metric.test.ts + test/drift_nudge.test.ts).
- **renderBloatReminder / renderDriftNudge** already tested in test/notes.test.ts (P1.M2.T3) — DO NOT re-test here.
- **per-tool bloat thresholds, windowed drift (driftWindowTurns), high-water nudge, mulligan:cancel** → oracle P3/P4, OMIT.
  Note the per-tool-threshold future enhancement in a code comment where `config.nudges.bloatThresholdBytes` is read (DOCS, item 7).

## DOCS impact
Mode B (changeset-level). No per-item doc file. The ONLY docs touch is a code comment noting per-tool-bloat-threshold
as a known future enhancement (task contract item 7 / system_context.md §7). The whole-feature README is P1.M5.T4.S1.

## Gates (verified executable in THIS tree — vitest 1.6.1 + typescript ^5 in node_modules, run WITHOUT `npm install`)
- L1 typecheck: `npx tsc --noEmit`
- L2 new suites: `npx vitest run test/nudges.test.ts test/turn_metric.test.ts test/drift_nudge.test.ts`
- L3 full regression (catches runtime.test.ts + filter.test.ts edits): `npx vitest run`
- L4 manual (real pi -p smoke deferred to P1.M5.T3.S1): F-shrink-preventive + F-nudge-drift + zero-persistence + fail-open.

## Confidence: 10/10
Fully deterministic contract (spec/07 pinned) + a verified passing reference impl (oracle nudges.ts, captured) +
all 3 type/value deps Complete + the filter.ts extension is a 6-line insertion at a known seam + green baseline.
The one mutation beyond nudges.ts (runtime.ts +pendingBloatHits + its test) is mechanical and explicitly anticipated
by test/runtime.test.ts:55 ("out of scope — P1.M3.T3"). No inference required.
