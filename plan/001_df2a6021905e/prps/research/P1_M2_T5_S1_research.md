# Research Notes — P1.M2.T5.S1 (transforms.ts: resolveLastToolCallGroup + resolveLastTurn + resolveCheckpoint)

## Task
APPEND three relative/absolute targeting RESOLVERS to `src/transforms.ts` (the file created by T4) + their
module-private helpers + the exported `BranchEntry` type, and APPEND their vitest suites to the SHARED file
`test/transforms.test.ts` (spec/10 §1.2, §1.3 + checkpoint cases). Each resolver computes a UNIT-AWARE
`remove` index set (or `null`) that `applyRewind` (T6) consumes; it never mutates messages, never throws, and
imports NOTHING (the module stays the PERMANENT zero-imports tier established by T4).

Returns shapes (CRITICAL — three DIFFERENT return contracts):
- `resolveLastToolCallGroup(...)` → `number[] | null`  (the unit's indices, or nothing-to-rewind)
- `resolveLastTurn(...)`          → `{ remove: number[] }`  (NEVER null — empty array = no-op/refusal)
- `resolveCheckpoint(...)`        → `{ remove: number[] } | null`  (null = indeterminate/refuse; empty = nothing-after)

## Scope (CRITICAL — T5 ships the THREE resolvers + their helpers ONLY)
- `src/transforms.ts` already holds T4's `partitionIntoUnits` + exported `Unit`/`MessageLike` + module-private
  `isRecord`/`readOwn` (lines 1–~185). T5 APPENDS (does NOT rewrite):
    * `export function resolveLastToolCallGroup(units, messages, excludeToolCallId?): number[] | null`
    * module-private `function assistantIssuedCall(messages, indices, callId): boolean`
    * `export function resolveLastTurn(messages, opts, excludeToolCallId?): { remove: number[] }`
    * module-private `function isMulliganCustomMessage(msg): boolean`
    * `export interface BranchEntry { type; id; parentId?; timestamp?; targetId?; label?; [key:string]:unknown }`
    * `export function resolveCheckpoint(messages, branchEntries, checkpointName, excludeToolCallId?): { remove: number[] } | null`
    * module-private `function entryMessageYield(entry): number`
    * module-private `function isContextProducingType(type): boolean`
- OUT OF SCOPE (later tasks — do NOT reproduce): `resolvePinnedHide` (separate BUG-001/002 fix), `applyRewind`,
  `ShrinkTarget`/`resolveShrinkTarget`/`resolvePinnedShrink`/`applyShrink`/`stringifyContent` (all = T6),
  `filterPipeline` + marker/config types + `stableSortBySeq`/`protectedOk`/`ownGroupEndIndex`/`turnHasAdvanced` (= M3.T5).
- `test/transforms.test.ts` is the SHARED test file (T4 created it with 30 tests + shared builders). T5 EXTENDS
  the import line to add the three resolvers + `BranchEntry`, and APPENDS new describe blocks. It REUSES T4's
  builders (`asst`, `asstText`, `result`, `user`, `custom`, `summary`, `expectPairingInvariant`) and ADDS a
  small `BranchEntry` fixture builder for checkpoint tests.

## Dependencies (verified Complete + present in THIS repo)
- **P1.M2.T4.S1 (Complete)** → `src/transforms.ts` exports `partitionIntoUnits`, `Unit`, `MessageLike`; defines
  module-private `isRecord`/`readOwn` (hoisted — T5 reuses them, does NOT redeclare). `test/transforms.test.ts`
  exists with the shared builders + partitionIntoUnits suite (30 tests). VERIFIED: `npx vitest run
  test/transforms.test.ts` → 30 pass; `npx vitest run` → 248 pass; `npx tsc --noEmit` → exit 0.
- No other deps. The resolvers are pure: they take DATA (messages, units, branchEntries, names/ids), never `ctx`.

## Oracle (read-only sibling — architecture/system_context.md §3 designates it THE reference)
- `/home/dustin/projects/pi-mulligan/src/transforms.ts` — the COMPLETE passing impl. **T5 reproduces ONLY
  lines 222–558** (the three resolvers + their 4 module-privates + BranchEntry). Lines 1–221 = T4 (already
  shipped); lines 559+ = T6 / later fixes (OUT OF SCOPE).
- `/home/dustin/projects/pi-mulligan/test/transforms.test.ts` — the COMPLETE passing test. T5 reproduces the
  resolver test tier (the describe blocks AFTER partitionIntoUnits; the shared builders at the top are already
  in our tree from T4).

### Oracle declaration map (grep-verified line numbers)
```
223  export function resolveLastToolCallGroup(units, messages, excludeToolCallId?): number[] | null
259    function assistantIssuedCall(messages, indices: number[], callId): boolean      [module-private]
319  export function resolveLastTurn(messages, opts, excludeToolCallId?): { remove: number[] }
380    function isMulliganCustomMessage(msg): boolean                                  [module-private]
386  // ── resolveCheckpoint section ──
394  export interface BranchEntry
454  export function resolveCheckpoint(messages, branchEntries, checkpointName, excludeToolCallId?): { remove: number[] } | null
549    function entryMessageYield(entry): number                                       [module-private]
556    function isContextProducingType(type): boolean                                  [module-private]
--- OUT OF SCOPE BELOW (T6 / later) ---
560+ resolvePinnedHide, applyRewind, ShrinkTarget, resolveShrinkTarget, resolvePinnedShrink, applyShrink, stringifyContent, filterPipeline, ...
```

## Resolver contracts (reproduce verbatim from the oracle)

### 1. resolveLastToolCallGroup [line 223] — `number[] | null`
- Guard: non-array `units` → `null`. `hasExclude = typeof excludeToolCallId === "string" && excludeToolCallId.length > 0`.
- Walk `units` END→start (k = length-1 .. 0). For each unit: skip if not a record / `kind !== "toolGroup"` /
  `indices` not an array. If `hasExclude && assistantIssuedCall(messages, unit.indices, excludeToolCallId)`
  → `continue` (skip the rewind's OWN unit, or a parallel-shared message — spec/06 §3, §9, spec/08 E6).
  Else `return unit.indices` (read-only reference — applyRewind copies via filter).
- Loop end with no match → `return null` (nothing to rewind; applyRewind no-ops — spec/08 E8).

#### module-private assistantIssuedCall(messages, indices, callId) [line 259] → boolean
- `if (!Array.isArray(messages)) return false;` for each `i` in `indices`: msg = messages[i]; skip unless
  isRecord && role==="assistant"; content = readOwn(msg,"content"); skip unless Array; for each block: skip
  unless isRecord && readOwn(block,"type")==="toolCall"; `if (readOwn(block,"id") === callId) return true`.
- Scans ALL assistant members + ALL their toolCall blocks → handles parallel-tool (one assistant message,
  several calls — spec/06 §9). NEVER throws (isRecord/readOwn). Returns false on no-match / malformed.

### 2. resolveLastTurn [line 319] — `{ remove: number[] }` (NEVER null)
- `if (!Array.isArray(messages)) return { remove: [] };`
- `iLastUser` = LAST index with role "user" (scan the WHOLE list, keep updating). `-1` → `return { remove: [] }`
  (no user message → protected, nothing to rewind).
- `nuclear = opts !== undefined && opts.to_previous_prompt === true`.
  **★GOTCHA D1 (VERIFIED):** reads `opts.to_previous_prompt` VERBATIM in snake_case. spec/04 §3 line 119
  confirms the persisted RewindMarker.options field is `to_previous_prompt?: boolean`. spec/06 §4's
  `toPreviousPrompt` (camelCase) is a SPEC TYPO — do NOT use it. filterPipeline (T6/M3) passes `rw.options`
  through verbatim.
- If nuclear: find `iFirstUser` = FIRST user index; `if (iFirstUser === iLastUser) return { remove: [] };`
  (would cross the first-user / original-task protection — spec/06 §8, spec/08 E3).
- `rewindOwnIndices = new Set<number>()`; `hasExclude` as above. If hasExclude: `const units =
  partitionIntoUnits(messages);` for each unit where `kind === "toolGroup" && assistantIssuedCall(messages,
  unit.indices, excludeToolCallId)` → add ALL of `unit.indices` to the set (keep the WHOLE unit → parallel-safe
  §9/E6, NO special branching — the whole shared assistant + all sibling results survive).
- Build `remove` ASCENDING: if nuclear `remove.push(iLastUser)`; then `for (j = iLastUser+1; j <
  messages.length; j++)`: skip if `rewindOwnIndices.has(j)`; skip if `isMulliganCustomMessage(messages[j])`;
  else push. `return { remove }`.
- The surviving tail = [user] + [mulligan:note/nudge] + [rewind assistant+result]. The note MUST survive so the
  resumed model reads it.

#### module-private isMulliganCustomMessage(msg) [line 380] → boolean
- `if (!isRecord(msg)) return false;` `customType = readOwn(msg, "customType");` `return typeof customType ===
  "string" && customType.startsWith("mulligan:")`. (Detects mulligan:note + mulligan:nudge — both survive.)

### 3. resolveCheckpoint [line 454] — `{ remove: number[] } | null` (accepts DATA, not ctx — pure)
- Guards: `if (!Array.isArray(messages) || !Array.isArray(branchEntries)) return null;` `if (typeof
  checkpointName !== "string" || checkpointName.length === 0) return null;`
- `needle = \`mulligan:checkpoint:${checkpointName}\`;`
- **Label scan (most-recent wins):** scan `branchEntries` END→start (leaf→root); for the FIRST entry that is
  isRecord && readOwn(type)==="label" && readOwn(label)===needle && `targetId = readOwn(e,"targetId")` is a
  non-empty string → set `targetId`, `break`. None → `return null` (spec/08 E10 not-found → refuse).
- `ctxEntries = branchEntries.filter(e => isContextProducingType(isRecord(e) ? readOwn(e,"type") : undefined));`
  **★NO reverse** — branchEntries is ALREADY root→leaf (getBranch() order; the no-reverse convention was
  established in T4's partitionIntoUnits comments + the oracle's resolveCheckpoint/resolvePinnedHide step-3
  notes). spec/06 §6 step 2's "leaf→root, then reverse" produces the SAME root→leaf walk; the oracle's
  no-reverse is the canonical form.
- **Parallel walk** with `msgCursor = 0`, `iTarget = -1`, `found = false`: for each entry `e`:
  `y = entryMessageYield(e);` if `y < 0` → `return null` (compaction/unknown = INDETERMINATE → refuse, never
  guess); if `msgCursor + y > messages.length` → `return null` (raw branch vs compaction-aware messages
  misalign); if isRecord(e) && readOwn(e,"id")===targetId → `iTarget = msgCursor + y - 1` (the entry's LAST
  message index — KEPT), `found = true`, `break`; else `msgCursor += y`.
- `if (!found) return null;` (targetId labels a non-context-producing entry → refuse).
- **★UNIT-SNAP (BUG-003 / spec/06 §2):** `const units = partitionIntoUnits(messages);` for each unit: if
  `unit.indices.includes(iTarget)` → `iTarget = Math.max(...unit.indices); break;` (if the checkpoint lands
  inside a toolGroup — e.g. the checkpointed entry is an assistant with tool calls — snap iTarget to the unit's
  END so the assistant + ALL its results are KEPT and `remove` starts strictly after → never orphans a toolCall.
  Plain (single-message) unit → no-op, max===iTarget.)
- **remove** (IDENTICAL rule to resolveLastTurn): `rewindOwnIndices` Set — only if hasExclude, reuse `units`
  from the unit-snap step (partitionIntoUnits is pure; messages is const, never mutated); for each toolGroup
  where assistantIssuedCall → add ALL its indices. Then `for (j = iTarget+1; j < messages.length; j++)`: skip
  rewindOwnIndices, skip isMulliganCustomMessage, else push. `return { remove }`.

#### export interface BranchEntry [line 394]
```ts
export interface BranchEntry {
  type: string;            // "message" | "custom_message" | "compaction" | "branch_summary" | "label" | "custom" | ...
  id: string;
  parentId?: string | null;
  timestamp?: string;
  targetId?: string;       // LabelEntry only — the checkpointed entry id
  label?: string;          // LabelEntry only — "mulligan:checkpoint:<name>"
  [key: string]: unknown;  // message/customType/summary/firstKeptEntryId/... read defensively via readOwn
}
```
A real Pi `SessionEntry[]` from `getBranch()` assigns in with NO cast (structural typing — mirrors
MessageLike/Unit). EXPORTED so tests build typed fixtures + filter.ts (later) passes `getBranch()` typed as
BranchEntry[].

#### module-private entryMessageYield(entry) [line 549] → number
- `type = isRecord(entry) ? readOwn(entry, "type") : undefined;` if type === "message" || "custom_message" ||
  "branch_summary" → `return 1;` else `return -1` (compaction = INDETERMINATE; unknown/non-context-producing
  also -1 as a safety net — they're filtered out before the walk).
- **★GOTCHA (compaction — VERIFIED):** spec/06 §6 says compaction yields `1 + retainedTail.length` and "refuse
  if a compaction entry lacks retainedTail." The INSTALLED Pi `CompactionEntry` has NO `retainedTail`, AND
  `getBranch()` is the RAW path (not compaction-aware) while `event.messages` IS compaction-aware → a compaction
  on the root→target walk makes the entry→message mapping INDETERMINATE. Returning -1 (→ null → refuse safely)
  is the CORRECT behavior. spec/06 §6's "1+retainedTail.length" does NOT match installed Pi — do NOT implement it.

#### module-private isContextProducingType(type) [line 556] → boolean
- `return type === "message" || type === "custom_message" || type === "branch_summary" || type === "compaction";`
  (compaction IS context-producing per spec/06 §6 step 2's filter list, but entryMessageYield then returns -1
  for it → refuse. So compaction passes the filter but trips the indeterminate guard. This is intentional.)

## Critical Gotchas (the non-obvious traps)
1. **D1 — `to_previous_prompt` snake_case (VERIFIED):** spec/04 §3 line 119 shows the persisted
   RewindMarker.options field is `to_previous_prompt?: boolean`. spec/06 §4's `toPreviousPrompt` is a SPEC TYPO.
   Read `opts.to_previous_prompt` verbatim.
2. **Compaction = INDETERMINATE → null:** entryMessageYield returns -1 for compaction → resolveCheckpoint
   returns null (refuse). NEVER implement spec/06 §6's "1+retainedTail.length" (installed Pi has no
   retainedTail; getBranch() is raw, messages is compaction-aware → misalign).
3. **No internal reverse:** branchEntries from getBranch() is root→leaf. The label scan goes END→start (to
   pick the leaf-most = most-recent label); the ctxEntries WALK goes in natural root→leaf order. Do NOT reverse
   for the walk (spec/06 §6 step 2's reverse is superseded by the oracle's no-reverse convention).
4. **UNIT-SNAP (BUG-003):** after computing iTarget, if it's inside a toolGroup unit, snap it to the unit's MAX
   index so the checkpointed assistant + all its results survive. Without this, remove would orphan a toolCall.
5. **Parallel-tool whole-unit keep:** the rewind's own unit is kept WHOLE (assistant + ALL results) via
   rewindOwnIndices — no special parallel branching. This is the safe, conservative handling for §9/E6.
6. **Three different return shapes:** lastToolCallGroup → `number[]|null`; lastTurn → `{remove}` (never null);
   checkpoint → `{remove}|null`. Each consumer (filterPipeline, T6) handles its own shape.
7. **resolveCheckpoint is PURE:** it takes `branchEntries` (DATA), NOT `ctx`. It never imports Pi. filter.ts
   (later) passes `getBranch()` as BranchEntry[].
8. **NEVER throws (spec/08 E13):** every property read via isRecord/readOwn (readOwn try/catches Proxy get).
   Sits on the context-handler hot path via filterPipeline. Non-array inputs → null/`{remove:[]}`.
9. **MessageLike + isRecord/readOwn are REUSED from T4** — do NOT redeclare them. T5 imports nothing new; it
   just appends to the module scope where those are already defined.

## Verified gates (in THIS tree — pi-mulligan-hack)
- `test -f src/transforms.ts -a -f test/transforms.test.ts` → exit 0 (both exist from T4; T5 appends).
- `npx tsc --noEmit` → exit 0 (current; must stay green). tsconfig include:["src","test"].
- `npx vitest run test/transforms.test.ts` → 30 tests pass (T4); T5 APPENDS resolver tests → grows.
- `npx vitest run` → 248 tests pass (baseline); T5 adds resolver tests → grows; NO regression in other files.
- vitest 1.6.1 + tsc ^5 installed in node_modules → NO npm install needed. jiti loads .ts at Pi runtime (pure
  module; not relevant here).

## Test plan (APPEND to test/transforms.test.ts — spec/10 §1.2, §1.3 + checkpoint)
- EXTEND the import line: add `resolveLastToolCallGroup`, `resolveLastTurn`, `resolveCheckpoint`, `type BranchEntry`.
- REUSE existing builders (asst/asstText/result/user/custom). ADD a small BranchEntry fixture builder
  (`entry(type,id,extra?)`, `labelEntry(label,targetId)`) for checkpoint tests.
- resolveLastToolCallGroup (spec/10 §1.2): [u,a(call A),r(A),a(call B),r(B)] no exclude → a(B)+r(B) unit
  indices; exclude=B → a(A)+r(A) unit; no toolGroup → null; non-array units → null; exclude absent/empty/
  non-string → never skip; exclude a non-existent id → returns last toolGroup (not skipped).
- resolveLastTurn (spec/10 §1.3): [u0,a,r,u1,a,r] default → remove indices >u1 (keep u1); to_previous_prompt
  true → also remove u1; u1 is the first user → to_previous_prompt returns `{remove:[]}` (refused); no user →
  `{remove:[]}`; the rewind's own unit survives (asst+result with excludeToolCallId); mulligan:note survives
  (custom("mulligan:note") not in remove); non-mulligan custom IS removed; parallel-shared assistant kept whole.
- resolveCheckpoint: label found → remove = everything after iTarget (prefix kept); checkpoint on an assistant
  with tool results → UNIT-SNAP keeps the whole toolGroup (remove starts after the unit); not-found → null;
  compaction on the walk → null (indeterminate); targetId labels a non-context-producing entry → null; the
  rewind's own unit + mulligan:* notes survive the sweep (same rule as last_turn); most-recent duplicate label
  wins (leaf-most); non-array inputs / empty checkpointName → null.
- Defensive never-throws for all three (null/non-array messages, throwing-Proxy entries, malformed opts).

## Cross-task cohesion
- T4 (Complete) shipped partitionIntoUnits + Unit + MessageLike + isRecord/readOwn — T5 REUSES all four (no
  redeclaration). The module stays zero-imports.
- T6 (P1.M2.T6.S1, depends on T5) APPENDS applyRewind (consumes the `remove` arrays these resolvers produce),
  applyShrink, resolveShrinkTarget, protectedOk, filterPipeline (spec/06 §12 partitions once and threads units).
- filter.ts (P1.M3.T2) calls filterPipeline; markers.ts (P1.M3.T1) persists the markers whose fields
  (granularity, options.to_previous_prompt, excludeToolCallId, checkpoint) these resolvers read.
- The `to_previous_prompt` snake_case field is the persisted contract between markers.ts (writer) and
  resolveLastTurn (reader) — both must agree (spec/04 §3). Documented here so T5 + P1.M3.T1 + P1.M4.T1 align.
