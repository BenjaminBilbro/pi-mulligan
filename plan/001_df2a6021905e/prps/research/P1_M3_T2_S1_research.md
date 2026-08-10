# Research Notes — P1.M3.T2.S1 (filter.ts — context handler glue)

Task: context handler glue — read markers → filterPipeline → cache lastFiltered → fail-open
Dependencies: P1.M2.T6.S1 (filterPipeline ✅), P1.M3.T1.S1 (markers.ts types ✅), P1.M1.T2.S1 (config ✅).

## 1. What already ships (DO NOT redefine — IMPORT)
- `src/config.ts`: `getConfig(): MulliganConfig` (defensive clone each call; `.enabled` master switch).
  `setConfig(raw)` for tests to force-disable. `MulliganConfig` has `.enabled`, `.rewind.protectedRoles`, etc.
- `src/runtime.ts`: `runtime(arg: string | {getSessionId():string}): SessionRuntime` (get-or-create live mutable obj),
  `nextSeq(rt)`, `clearAll()`. `SessionRuntime{sessionId,seq,tokenBaseline,lastTurnIndex,lastFiltered,lastFilterTs}`.
  **`lastFiltered: AgentMessage[] | null`** (AgentMessage = `Record<string,unknown>` — runtime is Pi-free) + **`lastFilterTs: number | null`** —
  the audit cache MY handler writes. `lastFiltered`/`lastFilterTs` start null until the first successful fire.
- `src/log.ts`: `logError(event, sessionId, data?)` (+ log/logInfo/logWarn/logDebug). OFF by default (`setLogFile(null)`).
- `src/markers.ts` (P1.M3.T1 — TYPES I consume, not the wrappers): `RewindMarker`, `ShrinkMarker`, `TurnMetric`
  (the persisted shapes living inside `entry.data`). Each carries `{schema:"pi-mulligan",v:1,kind,seq,ts,...}`.
  Rewind: +id,granularity,options,excludeToolCallId,checkpoint?,note,ledger. Shrink: +id,target,replacement,reason?.
  TurnMetric: +deltaTokens(number|null),bloatHit,bloatHits,grewOverThreshold,turnIndex (NO id).
- `src/transforms.ts` (P1.M2.T6 — PURE, zero-import): `filterPipeline(messages, markers:MarkerBundle|undefined,
  config:ProtectedConfig|undefined, branchEntries?:BranchEntry[]): MessageLike[]`. Rewinds+shrinks ONLY (NO injectNudge —
  external_deps §3.1 seam). Also exports: `MessageLike`, `BranchEntry`, `MarkerBundle{rewinds,shrinks}`,
  `ProtectedConfig{rewind:{protectedRoles}}`, `stableSortBySeq`, `protectedOk`.
- src→src import convention = `.js` extension (markers.ts: `import {...} from "./runtime.js"`).

## 2. Pi API signatures (VERIFIED against node_modules .d.ts — Pi 0.84.1)
- `pi.on("context", handler: ExtensionHandler<ContextEvent, ContextEventResult>)` (types.d.ts:878).
  `ExtensionHandler<E,R> = (event:E, ctx:ExtensionContext) => Promise<R|void> | R | void` (types.d.ts:862).
- `ContextEvent = { type:"context"; messages: AgentMessage[] }` (types.d.ts:500). `event.messages` = DEEP COPY, safe to mutate/replace.
- `ContextEventResult = { messages?: AgentMessage[] }` (types.d.ts:774). Return `{messages}` → transform; return `void`/`undefined` → pass-through (C4).
- `ReadonlySessionManager` (session-manager.d.ts:140) includes:
  - `getEntries(): SessionEntry[]` — ALL entries (every branch), shallow copy. NOT just current branch.
  - `getBranch(fromId?): SessionEntry[]` — **LEAF→ROOT order** ("Walk from entry to root, returning all entries in path order"). session-manager.d.ts:261.
  - `getSessionId(): string`.
- `CustomEntry<T> = { type:"custom"; customType:string; data?:T; id; parentId; timestamp }` (session-manager.d.ts:69). `type:"custom"` = NOT in LLM context.
- `LabelEntry = { type:"label"; targetId:string; label:string|undefined; ... }` (session-manager.d.ts:75). Checkpoints.
- Root re-export: `ContextEvent` IS re-exported from package root (index.d.ts:7). `AgentMessage` is NOT —
  DERIVE it: `type ContextMessage = NonNullable<ContextEvent["messages"]>[number]` (oracle pattern; structurally == AgentMessage).
- Pi docs `docs/extensions.md` §context (line 648): "Fired before each LLM call. Modify messages non-destructively.
  `event.messages` - deep copy, safe to modify. `return { messages: filtered };`"

## 3. CRITICAL divergences from the sibling oracle (/home/dustin/projects/pi-mulligan — READ-ONLY)
The oracle's filter.ts (253 LOC) EVOLVED with P3/P4 features. **OBEY THIS TASK'S CONTRACT, not the oracle.**
OMIT (out of v1 scope — later phases):
- `appendCancelMarker` + `CancelMarker` + `cancelledIds` (P3.M1.T2 / E21 marker retraction).
- `recentMetrics` array + windowed drift (P3.M3.T3 / spec/07 §5.1). v1 uses single `metric` (latest).
- `injectNudge` / `shouldNudge` / `suppressCheck` call (P1.M3.T3 — nudge injection is EXPLICITLY deferred per the work item).
- `injectHighWaterNudge` / `shouldHighWater` (spec/07 §5.2 high-water — P3/P4).
- `RewindDiag[]` + the `filter.invariant` tail-touch observability log (bug-instrumentation, P3.M2).
- `resolvePinnedShrink` + pinned-shrink stale retirement (P3.M2.T3 / E15).
- `rt.rewindRefusedTurnIndex` flag (P4.M1.T2.S3).
- `getRuntime(sessionId)` import — MY runtime.ts exports `runtime(arg)` (get-or-create), NOT `getRuntime`. Use `runtime(ctx.sessionManager)`.
- oracle `contextHandler(pi, event, ctx)` takes `pi` FIRST (for appendCancelMarker). MY v1 handler does NOT need pi
  (no cancel/nudge writes) → signature is `contextHandler(event, ctx)` (directly registerable + testable).

## 4. v1 contract (AUTHORITATIVE — from work item + spec/06 §1)
- `readMarkers(ctx): MarkersBundle` — scan `ctx.sessionManager.getEntries()` FRESH (C12). For each entry: skip unless
  `isRecord && type==="custom" && customType is a string starting "mulligan:"`. Read `data` (isRecord guard). Bucket by
  (customType, data.kind): `mulligan:rewind`+`rewind` → rewinds[]; `mulligan:shrink`+`shrink` → shrinks[];
  `mulligan:turn-metric`+`turn-metric` → metric candidates. `metric` = the turn-metric with the HIGHEST `seq`
  (latest; null when none; defensive on missing/non-number seq → -Infinity). Notes (custom_message) + checkpoints
  (label) are EXCLUDED by the `type==="custom"` filter. NEVER throws: malformed/unknown entries SKIPPED;
  `getEntries()` throwing → return empty bundle `{rewinds:[],shrinks:[],metric:null}` (fail-open at marker level, E13).
- `MarkersBundle = { rewinds: RewindMarker[]; shrinks: ShrinkMarker[]; metric: TurnMetric | null }`.
  Structurally assignable to filterPipeline's `MarkerBundle{rewinds,shrinks}` (extra `metric` field is fine).
- `contextHandler(event: ContextEvent, ctx: ExtensionContext): ContextEventResult | void`:
  `let sessionId="unknown"; try { sessionId = ctx.sessionManager.getSessionId(); const config = getConfig();
  if (!config.enabled) return; const rt = runtime(ctx.sessionManager); const markers = readMarkers(ctx);
  const branchEntries = ctx.sessionManager.getBranch().slice().reverse(); /* leaf→root → ROOT→LEAF */
  const messages = filterPipeline(event.messages, markers, config, branchEntries);
  rt.lastFiltered = messages; rt.lastFilterTs = Date.now(); return { messages };
  } catch (e) { logError("filter.fire", sessionId, {error: e instanceof Error ? e.message : String(e)}); return; }`
  — FAIL-OPEN pass-through (E13). `metric` is READ (stable bundle shape) but NOT consumed in v1 (nudge deferred to M3.T3).

## 5. THE load-bearing gotchas (each will sink one-pass if missed)
1. **branchEntries ordering (BUG magnet):** `resolveCheckpoint` (transforms.ts) expects `branchEntries` in **ROOT→LEAF**
   order (it scans from the END / leaf→root to find the most-recent label, and walks ctxEntries root→leaf advancing
   msgCursor). `getBranch()` returns **LEAF→ROOT**. → filter.ts MUST pass `getBranch().slice().reverse()`.
   VERIFIED via test/pipeline.test.ts:364 (branch array is [e1,e2,eL,e3,e4] = root→leaf; label at index 2 targets e2).
2. **Contract pseudocode vs built signature:** work item writes `filterPipeline(event.messages, markers, config, ctx)`
   but the BUILT (P1.M2.T6) filterPipeline is Pi-free and takes `branchEntries?: BranchEntry[]` as the 4th param
   (NOT ctx). filter.ts extracts branchEntries from ctx. This reconciliation is the seam — document it for the coder.
3. **Disabled → NO cache write:** `if (!config.enabled) return;` runs BEFORE `rt.lastFiltered=` so a disabled extension
   does NOT pollute the audit cache (oracle comment: "do NOT pollute the audit cache"). Pass-through = return undefined.
4. **Fail-open does NOT cache:** on catch, return undefined; do NOT set lastFiltered (leave prior value/null). The model
   gets the original messages; audit sees a stale/null cache (acceptable — fail-open is about never breaking the turn).
5. **OMIT all oracle P3/P4 features** (§3 above). readMarkers returns `{rewinds,shrinks,metric}` — nothing else.
6. **C12 (never cache a handle):** call `getEntries()`/`getBranch()`/`getSessionId()` INSIDE the handler each fire.
   Capture only primitive returns. Never store `ctx` or `ctx.sessionManager` on the runtime.
7. **sessionId captured FIRST in try:** so the catch block can log the session. Mirrors markers.ts + oracle pattern.
8. **type for messages return:** filterPipeline returns `MessageLike[]` (transforms.ts's Pi-free type).
   `MessageLike[]` is assignable to runtime's opaque `AgentMessage[]` (`Record<string,unknown>[]`) — no cast needed
   for `rt.lastFiltered = messages`. For the `{ messages }` return, cast through the locally-derived `ContextMessage`
   (`NonNullable<ContextEvent["messages"]>[number]`) — `MessageLike` is structurally wider, so `as unknown as ContextMessage[]`
   at the single return boundary (oracle GOTCHA #10).

## 6. Owned exports (filter.ts defines & exports)
- `interface MarkersBundle { rewinds: RewindMarker[]; shrinks: ShrinkMarker[]; metric: TurnMetric | null }`
- `function readMarkers(ctx: ExtensionContext): MarkersBundle`
- `function contextHandler(event: ContextEvent, ctx: ExtensionContext): ContextEventResult | void`
- (locally-derived, NOT exported) `type ContextMessage = NonNullable<ContextEvent["messages"]>[number]`;
  `interface ContextEventResult { messages?: ContextMessage[] }` — OR import ContextEventResult if re-exported.
  Check: ContextEventResult is in types.d.ts:774 but NOT in the root re-export list (index.d.ts:7). Define locally
  (structurally identical `{ messages?: ContextMessage[] }`) so `pi.on("context", contextHandler)` resolves structurally.
- Module-private defensive helpers `isRecord`/`readOwn` (mirror transforms.ts/notes.ts/markers.ts — never throw).

## 7. Baseline (verified GREEN today, before this task)
- `npx tsc --noEmit` → exit 0. `npx vitest run` → **411 tests / 10 files all green** (transforms 118, pipeline 33,
  markers 42, runtime 17, notes 71, log 15, config ?, tokens ?, ledger ?, integration/load placeholder).
- `src/filter.ts` is currently `export {};` (stub). `src/index.ts` is the no-op factory (`export default function(pi){}`).
  `src/nudges.ts` is a 1-line stub (P1.M3.T3 — NOT my dependency; nudge injection deferred).
- Wiring `pi.on("context", contextHandler)` into index.ts is **P1.M5.T1** (NOT this task). My gate `pi -e ./src/index.ts -p hi`
  only proves filter.ts COMPILES + its imports resolve at load (getConfig/runtime/filterPipeline/logError/types).

## 8. Test approach (IMPLICIT TDD — test/filter.test.ts, vitest globals:true)
Mirror markers.test.ts fakes. `makeCtx({sessionId?, entries?, branch?, throwOnGetEntries?, throwOnGetBranch?,
throwOnGetSessionId?})` scripts `sessionManager.{getSessionId,getEntries,getBranch}`. `makeEvent(messages)` → `{type:"context",messages}`.
beforeEach/afterEach: `clearAll()` + `setLogFile(null)`.
**readMarkers suite:** empty entries→empty bundle; buckets mulligan:rewind+mulligan:shrink; latest metric by highest seq
(2 metrics seq 3 & 7 → metric.seq===7); null metric when none; ignores custom_message(notes)+label(checkpoints)
(type!=="custom"); skips malformed (data not a record / wrong kind / unknown customType) without throwing; never throws
when getEntries throws → empty bundle.
**contextHandler suite:**
- disabled: `setConfig({enabled:false})` → returns undefined (pass-through, C4) AND `rt.lastFiltered` stays null (no cache pollution); restore enabled after.
- no markers: event.messages round-trips → returns `{messages}` same length; `rt.lastFiltered` deep-equals messages; `rt.lastFilterTs` is a recent number.
- F-rewind-core mechanic (the spike's central proof, via fakes): event.messages = [user, asst(toolCall "X"), toolResult("X","CANARY bloat"), asst(rewindCall "R"), toolResult("R"), custom(mulligan:note)]; ctx entries carry ONE rewind marker {granularity:"last_tool_call_group", excludeToolCallId:"R", seq:1}; assert contextHandler returns {messages} WITHOUT the canary tool group (user + rewind's own + note survive) — pairing intact.
- shrink mechanic: a shrink marker {by_tool_call_id:"X", replacement:"SUMMARY"} → returned messages have the X result's content replaced, role/toolCallId preserved.
- fail-open (F-failopen): `throwOnGetEntries:true` (or getBranch) → returns undefined, does NOT throw, `rt.lastFiltered` NOT overwritten (stays null/prior), error would be logged if setLogFile pointed at a tmp file (assert via a tmp log read).
- C12 fresh read: call contextHandler twice with different entries → second call sees the updated markers (getEntries re-read each fire).
- branchEntries reversal: checkpoint rewind resolves correctly only when getBranch output is reversed to root→leaf (regression guard for gotcha #1).

## 9. Docs impact
No per-item Mode A documentation file (Pi-integration glue code). The changeset-level README (install/config/usage +
soft-delete / visible-in-/tree guarantee) is synced in the FINAL milestone P1.M5.T4. This PRP surfaces that deferral.
