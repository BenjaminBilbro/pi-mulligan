# Research Notes — P1.M2.T6.S1 (transforms.ts: applyRewind + resolveShrinkTarget + applyShrink + protectedOk + filterPipeline)

## Task
APPEND the APPLY-OPS + PROTECTION + COMPOSITION tier to `src/transforms.ts` (the file built up by T4→T5) +
EXTEND `test/transforms.test.ts` (apply ops + resolver-target cases) + CREATE `test/pipeline.test.ts`
(filterPipeline + protectedOk + composition + property/invariant tests). spec/06 §1/§5/§8/§11/§12,
spec/08 E8/E13/E17/E19, spec/10 §1.4/§1.5/§1.9/§3. Every function stays PURE + Pi-FREE (0 imports — the module's
founding invariant from T4; `grep -c '^import' src/transforms.ts` MUST stay 0).

## Deliverables (the 5 CONTRACT functions + their supporting types/helpers)
1. `applyRewind(messages, remove): MessageLike[]` — gap-closed removal over resolved unit indices.
2. `resolveShrinkTarget(messages, target): number | null` — 3 matchers → one index or null.
3. `applyShrink(messages, marker): MessageLike[]` — LIVE-only content substitution (preserves role/toolCallId/
   toolName/isError via spread). NO pinnedEntryId/branchEntries param (CONTRACT = 2-param; pinning is a LATER task).
4. `protectedOk(messages, remove, config): boolean` — first:user defense-in-depth (`min(remove) > iFirstUser`).
5. `filterPipeline(messages, markers, config, branchEntries?): MessageLike[]` — rewinds(oldest-first)→shrinks
   (oldest-first)→return. GRANULARITY DISPATCH ONLY (last_tool_call_group / last_turn / checkpoint). NO hideEntryIds
   /turnHasAdvanced/diag sink (those are LATER bug-fix tasks — see Scope below).
+ supporting types: `ShrinkTarget`, `RewindMarkerLike`, `ShrinkMarkerLike`, `MarkerBundle`, `ProtectedConfig`.
+ supporting fn: `stableSortBySeq` (+ module-private `readOwnSeq`), module-private `stringifyContent`.

## Scope (CRITICAL — the CONTRACT deliberately EXCLUDES the oracle's later bug-fix machinery)
The sibling oracle (`/home/dustin/projects/pi-mulligan/src/transforms.ts`) is the COMPLETE passing impl, but it has
accumulated THREE later fix layers that are NOT in this task's contract:
- `resolvePinnedHide` + `hideEntryIds` (RewindMarkerLike field) + the PINNED-first dispatch in filterPipeline
  (BUG-001/BUG-002 permanent-hiding fix — fix_design.md §Change 1/3/4). OUT OF SCOPE.
- `resolvePinnedShrink` + `pinnedEntryId` (ShrinkMarkerLike field) + the pinned branch in applyShrink
  (FINDING 3 moving-target fix). OUT OF SCOPE.
- `turnHasAdvanced` + `ownGroupEndIndex` + `RewindDiag` + the `diag` sink + the "legacy-noop-advanced" guard
  (BUG: turn-replay-loop fix). OUT OF SCOPE — T5 research explicitly tags turnHasAdvanced as "= M3.T5".

This PRP ships the CONTRACT-faithful version: filterPipeline dispatches on `granularity` ONLY (no hideEntryIds
check), applyShrink is LIVE-only (2-param), RewindMarkerLike has NO hideEntryIds field, ShrinkMarkerLike has NO
pinnedEntryId field. A later fix task ADDS the pinning/guard machinery (additive — extends the marker types +
filterPipeline dispatch; non-breaking because all new fields are optional and the new resolvers are pure appends).

WHY this is correct (not a shortcut): the task's own CONTRACT DEFINITION lists exactly these 5 functions with
exactly these signatures/behaviors and says "resolve via granularity" (no pinning). T5 research enumerated the
pinned/guard symbols as out-of-scope/later. Shipping them here would violate scope boundaries + couple this pure
task to un-specced fix behavior. The CONTRACT version is fully correct for v1 single-mistake rewinds (the spec/06
§11 + §1.9 cases all pass); the degenerate multi-pass replay loop is a documented later hardening.

## Dependencies (verified Complete + present in THIS repo)
- **P1.M2.T5.S1 (Complete)** → `src/transforms.ts` exports `partitionIntoUnits`, `Unit`, `MessageLike`,
  `resolveLastToolCallGroup`, `resolveLastTurn`, `resolveCheckpoint`, `BranchEntry`; module-private `isRecord`,
  `readOwn`, `assistantIssuedCall`, `isMulliganCustomMessage`, `entryMessageYield`, `isContextProducingType`.
  T6 REUSES all of these (no redeclaration). VERIFIED baseline: `npx tsc --noEmit` exit 0; `npx vitest run` →
  304 pass (8 files); `npx vitest run test/transforms.test.ts` → 86 pass.
- No other deps. Pure module: takes DATA (messages, markers-as-data, config-as-data, branchEntries-as-data),
  never `ctx`/Pi.

## Oracle declaration map (grep-verified line numbers in sibling transforms.ts)
```
699  export function applyRewind(messages, remove): MessageLike[]                ← SHIP VERBATIM (contract-faithful)
728  export type ShrinkTarget                                                     ← SHIP VERBATIM
758  export function resolveShrinkTarget(messages, target): number | null         ← SHIP VERBATIM
828  export function resolvePinnedShrink(...)                                     ← OUT OF SCOPE (FINDING 3)
902  export function applyShrink(messages, marker, branchEntries?)                ← SHIP LIVE-ONLY (drop branchEntries
                                                                                      param + the pinned branch; 2-param)
957    function stringifyContent(content): string                                 ← SHIP (module-private; resolveShrinkTarget needs it)
992  export interface RewindMarkerLike                                            ← SHIP MINUS hideEntryIds field
1021 export interface ShrinkMarkerLike                                            ← SHIP MINUS pinnedEntryId field
1039 export interface MarkerBundle                                                ← SHIP VERBATIM
1050 export interface ProtectedConfig                                             ← SHIP VERBATIM
1068 export function stableSortBySeq<T>(markers): T[]                             ← SHIP VERBATIM
1076   function readOwnSeq(marker): number                                        ← SHIP (module-private)
1105 export function protectedOk(messages, remove, config): boolean               ← SHIP VERBATIM
1148 export interface RewindDiag                                                  ← OUT OF SCOPE (turn-replay diag)
1175   function ownGroupEndIndex(...)                                             ← OUT OF SCOPE (turn-replay guard)
1196   function turnHasAdvanced(...)                                              ← OUT OF SCOPE (turn-replay guard)
1261 export function filterPipeline(messages, markers, config, branchEntries?, diag?)  ← SHIP MINUS hideEntryIds
                                                                                      dispatch + turnHasAdvanced guard + diag sink
```

## Function contracts (reproduce from oracle, DROPPING the out-of-scope parts)

### 1. applyRewind(messages, remove) → MessageLike[]  [oracle L699 — VERBATIM]
- `if (!Array.isArray(messages)) return [];` (defensive, mirrors partitionIntoUnits).
- `if (!Array.isArray(remove) || remove.length === 0) return messages;` (SAME ref — no-op; spec/10 §1.4 idempotent).
- Build `removeSet = new Set<number>()`; for each `r` in remove: `if (typeof r === "number" && !Number.isNaN(r))
  removeSet.add(r);` (non-numbers/NaN never a valid index → ignored; NaN excluded so [NaN,"x"] is a true no-op).
- `if (removeSet.size === 0) return messages;` (no valid indices → unchanged, same ref).
- `return messages.filter((_msg, i) => !removeSet.has(i));` — gap-closed (Array.filter → contiguous); the callback
  IGNORES the element → a throwing-Proxy get-trap never fires → NEVER throws (E13).
- Pure: never mutates `messages`. EMPTY/invalid remove → SAME reference (idempotent — spec/10 §1.4).

### 2. ShrinkTarget (type)  [oracle L728 — VERBATIM]
```ts
export type ShrinkTarget =
  | { by_tool_call_id: string }
  | { by_tool_name: string; occurrence: "last" | "first" }
  | { by_content_includes: string };
```
Structurally identical to markers.ts's ShrinkMarker.target (assigns in with NO cast). LOCAL (Pi-free — mirrors
MessageLike). EXPORTED (shrink tool P1.M4.T2 + filterPipeline + tests share it).

### 3. resolveShrinkTarget(messages, target) → number | null  [oracle L758 — VERBATIM]
- `if (!Array.isArray(messages)) return null;` `if (!isRecord(target)) return null;`
- **by_tool_call_id** (first present non-empty-string key wins): `callId = readOwn(target,"by_tool_call_id")`; if
  string+non-empty → loop messages; first `role==="toolResult" && readOwn(m,"toolCallId")===callId` → return i;
  else null. (toolCallId unique → at most one.)
- **by_tool_name + occurrence**: `name = readOwn(target,"by_tool_name")`; if string+non-empty →
  `wantFirst = readOwn(target,"occurrence") === "first"` (anything else incl. missing → LAST — GOTCHA); loop
  messages; for each toolResult with `readOwn(m,"toolName")===name`: if wantFirst `return i` (first wins); else
  `found = i` (keep scanning → last wins). `return found === -1 ? null : found;`
- **by_content_includes**: `needle = readOwn(target,"by_content_includes")`; if typeof string → loop messages;
  first whose `stringifyContent(readOwn(messages[i],"content")).includes(needle)` → return i; else null. (ANY role
  — spec/08 E19.)
- No recognizable discriminator → null.
- Pure + defensive + TOTAL (every read via isRecord/readOwn; never throws — E13; hot path via filterPipeline).

### 4. applyShrink(messages, marker) → MessageLike[]  [oracle L902 — LIVE-ONLY, 2-PARAM]
CONTRACT signature is `applyShrink(messages, marker)` (NOT the oracle's 3-param with branchEntries — the 3rd param
is ONLY for the pinned path, which is OUT OF SCOPE). marker = `{ target: ShrinkTarget; replacement: string }`
(structural; a real ShrinkMarker assigns in with NO cast — only the 2 fields are read).
- `if (!Array.isArray(messages)) return [];` (defensive).
- `if (!isRecord(marker)) return messages;` (non-record marker → SAME ref no-op).
- `i = resolveShrinkTarget(messages, readOwn(marker,"target") as ShrinkTarget);` (LIVE resolution; readOwn =
  throwing-Proxy safe). `if (i === null || i < 0 || i >= messages.length) return messages;` (no match → SAME ref
  no-op — spec/06 §5:133; ALSO the shrink-after-rewind-removed-target no-op — spec/06 §5:143 / spec/08 E8).
- `orig = messages[i];` `rep = readOwn(marker,"replacement");` `text = typeof rep === "string" ? rep : "";`
  `newContent = [{ type:"text", text }];`
- `role = readOwn(orig,"role");` `replacement: MessageLike;` `try { replacement = { ...orig, content: newContent }; }`
  `catch { replacement = { role: typeof role === "string" ? role : undefined, content: newContent }; }` (throwing-
  Proxy spread → minimal fallback preserving role — E13 + E19).
- `return messages.map((m, j) => (j === i ? replacement : m));` — NEW array; non-matched elements copied BY
  REFERENCE (never read → throwing-Proxy-safe). Spread preserves role/toolCallId/toolName/isError/customType/…
  → pairing intact (toolResult keeps toolCallId — spec/06 §5:145) + role preserved (E19).
- **MULTIPLE shrinks same target → last wins (spec/06 §5:143, spec/08 E17):** achieved NATURALLY by sequential
  application — NO special last-wins code. Each applyShrink re-resolves against the CURRENT messages (the 2nd call
  sees the already-shrunk message), matches it again (by_tool_call_id stable — spread preserved toolCallId), and
  overwrites content → last replacement wins.

### 5. protectedOk(messages, remove, config) → boolean  [oracle L1105 — VERBATIM]
- `if (!Array.isArray(remove) || remove.length === 0) return true;` (nothing to remove → vacuously ok).
- `if (!Array.isArray(messages)) return true;` (vacuous; filterPipeline guards non-array → [] upstream).
- Does config protect FIRST user? Default YES. FAIL SAFE: `protectFirstUser = true;` read `rewindCfg =
  isRecord(config) ? readOwn(config,"rewind") : undefined;` `roles = isRecord(rewindCfg) ?
  readOwn(rewindCfg,"protectedRoles") : undefined;` `if (Array.isArray(roles) && roles.length > 0)
  protectFirstUser = roles.some(r => r === "first:user");` `if (!protectFirstUser) return true;` (config explicitly
  disables → allow).
- `iFirstUser` = FIRST index with role "user" (-1 if none). `if (iFirstUser === -1) return true;` (nothing protected).
- `minRemove = Infinity;` for each r in remove: `if (typeof r === "number" && !Number.isNaN(r) && r < minRemove)
  minRemove = r;` `if (!Number.isFinite(minRemove)) return true;` (no numeric entries → vacuous).
- `return minRemove > iFirstUser;` (spec/06 §8). The LATEST:user + to_previous_prompt refusals are enforced BY
  CONSTRUCTION in resolveLastTurn (default keeps iLastUser; nuclear refuses when iFirst===iLast — T5 already
  ships+tests this). protectedOk is the FILTER's double-check (defense-in-depth — spec/06 §8).

### 6. stableSortBySeq + readOwnSeq  [oracle L1068/L1076 — VERBATIM]
- `stableSortBySeq<T extends { seq?: unknown }>(markers: T[]): T[]` — `if (!Array.isArray(markers)) return [];`
  `return [...markers].sort((a,b) => readOwnSeq(a) - readOwnSeq(b));` (shallow copy → non-mutating; stable in Node).
- `readOwnSeq(marker): number` — `s = readOwn(marker,"seq");` `return typeof s === "number" && Number.isFinite(s)
  ? s : 0;` (missing/non-finite/throwing-Proxy → 0, sorted first).

### 7. filterPipeline(messages, markers, config, branchEntries?) → MessageLike[]  [oracle L1261 — DROPS pinning/guard]
SIGNATURE: 4 params (branchEntries OPTIONAL — needed ONLY for checkpoint granularity, which the contract's "resolve
via granularity" includes; passed as getBranch() DATA by filter.ts in M3). NO `diag` sink (that's the turn-replay
diagnostic — out of scope). Drop the hideEntryIds/turnHasAdvanced dispatch; dispatch on `granularity` ONLY.
- `if (!Array.isArray(messages)) return [];`
- Read markers defensively: `bundle = isRecord(markers) ? markers : undefined;` `rewindsRaw = bundle ?
  readOwn(bundle,"rewinds") : undefined;` same shrinksRaw. `rewinds = Array.isArray(rewindsRaw) ? rewindsRaw : [];`
  same shrinks. (Non-record/missing arrays → [] → pass-through.)
- `let m = messages;`
- **1) REWINDS oldest-first:** `for (const rw of stableSortBySeq(rewinds)) {`:
  - `granularity = readOwn(rw,"granularity");` `excludeRaw = readOwn(rw,"excludeToolCallId");` `excludeId =
    typeof excludeRaw === "string" ? excludeRaw : undefined;`
  - `let remove: number[];`
  - `if (granularity === "last_tool_call_group") { const units = partitionIntoUnits(m); remove =
    resolveLastToolCallGroup(units, m, excludeId) ?? []; }` — **RE-PARTITION fresh each iteration** (the §12
    pseudocode partitions ONCE before the loop → stale indices after the first rewind reduces m; re-partitioning
    keeps unit.indices valid against current m — this is the oracle's fix, GOTCHA).
  - `else if (granularity === "last_turn") { remove = resolveLastTurn(m, readOwn(rw,"options") as
    {to_previous_prompt?: boolean}|undefined, excludeId).remove; }` — options carries to_previous_prompt VERBATIM.
  - `else if (granularity === "checkpoint") { const cpRaw = readOwn(rw,"checkpoint"); const cpName = typeof cpRaw
    === "string" ? cpRaw : ""; remove = resolveCheckpoint(m, Array.isArray(branchEntries) ? branchEntries : [],
    cpName, excludeId)?.remove ?? []; }`
  - `else { remove = []; }` (unknown granularity → no-op).
  - `if (!protectedOk(m, remove, config)) continue;` (defense-in-depth — skip+warn; the warn is filter.ts's job
    in M3, but the SKIP happens here).
  - `m = applyRewind(m, remove);` `}`
- **2) SHRINKS oldest-first:** `for (const sh of stableSortBySeq(shrinks)) { m = applyShrink(m, sh); }` (LIVE —
  applyShrink re-resolves each call; ShrinkMarkerLike is structurally assignable to {target,replacement}).
- **3) return m;** (NO injectNudge — that's filter.ts's concern per external_deps §3.1; this pipeline transforms
  markers ONLY).
- Pure + defensive + TOTAL: never mutates messages/markers; never throws (every read via isRecord/readOwn;
  applyRewind ignores elements; applyShrink try/caught). SAME reference as `messages` when no marker transforms.

## Critical Gotchas (the non-obvious traps — READ ALL before coding)
1. **Re-partition EACH rewind iteration (NOT once before the loop).** spec/06 §12 pseudocode partitions once →
   stale-index bug: after rewind#1 reduces m, resolveLastToolCallGroup's returned unit.indices index the OLD
   partitioned array. Re-partitioning each iteration (`const units = partitionIntoUnits(m)` inside the loop) keeps
   them valid against the current m. (Oracle's fix; the §12 pseudocode is a simplification.)
2. **applyShrink is 2-PARAM + LIVE-ONLY (CONTRACT).** Do NOT add branchEntries/pinnedEntryId/resolvePinnedShrink —
   those are the FINDING 3 moving-target fix (LATER task). marker = {target, replacement}. The spread preserves
   toolCallId so by_tool_call_id re-matches across multiple shrinks → last-wins is automatic (NO special code).
3. **filterPipeline drops the hideEntryIds/turnHasAdvanced/diag machinery (CONTRACT).** Dispatch on `granularity`
   ONLY. The PINNED path + replay guard are LATER fixes (BUG-001/002 + turn-replay). Shipping them = scope violation.
4. **Idempotency interpretation (CRITICAL — do NOT over-claim).** The contract says "idempotency
   filterPipeline(filterPipeline(m))===filterPipeline(m)". For the LIVE/granularity version this holds for:
   (a) SHRINKS — strictly (re-substituting same replacement = same result); (b) DETERMINISM (same input twice →
   same output — always); (c) single-mistake rewinds WITH a valid excludeToolCallId (after one pass the own group
   is kept + no other group remains → 2nd pass no-ops). It does NOT hold for multi-group last_tool_call_group
   rewinds WITHOUT excludeToolCallId under live re-resolution (oracle GOTCHA #8 — each pass re-targets the new
   "last" group). The oracle's own property tests therefore test: shrink idempotency + determinism + monotonic
   shrinkage + pairing — NOT full rewind∘rewind. Reproduce that test design EXACTLY (see Test Plan). The later
   hideEntryIds/turnHasAdvanced task is what hardens the degenerate case.
5. **Two-rewind composition (spec/06 §11) needs DISTINCT excludeToolCallIds.** §11's narrative (rewind#1 excludes
   cR3 → removes a2/r2; rewind#2 excludes cR4 → removes a1/r1) produces two DISTINCT removals in ONE pass ONLY when
   cR3 ≠ cR4. If two rewinds share the SAME excludeToolCallId, the 2nd no-ops (after the 1st removes the only
   non-excluded group, the only group left is the excluded own-group → resolveLastToolCallGroup returns null). The
   oracle tags the §11 "two distinct removals from one exclude" reading as an ERRATUM. TEST BOTH: distinct-exclude
   → 2 removals (the §11 fixture); same-exclude → 1 removal + 1 no-op.
6. **options.to_previous_prompt is SNAKE_CASE (VERBATIM).** spec/04 §3 line 119 = persisted field. spec/06 §4's
   `toPreviousPrompt` is a SPEC TYPO. Read `readOwn(rw,"options")` and `.to_previous_prompt` verbatim (T5 already
   established this; filterPipeline threads `rw.options` through unchanged).
7. **branchEntries is root→leaf (getBranch() order), NOT reversed.** resolveCheckpoint (T5) walks it root→leaf; the
   label scan goes end→start for most-recent. filterPipeline passes `getBranch()` DATA verbatim as the 4th param.
8. **No-op = SAME reference (not a deep-equal new array).** applyRewind/applyShrink/filterPipeline all return the
   SAME `messages` reference when they transform nothing. Tests assert `.toBe(msgs)` for no-op cases (spec/10 §1.4,
   defensive cases). This is the idempotent-no-op contract.
9. **0 imports invariant.** transforms.ts imports NOTHING (founding T4 invariant). T6 reuses the module-private
   isRecord/readOwn/assistantIssuedCall/isMulliganCustomMessage/entryMessageYield/isContextProducingType already in
   scope + adds ONE new module-private (stringifyContent). Do NOT import from markers.ts/config.ts/tokens.ts — the
   marker/config types are declared LOCALLY (structural, mirror MessageLike/BranchEntry).
10. **NEVER throws (spec/08 E13).** Every property read via isRecord/readOwn (readOwn try/catches Proxy get-traps).
    Sits on the context-handler hot path via filterPipeline. Non-array/non-record inputs → []/same-ref gracefully.

## Test plan

### test/transforms.test.ts — EXTEND (apply ops + resolveShrinkTarget; spec/10 §1.4, §1.5)
- EXTEND the import line: add `applyRewind`, `applyShrink`, `resolveShrinkTarget`, `ShrinkTarget`,
  `RewindMarkerLike`, `ShrinkMarkerLike` (the types are needed for mkRewind/mkShrink builders).
- REUSE existing builders (asst/asstText/result/user/custom/entry/labelEntry/summary/expectPairingInvariant).
- **applyRewind (spec/10 §1.4):** removing a toolGroup unit keeps pairing (no orphan calls/results — use
  expectPairingInvariant on the output); removing last_turn's set keeps the rewind's own unit + mulligan:note at
  tail; empty remove → SAME ref (idempotent); non-array messages → []; remove with NaN/non-number/out-of-range →
  ignored (no-op same ref); does not mutate input; gap-closed (contiguous output).
- **resolveShrinkTarget:** by_tool_call_id → first toolResult with that toolCallId; by_tool_name+last → last
  matching toolResult; by_tool_name+first → first; by_content_includes → first message (ANY role) whose stringified
  content includes substring (string content verbatim; array content via JSON); no match → null; non-array messages
  → null; non-record target → null; missing/empty discriminator → null; occurrence missing/non-"first" → last.
- **applyShrink (spec/10 §1.5):** by_tool_call_id match → content replaced with [{type:"text",text:replacement}],
  role/toolCallId/toolName/isError PRESERVED (assert each); no match → SAME ref (no-op); two shrinks same target seq
  order → LAST wins (apply seq 1 then seq 2 → seq 2's replacement); shrink on non-toolResult (by_content_includes
  matching a user msg) → role preserved (E19); non-array messages → []; non-record marker → same ref; throwing-
  Proxy matched message → never throws (try/catch fallback); does not mutate input.

### test/pipeline.test.ts — CREATE (filterPipeline + protectedOk + composition + property; spec/10 §1.9, §3)
- Import from `../src/transforms.js`: `filterPipeline`, `protectedOk`, `stableSortBySeq`, `filterPipeline`'s data
  types (`RewindMarkerLike`, `ShrinkMarkerLike`, `MarkerBundle`, `ProtectedConfig`, `MessageLike`, `BranchEntry`).
- Local builders: `cfg = { rewind: { protectedRoles: ["first:user","latest:user"] } } as ProtectedConfig`;
  `mkRewind(seq, granularity, extra?) => ({seq, granularity, ...extra})`;
  `mkShrink(seq, target, replacement, extra?) => ({seq, target, replacement, ...extra})`;
  `textOf(m)` = first text block's text. Reuse message builders by re-declaring the minimal set (asst/asstText/
  result/user/custom) OR import from a shared helper — the repo convention is per-file local builders (each test
  file declares its own; see transforms.test.ts vs ledger.test.ts), so re-declare locally.
- **stableSortBySeq:** ascending by seq; stable for equal seq (input order preserved); non-mutating (new array);
  non-array → []; non-finite/missing seq → 0.
- **protectedOk (spec/06 §8):** min(remove) > iFirstUser → true; remove including/at iFirstUser → false (skip);
  empty remove → true (vacuous); no user message → true; non-array messages → true; config with protectedRoles
  omitting "first:user" → true (disabled); config undefined/malformed → enforce first:user (fail safe); non-number
  remove entries ignored.
- **filterPipeline composition (spec/10 §1.9):**
  - bullet 1: TWO rewinds, DISTINCT excludeToolCallIds (spec/06 §11 fixture) → both remove → assert exact surviving
    role sequence + that the rewind own-groups + note survive. ALSO: two rewinds SAME excludeToolCallId → 1 removes,
    2nd no-ops (the erratum clarification).
  - bullet 2: rewind-then-shrink-on-removed-target → shrink no-ops (target gone; SAME ref for the shrink step) —
    assert no "[shrunk]" text in output.
  - bullet 3: protected (last_turn + to_previous_prompt on single-user session) → resolveLastTurn refuses → remove=[]
    → protectedOk vacuous → nothing removed → first user kept (layered protection).
  - shrinks compose oldest-first (two shrinks → both applied).
  - last_turn through pipeline keeps the rewind's own unit + the note (assert role sequence).
  - checkpoint through pipeline removes everything after the checkpoint point (build root→leaf branchEntries; pass
    as 4th param; assert prefix kept).
  - UNPINNED (live) by_tool_name:"read":last shrink → matches last read (backward-compat — NO pinnedEntryId case;
    the pinned-drift case is OUT OF SCOPE / later task).
  - defensive: no markers / non-record markers / empty markers → SAME ref; non-array messages → []; unknown
    granularity + malformed markers → skipped (never throws); purity (input messages + markers untouched).
- **filterPipeline property/invariant (spec/10 §3 — SEE GOTCHA #4 for the exact idempotency scoping):**
  - Seeded `mulberry32` PRNG (no external dep; fixed seed → reproducible). `genMessages(rng)` builds WELL-FORMED
    lists: user / text-asst / fully-paired ADJACENT asst+results (1-2 calls each) so pairs are never split.
  - **pairing invariant** (300 iters): up to 2 rewinds (last_tool_call_group OR last_turn, excludeToolCallId
    sometimes a real call id `cN`, sometimes undefined) → `expectNoOrphans(out)` (every toolCall id has a toolResult
    and vice versa). **THIS IS THE LOAD-BEARING TEST — DO NOT PROCEED UNTIL IT PASSES.**
  - **monotonic shrinkage** (300 iters): `out.length <= msgs.length` always.
  - **idempotency (shrinks)** (200 iters): `filterPipeline(filterPipeline(msgs, markers), markers)` ===
    `filterPipeline(msgs, markers)` for SHRINK-ONLY markers (rewinds:[]). (Full rewind idempotency is GOTCHA #8 —
    out of scope; do NOT assert it.)
  - **determinism** (200 iters): `filterPipeline(msgs, markers)` called twice → equal (re-fire idempotency).

## Verified gates (in THIS tree — pi-mulligan-hack)
- `test -f src/transforms.ts -a -f test/transforms.test.ts` → exit 0 (both exist; T6 appends to transforms.ts +
  extends transforms.test.ts + CREATES pipeline.test.ts).
- `npx tsc --noEmit` → exit 0 (current baseline; must stay green). tsconfig include:["src","test"].
- `npx vitest run test/transforms.test.ts` → 86 pass (baseline); T6 EXTENDS → grows.
- `npx vitest run test/pipeline.test.ts` → NEW file; must pass (composition + property tests).
- `npx vitest run` → 304 pass (baseline); T6 adds tests → grows; NO regression in other files.
- `grep -c '^import' src/transforms.ts` → MUST stay 0 (Pi-free invariant; verify after editing).
- vitest 1.6.1 + tsc ^5 installed → NO npm install needed. jiti loads .ts at Pi runtime (pure module; N/A here).

## Cross-task cohesion
- T5 (Complete) shipped the 3 resolvers + their helpers — T6 REUSES them (partitionIntoUnits, resolveLastToolCallGroup,
  resolveLastTurn, resolveCheckpoint, isRecord, readOwn, assistantIssuedCall, isMulliganCustomMessage,
  entryMessageYield, isContextProducingType). The module stays 0-imports.
- M3.T1 (markers.ts) persists RewindMarker/ShrinkMarker whose fields (granularity, options.to_previous_prompt,
  excludeToolCallId, checkpoint, target, replacement, seq) filterPipeline + applyShrink read — the structural
  RewindMarkerLike/ShrinkMarkerLike types here are the read-slice contract between them.
- M3.T2 (filter.ts) calls `filterPipeline(event.messages, readMarkers(ctx), getConfig(), ctx.sessionManager.getBranch())`
  + injects the nudge AFTER (external_deps §3.1 seam) + logs the protectedOk warn.
- M4.T2 (tools/shrink.ts) ALSO consumes `resolveShrinkTarget` directly for best-effort "matched now: yes/no" feedback
  at marker-creation time (OUTPUT contract #4).
- The LATER pinning/guard task (hideEntryIds + resolvePinnedHide + resolvePinnedShrink + pinnedEntryId +
  turnHasAdvanced + RewindDiag) ADDS to this surface non-breakingly: new optional marker fields + new pure resolvers
  + a dispatch branch + an optional diag param. T6's contract version is the correct v1 foundation.

## DOCS impact
No per-item Mode A DOCS line for this task (pure core code — transforms.ts + tests; no user-facing doc). The
changeset-level doc (README: install/config/usage + the "soft-delete / visible-in-/tree" guarantee) is synced in
the FINAL milestone P1.M5 (spec/11 Step 9). This PRP does not touch docs.
