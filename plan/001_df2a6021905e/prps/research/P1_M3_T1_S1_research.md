# Research Notes — P1.M3.T1.S1 (markers.ts)

Task: appendRewindMarker / appendShrinkMarker / appendTurnMetric / leaveNote / setCheckpoint
Dependencies: P1.M1.T3.S1 (log.ts ✅), P1.M1.T4.S1 (runtime.ts ✅). Also consumes types from P1.M2 pure core (✅).

## 1. What already ships (DO NOT redefine — IMPORT)
- `src/runtime.ts`: `runtime(arg: string | {getSessionId():string}): SessionRuntime` (get-or-create),
  `nextSeq(rt: SessionRuntime): number` (PRE-increment; first marker → seq 1; takes the OBJECT),
  `clearAll()`, `SessionRuntime{sessionId,seq,tokenBaseline,lastTurnIndex,lastFiltered,lastFilterTs}`.
- `src/log.ts`: `logError(event, sessionId, data?)` (+ log/logInfo/logWarn/logDebug). OFF by default (setLogFile(null)).
- `src/config.ts`: `export type Granularity = "last_tool_call_group" | "last_turn" | "checkpoint"`.
- `src/notes.ts`: `export interface NoteInput { what_happened; avoid; true_current_state; next }`.
- `src/ledger.ts`: `export interface FileLedger { readFiles; modifiedFiles; bashSideEffects }`.
- `src/transforms.ts`: `export type ShrinkTarget = |{by_tool_call_id}|{by_tool_name,occurrence}|{by_content_includes}`.
  (transforms.ts is Pi-free, imports nothing — type-only import from it is acyclic.)
- src→src import convention = `.js` extension (notes.ts: `import type {FileLedger} from "./ledger.js"`).

## 2. Pi API signatures (VERIFIED against node_modules .d.ts)
- `pi.appendEntry<T>(customType: string, data?: T): void` — returns VOID (C7). types.d.ts:936.
- `pi.sendMessage<T>(msg: Pick<CustomMessage,"customType"|"content"|"display"|"details">, options?: {triggerTurn?;deliverAs?}): void`. types.d.ts:298.
- `pi.setLabel(entryId: string, label: string | undefined): void`. types.d.ts:942.
- `ReadonlySessionManager` (session-manager.d.ts:140) includes: `getSessionId(): string`, `getLeafId(): string | null`
  (**CAN return null** — wrapper must handle), `getLabel(id): string|undefined`, `getEntries(): SessionEntry[]`.
- Writes go through `pi` (appendEntry/sendMessage/setLabel); reads through `ctx.sessionManager` (C1).

## 3. CRITICAL divergences from the sibling oracle (/home/dustin/projects/pi-mulligan — READ-ONLY)
The oracle EVOLVED. OBEY THIS TASK'S CONTRACT, not the oracle:
- **nextSeq signature**: oracle calls `nextSeq(sessionId)` (string); MY runtime.ts is `nextSeq(rt)` (object).
  → markers.ts MUST `const rt = runtime(ctx.sessionManager); const seq = nextSeq(rt);`.
- **leaveNote signature**: oracle `leaveNote(pi, content, rewindId)` (positional); MY contract `leaveNote(pi, {content, rewindId})` (object).
- **setCheckpoint**: oracle uses getBranch() stable-anchor logic (BUG-003 fix) + returns SetCheckpointResult union;
  MY v1 contract = `setLabel(getLeafId(), "mulligan:checkpoint:"+name)` directly, returns `string | null`.
- **OMIT** (P3/bug-fix scope, NOT in this task): `appendCancelMarker` + CancelMarker; `RewindMarker.hideEntryIds`;
  `ShrinkMarker.pinnedEntryId`. MulliganEnvelope.kind union = "rewind"|"shrink"|"turn-metric" ONLY (no "cancel").

## 4. v1 contract (authoritative — from work item)
- `appendRewindMarker(pi,ctx,data: RewindMarkerInput): string|null` — appendEntry("mulligan:rewind",{...data,schema,v:1,kind:"rewind",id:randomUUID(),seq,nextSeq,ts}); return ctx.sessionManager.getLeafId() IMMEDIATELY (C7, same tick). try/catch+logError→null.
- `appendShrinkMarker(pi,ctx,data: ShrinkMarkerInput): string|null` — same, customType "mulligan:shrink", kind "shrink", stamps id.
- `appendTurnMetric(pi,ctx,data: TurnMetricInput): string|null` — customType "mulligan:turn-metric", kind "turn-metric", **NO `id` field** (spec/04 §5). seq+ts stamped.
- `leaveNote(pi, {content, rewindId}: LeaveNoteInput): void` — sendMessage({customType:"mulligan:note",content,display:true,details:{schema,v:1,kind:"note",rewindId}}); NO options arg (C8 — mid-turn). try/catch+log (sessionId "unknown", no ctx).
- `setCheckpoint(pi,ctx,name): string|null` — setLabel(getLeafId(), `mulligan:checkpoint:${name}`); return the leaf id. getLeafId()===null→return null. try/catch+log.

## 5. spec/04 widenings (documented, correct)
- RewindMarker.granularity uses `Granularity` (3 literals) not spec/04 §3's inline 2-literal union — spec/05 §1 + spec/06 §6
  require "checkpoint" (oracle GOTCHA #7). Filter's RewindMarkerLike already uses the 3-literal union + `checkpoint?: string`.
- RewindMarker gains optional `checkpoint?: string` (the name, for granularity:"checkpoint").
- TurnMetric.deltaTokens widened to `number | null` (spec/04 §5 prose: "null when baseline missing").

## 6. Owned types (spec/04 — markers.ts defines & exports)
MulliganEnvelope; RewindMarker(+RewindMarkerInput); ShrinkMarker(+ShrinkMarkerInput); TurnMetric(+TurnMetricInput);
NoteDetails {schema,v:1,kind:"note",rewindId}; LeaveNoteInput {content,rewindId}.

## 7. Baseline (verified green today)
- `npx tsc --noEmit` → exit 0. `npx vitest run` → 369 tests / 9 files all green. randomUUID from node:crypto works.

## 8. Test approach (IMPLICIT TDD)
Capture-fakes (makePi records appended[]/sent[]/labels[]; makeCtx scripts sessionId/leafId/getLabel with throwOn* flags),
adapted from oracle test/markers.test.ts MINUS cancel/getBranch. Key assertions: append→read-back via fake getEntries()
asserts type="custom" (NOT custom_message); leaveNote uses sendMessage (custom_message channel); setCheckpoint/getLabel
round-trip (C9); C7 call order; never-throws fail-open; seq monotonic + per-session isolated; id stamping (rewind/shrink
uuid, turn-metric none). before/afterEach: clearAll()+setLogFile(null).
