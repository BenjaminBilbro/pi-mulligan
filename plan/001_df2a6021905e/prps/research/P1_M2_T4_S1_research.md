# Research Notes — P1.M2.T4.S1 (transforms.ts: partitionIntoUnits)

## Task
Implement the cardinal pairing primitive `partitionIntoUnits(messages): Unit[]` in `src/transforms.ts`
(replacing the `export {};` stub) + its vitest suite `test/transforms.test.ts` (spec/10 §1.1). This is THE
correctness foundation: every removal transform (T5 resolvers, T6 applyRewind/applyShrink/filterPipeline)
operates on UNITS, never raw indices, so tool pairing is preserved by construction (spec/06 §2).

## Scope (CRITICAL — T4 ships ONE function + its types/helpers ONLY)
- `src/transforms.ts` currently = `export {};` (scaffolded in P1.M1.T1.S1). T4 replaces it with:
  `partitionIntoUnits`, exported `interface Unit`, exported `interface MessageLike`, module-private
  `isRecord` + `readOwn`. NOTHING ELSE.
- T5 (P1.M2.T5.S1, depends on T4) APPENDS `resolveLastToolCallGroup`, `resolveLastTurn`, `resolveCheckpoint`,
  etc. and REUSES T4's exported `Unit`/`MessageLike` + hoisted `isRecord`/`readOwn`.
- T6 (P1.M2.T6.S1, depends on T5) APPENDS `applyRewind`, `applyShrink`, `resolveShrinkTarget`,
  `protectedOk`, `filterPipeline`, etc.
- The oracle's transforms.ts is 1368 lines (all of M2.T4/T5/T6); T4 reproduces ONLY lines 1–217.
- `test/transforms.test.ts` is the SHARED test file. T4 creates it with: imports (partitionIntoUnits +
  Unit + MessageLike only — T5/T6 extend later), shared fixture builders, the partitionIntoUnits describe
  blocks (oracle lines 1–381). T5/T6 APPEND their describe blocks + extend the import line.

## Dependencies (verified Complete + present in THIS repo)
- P1.M1.T1.S1 → `src/transforms.ts` exists as `export {};` (the scaffold this task replaces). ZERO other deps.
- partitionIntoUnits is a PERMANENT zero-imports pure helper (like tokens.ts/ledger.ts): imports NOTHING —
  not Pi, not config, not log, not runtime, NOT tokens.ts/ledger.ts/notes.ts. Defines its own local
  structural types + its own module-private isRecord/readOwn (the established convention: each pure module
  keeps its own copy — see tokens.ts/ledger.ts/notes.ts).

## Oracle (read-only sibling — architecture/system_context.md §3 designates it THE reference)
- `/home/dustin/projects/pi-mulligan/src/transforms.ts` lines 1–217 — COMPLETE passing impl of partitionIntoUnits.
- `/home/dustin/projects/pi-mulligan/test/transforms.test.ts` lines 1–381 — the partitionIntoUnits test tier
  (6 describe blocks + 7 fixture-builder helpers).

### Oracle exports (T4 surface — verified via grep + read)
```
MessageLike   interface { role?: string; content?: string | ContentBlock[]; [key:string]: unknown }
Unit          interface { indices: number[]; kind: "plain" | "toolGroup" }
partitionIntoUnits(messages: MessageLike[] | null | undefined): Unit[]
// module-private (hoisted here for T5/T6 reuse): isRecord(value), readOwn(obj, key)
```

### Algorithm (spec/06 §2, steps a–e — captured verbatim from oracle lines 109–188)
- (a) Walk `messages`; build `Map<toolCallId, assistantIndex>` from EVERY assistant message's toolCall blocks.
      Only blocks whose `.id` is a non-empty string are pairable (GOTCHA #4). `readOwn(block,"type")==="toolCall"`.
- (b)+(c) Group ALL result indices by their paired assistant: for every toolResult whose `.toolCallId` is a
      non-empty string AND is in the callToAssistant map, push its index into that assistant's number[] bucket
      (`assistantToResults`). Orphan results (no matching assistant) are SKIPPED here → fall to plain in (d) (E1).
- For each DISTINCT assistant that issued ≥1 pairable call (dedup via `assigned` Set — GOTCHA #5):
      toolGroup = { indices: sorted([assistantIndex, ...results]), kind:"toolGroup" }.
      Assistant with calls but no results yet → toolGroup of just the assistant (spec/06 §2 corner case — GOTCHA #7).
- (d) Every index NOT in a toolGroup → plain unit { indices:[i] }. Orphan toolResults land here.
- (e) Sort units by `indices[0]` ascending.

### GOTCHAs captured from oracle (the load-bearing defensive cases)
- #4: only toolCall blocks with a non-empty STRING `.id` are pairable (missing/non-string/empty → not pairable → assistant demotes to plain unless it has other valid calls).
- #5: dedup assistants — one assistant with N calls appears N× in callToAssistant.values() → ONE toolGroup (use an `assigned` Set).
- #6: orphan result (no matching assistant) → SKIPPED in the join → becomes its OWN plain unit in (d) (spec/08 E1; never merged; SAFE RULE: if you cannot confirm BOTH sides, hide neither).
- #7: assistant with calls but no results yet → toolGroup of just the assistant (NOT demoted to plain).
- #8: NEVER throws (E13; context-handler hot path). isRecord rejects null/primitives/arrays; readOwn try/catch swallows throwing-Proxy get traps.
- #9: number[] per assistant (NOT a 1:1 map) so duplicate callIds group together → orphan-safe on removal; a result appearing BEFORE its assistant still pairs (order-robust).
- #10: toolGroup indices sorted ascending (regardless of call/result arrival order).
- #13: pairing invariant is FORWARD-direction (every toolGroup's non-assistant members are matching toolResults); the reverse (every call has a result) holds only when all results present.

## Test file conventions (oracle test lines 1–381)
- `import { describe, it, expect, expectTypeOf } from "vitest";`
- `import { partitionIntoUnits, type Unit, type MessageLike } from "../src/transforms.js";` (`.js` ESM path; T5/T6 extend this line later).
- NO beforeEach (transforms.ts has no module-scoped mutable state).
- Fixture builders (SHARED — T5/T6 reuse them): `asst(...callIds)`, `asstText(text)`, `result(toolCallId)`,
  `user(text)`, `custom(customType)`, `summary(units)` (compact "kind:minIdx:len" joiner), `expectPairingInvariant(messages, units)`.
- 6 describe blocks for partitionIntoUnits:
  1. "spec/10 §1.1 PINNED contract" — [user,asst(1call),result,asstText]→3 units (plain:0:1 | toolGroup:1:2 | plain:3:1);
     orphan→own plain; asst(3calls)+3results→1 toolGroup 4 indices; invariant across mixed list.
  2. "spec/06 §2 corner cases" — asst-no-results-yet→toolGroup(1 idx); parallel 2calls+2results→1 toolGroup;
     two separate pairs→2 toolGroups; interleaved asst(a),asst(b),result(a),result(b)→[0,2]+[1,3]; malformed-no-id call→orphan.
  3. "plain units" — empty→[]; no-tools→all plain in order; custom messages→plain; text-asst between toolGroups stays plain.
  4. "defensive NEVER throws" — null/undefined/non-array→[]; non-record elements skipped; asst non-array content→plain;
     missing/non-string/empty ids not pairable; duplicate callId across results→both group; result-before-asst still pairs;
     throwing-Proxy→plain no-throw; real Pi shape (structural typing).
  5. "ordering & determinism" — units ordered by min index; toolGroup indices ascending; pure/idempotent; no input mutation; inline snapshot.
  6. "types" — returns Unit[]; Unit shape {indices:number[]; kind:"plain"|"toolGroup"}; MessageLike accepts user/assistant/toolResult/custom; accepts null|undefined input.

## Gates (empirically verified in THIS tree)
- `test -f src/transforms.ts -a -f test/transforms.test.ts` — files exist (positive existence).
- `npx tsc --noEmit` — exit 0 currently (must stay green). tsconfig include:["src","test"], strict, noImplicitAny.
- `npx vitest run test/transforms.test.ts` — the new partitionIntoUnits suite green.
- `npx vitest run` — full suite no regression. Baseline (captured this session): 7 files / 218 tests pass.
  After T4: 8 files (adds test/transforms.test.ts).

## Confidence: 10/10
The contract is fully deterministic (one pure function + two exported types + two private helpers) and a verified
reference implementation (/home/dustin/projects/pi-mulligan/src/transforms.ts lines 1–217) + its passing test
(/home/dustin/projects/pi-mulligan/test/transforms.test.ts lines 1–381, partitionIntoUnits tier GREEN) exist in the
sibling main worktree. Zero dependencies beyond the M1.T1 scaffold (transforms.ts stub). All gates verified working.
