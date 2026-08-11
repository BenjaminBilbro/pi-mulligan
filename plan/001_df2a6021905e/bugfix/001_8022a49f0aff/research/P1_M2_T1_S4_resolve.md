# P1.M2.T1.S4 — Filter resolves against pinned hideEntryIds (research notes)

> Subtask of **P1.M2.T1** (Pin rewind targets at creation — BUG-002). Depends on S1 (Complete: `hideEntryIds?: string[]`
> on `RewindMarker` + `RewindMarkerLike`) and S2 (Complete: `mapEntryIdsToMessageIndices`). S3 (Complete: capture in
> `tools/rewind.ts`) POPULATES the field at creation; THIS subtask (S4) is the filter-side CONSUMER — it makes
> `filterPipeline` resolve a rewind's removal set from the pin instead of the live granularity resolver. S5 (Planned:
> composition regression test) consumes S4.

## 0. TL;DR — the contract's literal pin call is INCOHERENT under composition; the fix needs index translation

The work-item contract says:
> `remove = mapEntryIdsToMessageIndices(m, Array.isArray(branchEntries)?branchEntries:[], pinned)`

where `m` is the **reducing** message array (each prior rewind `applyRewind`s it). I empirically proved (spike
`/tmp/s4-spike.mjs`) that this **MIS-REMOVES messages under composition**: `branchEntries` is the FULL branch
(getBranch, fixed across the loop) so its entry-positions align with `m`'s indices ONLY on the first rewind; once an
earlier rewind gap-closes `m`, a later pin's branch-walk yields original-positions that no longer match `m`'s current
indices. On the canonical BUG-002 fixture (read→rewind→grep→rewind), the literal call leaves **GREP-OUTPUT visible**
(the grep group survives) and instead removes **rewind#2's own toolGroup** — exactly the kind of latent bug a PRP must
surface. The S5 regression test (`includes('GREP-OUTPUT') === false`) would FAIL.

**The correct, spike-verified approach:** resolve the pin against the **ORIGINAL** `messages` (the unreduced input —
`m` starts as `messages` and only diverges after the first removal) via `mapEntryIdsToMessageIndices(messages,
branchEntries, pinned)`, then **translate** each original index to its CURRENT `m`-index through a parallel
`origIdxOfM: number[]` array (`origIdxOfM[j] ===` the original index of `m[j]`), maintained in lockstep with `m` by
applying the SAME `applyRewind(origIdxOfM, remove)` after each rewind. An original index that is already absent from
`origIdxOfM` (`indexOf === -1`) was removed earlier / by compaction → skip (no-op for that entry, matching the
contract's "pinned entry absent → no-op" rule). This keeps LIVE resolution byte-for-byte unchanged (it still resolves
against `m` and returns `m`-indices directly), so the 672-test baseline stays green, and it makes the BUG-002
composition case correct (spike `s4-spike.mjs` APPROACH B: both BIG-READ-OUTPUT and GREP-OUTPUT hidden, both rewind
confirmations kept).

## 1. Current state (verified)

- `src/transforms.ts:filterPipeline` (lines 800-869): the rewinds loop re-partitions `m` fresh each iteration and
  dispatches on `granularity` (last_tool_call_group → resolveLastToolCallGroup; last_turn → resolveLastTurn;
  checkpoint → resolveCheckpoint). The `protectedOk(m, remove, config)` gate + `m = applyRewind(m, remove)` are the
  shared tail. NO pin branch yet.
- `RewindMarkerLike.hideEntryIds?: string[]` ALREADY EXISTS (S1, line 711) with the exact prescribed doc-comment.
- `mapEntryIdsToMessageIndices(messages, branchEntries, entryIds): number[]` ALREADY EXISTS (S2, line 500) — pure,
  Pi-free, partial-collect on indeterminacy. `resolveCheckpoint` already delegates to it (S2 refactor).
- The filterPipeline doc-comment (lines 806-809) still says `NO hideEntryIds/turnHasAdvanced/diag (later fix tasks)`.
  S1 explicitly deferred this clause to S4: "S4 rewrites it." So S4 MUST replace the `NO hideEntryIds` clause.
- `src/filter.ts:contextHandler` (line 183): `const branchEntries = ctx.sessionManager.getBranch().slice().reverse()`
  → `filterPipeline(messages, markers, config, branchEntries)`. getBranch() returns LEAF→ROOT; .slice().reverse() →
  ROOT→LEAF. This is the COHERENCE ANCHOR: branchEntries is the FULL branch (root→leaf), unchanged across the loop.
- readOwn / isRecord are module-private in transforms.ts and already used throughout filterPipeline — in scope.
- Baseline gates VERIFIED: `npx tsc --noEmit` exit 0; `npx vitest run` = 672 passed / 2 skipped;
  `npx vitest run test/pipeline.test.ts` = 35 passed.

## 2. The coherence proof (why the literal contract is wrong)

`m` starts === `messages` (same ref). Each rewind's `applyRewind(m, remove)` returns a NEW gap-closed array (when
remove is non-empty), so `m` SHRINKS while `branchEntries` (the full branch) stays fixed. `mapEntryIdsToMessageIndices`
walks `branchEntries` with a `msgCursor` that assumes a 1:1 branch-position ↔ message-index correspondence — which
holds ONLY while `m === messages`. After rewind#1 removes messages, `m`'s indices no longer line up with the branch
walk, so a later pin resolves to indices that point at the WRONG messages in the reduced `m`.

Hand-trace on the BUG-002 fixture `[u0, aRead, rRead(BIG-READ), aR1, rR1, note, aGrep, rGrep(GREP), aR2, rR2, note]`
(11 msgs; branch 11 context-producing entries; rw1 pins READ entries @branch[1,2], rw2 pins GREP entries @branch[6,7]):

- **Literal (`mapEntryIdsToMessageIndices(m, …)`):** rw1 → remove=[1,2] (m=full, correct); m shrinks to 9. rw2 → walk
  reaches GREP entries at cursor 6,7 (6+1≤9, 7+1=8≤9) → returns [6,7]; but m[6],m[7] are now aR2,rR2 (the rewind's OWN
  group). So GREP survives at m[4],m[5] and rewind#2's confirmation is mis-removed. **FAIL.**
- **Correct (`mapEntryIdsToMessageIndices(messages, …)` + origIdxOfM translate):** rw1 → origIdxs=[1,2], origIdxOfM
  identity → remove=[1,2]; origIdxOfM becomes [0,3,4,5,6,7,8,9,10], m=9. rw2 → origIdxs=[6,7]; origIdxOfM.indexOf(6)=4,
  indexOf(7)=5 → remove=[4,5] = aGrep,rGrep. Both hidden correctly, both rewind confirmations kept. **PASS.**

Spike output (`npx tsx /tmp/s4-spike.mjs`) confirms verbatim:
```
APPROACH A (literal): GREP-OUTPUT present? true, rewound2 present? false  → FAILS S5
APPROACH B (correct):  GREP-OUTPUT present? false, rewound2 present? true   → passes S5
```

## 3. The correct filterPipeline change

Insert a pin branch as the FIRST dispatch arm in the rewinds loop; maintain `origIdxOfM` parallel to `m`:

```ts
let m = messages;
// Parallel: origIdxOfM[j] = ORIGINAL messages[] index of m[j]. Keeps pin→current-m translation coherent under
// composition (BUG-002): a later rewind's pinned entry-ids resolve to ORIGINAL indices, which we translate to
// current-m indices via this map. Maintained in lockstep with m (same applyRewind(remove)).
let origIdxOfM = messages.map((_x, i) => i);

for (const rw of stableSortBySeq(rewinds)) {
  const granularity = readOwn(rw, "granularity");
  const excludeRaw = readOwn(rw, "excludeToolCallId");
  const excludeId = typeof excludeRaw === "string" ? excludeRaw : undefined;

  let remove: number[]; // CURRENT m-indices (for protectedOk + applyRewind)
  const pinnedRaw = readOwn(rw, "hideEntryIds");
  if (Array.isArray(pinnedRaw) && pinnedRaw.length > 0) {
    // PIN (BUG-002): resolve entry-ids → ORIGINAL indices (stable target), then translate to CURRENT m-indices
    // via origIdxOfM. An id already absent (-1) was removed earlier / by compaction → skip (no-op for it).
    const origIdxs = mapEntryIdsToMessageIndices(
      messages,                          // ORIGINAL (NOT reduced m) — the coherence fix
      Array.isArray(branchEntries) ? branchEntries : [],
      pinnedRaw,
    );
    remove = [];
    for (const oi of origIdxs) {
      const curIdx = origIdxOfM.indexOf(oi);
      if (curIdx >= 0) remove.push(curIdx);
    }
    remove.sort((a, b) => a - b);
  } else if (granularity === "last_tool_call_group") {
    const units = partitionIntoUnits(m);
    remove = resolveLastToolCallGroup(units, m, excludeId) ?? [];
  } else if (granularity === "last_turn") {
    remove = resolveLastTurn(m, readOwn(rw, "options") as { to_previous_prompt?: boolean } | undefined, excludeId).remove;
  } else if (granularity === "checkpoint") {
    const cpRaw = readOwn(rw, "checkpoint");
    const cpName = typeof cpRaw === "string" ? cpRaw : "";
    remove = resolveCheckpoint(m, Array.isArray(branchEntries) ? branchEntries : [], cpName, excludeId)?.remove ?? [];
  } else {
    remove = [];
  }

  if (!protectedOk(m, remove, config)) continue;
  origIdxOfM = applyRewind(origIdxOfM, remove); // keep parallel with m (lockstep removal)
  m = applyRewind(m, remove);
}
```

Key properties (all spike-verified):
- LIVE-only scenarios (no hideEntryIds): the pin branch is never taken; `remove` comes from the existing resolvers
  unchanged; the only added work is `origIdxOfM = applyRewind(origIdxOfM, remove)` (pure bookkeeping, does not affect
  `m`). → 672-test baseline unaffected.
- Pin + live interleave: origIdxOfM is updated by BOTH pin and live removals (same `applyRewind(origIdxOfM, remove)`),
  so a later pin translates correctly regardless of whether earlier removals were pinned or live. (CASE5 verified.)
- `applyRewind(origIdxOfM, remove)` returns the SAME ref when remove is empty (no-op rewind) → origIdxOfM unchanged.
- `origIdxOfM.indexOf(oi)` is O(n) per pinned id; for typical small n and few pins, negligible. (A Map<origIdx,curIdx>
  built once per pin rewind is an optional O(1) optimization — not required for v1.)

## 4. Edge cases (all spike-verified in /tmp/s4-spike2.mjs)

| Case | Fixture | Expected | Verified |
|---|---|---|---|
| Single pin ≠ live | pin READ group (non-last) | pin removes READ; live removes OTHER; they differ → pin consumed | ✓ CASE1 |
| Pinned entry absent (compaction/never-existed) | pin ids not in branch | remove=[]; out === msgs (same ref) | ✓ CASE2 |
| protectedOk gates pin | pin targets first:user | min(remove)=0 ≤ iFirstUser=0 → refused; out unchanged | ✓ CASE3 |
| S1 carry-through stays green | hideEntryIds=['e1','e2'], branchEntries=[] | pin→[] (no ctxEntries); live→[] (only excluded toolGroup); both no-op → equal | ✓ CASE4 |
| Pin+live interleave | rw1 pin A, rw2 live B | both A and B hidden; origIdxOfM bookkeeping correct | ✓ CASE5 |

**S1 carry-through test (`test/pipeline.test.ts:440-453` "hideEntryIds is carried but not consumed (S1 behavioral
no-op)") stays GREEN after S4** — CASE4 proves it: with `branchEntries=[]`, the pin resolves to [] (no-op) and the
live path also resolves to [] (the only toolGroup is excluded by `excludeToolCallId:'c'`), so `outPinned === outPlain`.
The test's NAME becomes slightly stale ("not consumed") but its assertion remains valid; S4 may optionally refresh the
comment to note the degenerate-fixture reason. NOT required to touch.

## 5. Test design (pipeline.test.ts — new describe block)

S5 owns the content-level stacked-rewind regression guard; S4 owns the UNIT-level pin mechanics. Add a
`describe('filterPipeline — hideEntryIds pin resolution (BUG-002; P1.M2.T1.S4)', …)` block (after the existing
composition describe at line 251, reusing the file's `user/asst/asstText/result/entry/mkRewind/cfg/expectNoOrphans`
builders). Cases (concrete fixtures in §3 of the PRP):

1. **single pin removes its target (pin ≠ live)** — pin a non-last toolGroup; assert pin output ≠ live output (proves
   consumption) + the pinned group's content is absent.
2. **backward compat — marker without hideEntryIds uses live resolution** — the existing composition tests already
   prove this by staying green; add one explicit focused case for clarity.
3. **COMPOSITION — two stacked pins each remove their own target (BUG-002 unit essence)** — rw1 pins READ, rw2 pins
   OTHER; assert BOTH hidden (this is the test that FAILS on the literal contract and PASSES on the correct approach).
4. **pinned entry absent → no-op** — pin ids not in branch; assert out === msgs (same ref).
5. **protectedOk gates the pin** — pin first:user with protectedRoles=['first:user']; assert out unchanged.
6. **pin + live interleave** — rw1 pin A, rw2 live B; assert both hidden (origIdxOfM bookkeeping across mixed types).

## 6. Scope boundaries (NOT touched by S4)

- `src/markers.ts` — S1 shipped `hideEntryIds?: string[]` + the `appendRewindMarker` spread. NO edit.
- `src/tools/rewind.ts` — S3 ships the capture (populates hideEntryIds at creation). NO edit.
- `src/filter.ts` — already passes `branchEntries` to filterPipeline. NO edit.
- `src/config.ts` — hideEntryIds is marker data, not config. NO edit.
- The shrinks loop (filterPipeline step 2) — UNCHANGED (the contract: "NO change to the shrinks loop").
- `resolveLastToolCallGroup` / `resolveLastTurn` / `resolveCheckpoint` / `partitionIntoUnits` / `mapEntryIdsToMessageIndices`
  / `protectedOk` / `applyRewind` — all UNCHANGED (S4 only adds the pin dispatch arm + origIdxOfM in filterPipeline).

## 7. Docs impact

- The filterPipeline doc-comment (transforms.ts ~line 806-809): REPLACE the `NO hideEntryIds/turnHasAdvanced/diag`
  clause's `NO hideEntryIds` part to describe the new pin path (S1 deferred this to S4). Keep the `turnHasAdvanced/diag`
  "later fix tasks" note (still accurate). Mode A (inline code doc).
- No README/spec edit required for S4 (the field was documented by S1; spec/06 §1/§8 already describe protectedOk
  gating every remove; spec/06 §6 describes the entry→message walk). The changeset-level BUG-002 doc
  (design_decisions.md §BUG-002 step 3) is satisfied by the implementation.

## 8. Gates (verified working on baseline)

- `npx tsc --noEmit` → exit 0 (proves the pin branch + origIdxOfM + doc-comment typecheck; all consumers compile).
- `npx vitest run test/pipeline.test.ts` → green (35 existing + new pin tests; existing composition + S1 carry-through stay green).
- `npx vitest run` → green (672 baseline + new pin tests, 0 regressions).
- Level 4 (manual:true): scope check — git diff touches EXACTLY src/transforms.ts + test/pipeline.test.ts; coherence
  hand-trace (the §2 trace) holds.

## 9. Confidence

9/10. The hardest part — the composition coherence — is SOLVED and spike-verified (the literal contract fails, the
origIdxOfM approach passes, on the exact BUG-002 fixture S5 will use). Live behavior is provably unchanged (the pin
branch is additive; origIdxOfM is pure bookkeeping). Residual risk: a careless implementer copies the literal contract
verbatim (mitigated by the §0 TL;DR + §2 proof + §3 exact code + the FAILS-on-literal / PASSES-on-correct test #3);
or forgets the `applyRewind(origIdxOfM, remove)` lockstep (mitigated by the test #6 pin+live interleave + the
manual L4 gate). Not 10/10 because the deviation from the stated contract requires the implementer to TRUST the PRP's
analysis over the work-item prose — the spike evidence + the failing-on-literal test make that safe.
