# P1.M2.T1.S5 — Composition regression test (originally-hidden CONTENT stays hidden after 2nd rewind)

> Subtask of **P1.M2.T1** (Pin rewind targets at creation — BUG-002). Depends on **S4 (Complete)**:
> `filterPipeline` (src/transforms.ts) now resolves a rewind's removal set from `hideEntryIds`
> (the BUG-002 pin) via `mapEntryIdsToMessageIndices(messages, …)` + `origIdxOfM` translation when
> the pin is present+non-empty, ELSE falls back to live granularity resolution. S5 is the
> CONTENT-level regression guard proving success criterion #4 (hidden content never reappears).

## 0. TL;DR

Add ONE new `describe` block to `test/pipeline.test.ts` (append at EOF, after the S4 pin-resolution
describe at line 537). It contains TWO tests against the SAME BUG-002 fixture
(read→rewind#1→note→grep→rewind#2→note — interspersed NON-rewound content):

1. **PIN path** — two stacked `last_tool_call_group` rewinds, each carrying `hideEntryIds` pinning
   its own toolGroup's branch-entry ids. Assert: `BIG-READ-OUTPUT` AND `GREP-OUTPUT` are BOTH absent
   from `JSON.stringify(out)`; both rewind (assistant+result) groups + both notes SURVIVE;
   `expectNoOrphans(out)`. **This test FAILS on pre-S4 code** (the pin field is ignored → live
   resolution re-exposes `BIG-READ-OUTPUT`) **and PASSES after S4.** That is the success-criterion-#4
   proof.
2. **LIVE-fallback path** — the SAME fixture with legacy markers (NO `hideEntryIds`; realistic
   `excludeToolCallId` per rewind). Assert: output is structurally VALID (role-correct,
   `expectNoOrphans`, non-empty). Documents the backward-compat path. Optional documentation
   assertion: `BIG-READ-OUTPUT` is STILL PRESENT under live resolution (the BUG-002 defect the pin
   fixes) — proves WHY the pin exists.

**Verified by spike** (`test/S5_spike.test.ts`, run + removed this session): all three behaviors
confirmed against the live post-S4 code — PIN hides both / LIVE re-exposes the read / pre-fix
simulation (hideEntryIds stripped) re-exposes the read.

## 1. Why a NEW test is needed (the existing composition test misses the bug)

The existing composition test at `test/pipeline.test.ts:252` ("two rewinds with DISTINCT
excludeToolCallIds → both remove (spec/06 §11)") asserts ONLY role signatures
(`["user","assistant","toolResult","custom"]`) and uses the spec §11 fixture where **every group
between the rewinds is itself rewound**. Under that symmetric fixture, live resolution happens to
produce a role-correct output, so the test PASSES today despite BUG-002. The PRD's BUG-002 fixture
has **interspersed NON-rewound content** (a read between rewind#1 and a grep between rewind#2) —
under live resolution the read REAPPEARS (the second rewind retargets the first). The S4 pin keeps
it hidden. The existing test cannot catch this because (a) it asserts roles not content, and (b) its
fixture has no interspersed non-rewound toolGroups. S5 closes that gap with a CONTENT-level assertion
on a fixture that reproduces the bug.

## 2. The fixture (content-bearing so absence is assertable)

Messages (11; `user` / `asst(...callIds)` / `resultText(id, text)` / `custom(customType)` builders):

| idx | msg                          | content / role            |
|-----|------------------------------|---------------------------|
| 0   | `user('u0')`                 | role user                 |
| 1   | `asst('cRead')`              | assistant toolCall cRead  |
| 2   | `resultText('cRead','BIG-READ-OUTPUT')` | toolResult cRead |
| 3   | `asst('cR1')`                | assistant toolCall cR1    |
| 4   | `resultText('cR1','rewound')`| toolResult cR1            |
| 5   | `custom('mulligan:note')`    | role custom               |
| 6   | `asst('cGrep')`              | assistant toolCall cGrep  |
| 7   | `resultText('cGrep','GREP-OUTPUT')` | toolResult cGrep  |
| 8   | `asst('cR2')`                | assistant toolCall cR2    |
| 9   | `resultText('cR2','rewound')`| toolResult cR2            |
| 10  | `custom('mulligan:note')`    | role custom               |

branchEntries (11, ROOT→LEAF, all type `"message"` so each yields exactly 1 message — matches
`mapEntryIdsToMessageIndices`'s ctxEntries walk). ids:

```
e-u, e-read-a, e-read-r, e-r1-a, e-r1-r, e-note1, e-grep-a, e-grep-r, e-r2-a, e-r2-r, e-note2
```

The read toolGroup = messages [1,2] ← branch entries `e-read-a`, `e-read-r`.
The grep toolGroup = messages [6,7] ← branch entries `e-grep-a`, `e-grep-r`.

## 3. The markers

**Test 1 (PIN):**
- `mkRewind(1, 'last_tool_call_group', { hideEntryIds: ['e-read-a','e-read-r'] })`
- `mkRewind(2, 'last_tool_call_group', { hideEntryIds: ['e-grep-a','e-grep-r'] })`

**Test 2 (LIVE fallback):**
- `mkRewind(1, 'last_tool_call_group', { excludeToolCallId: 'cR1' })`
- `mkRewind(2, 'last_tool_call_group', { excludeToolCallId: 'cR2' })`

## 4. Traces (all spike-verified)

### Test 1 — PIN path (post-S4, PASSES)
- rewind#1: `mapEntryIdsToMessageIndices(messages, branch, ['e-read-a','e-read-r'])` → origIdxs=[1,2];
  origIdxOfM=identity → remove=[1,2]. origIdxOfM→[0,3,4,5,6,7,8,9,10]; m→9.
- rewind#2: `mapEntryIdsToMessageIndices(messages, branch, ['e-grep-a','e-grep-r'])` → origIdxs=[6,7]
  (resolved against ORIGINAL messages); origIdxOfM.indexOf(6)=4, indexOf(7)=5 → remove=[4,5].
  m→[u0, aR1, rR1, note, aR2, rR2, note] (7).
- Output roles: `['user','assistant','toolResult','custom','assistant','toolResult','custom']`.
- `BIG-READ-OUTPUT` absent ✓; `GREP-OUTPUT` absent ✓; `rewound` present (×2) ✓; 2 customs (notes) ✓;
  `expectNoOrphans` ✓ (cR1↔rR1, cR2↔rR2 paired).

### Test 1 — pre-S4 simulation (FAILS — proves regression direction)
Pre-S4 `filterPipeline` had no pin arm, so `hideEntryIds` is ignored and the markers behave as live
`last_tool_call_group` with NO `excludeToolCallId`:
- rewind#1: last toolGroup (no exclude) from end = R2@[8,9] → remove [8,9]. m→9.
- rewind#2: on reduced m, last toolGroup (no exclude) = grep@[6,7] → remove [6,7]. m→7.
- Output: `[u0, aRead, rRead('BIG-READ-OUTPUT'), aR1, rR1, note, note]`.
- `BIG-READ-OUTPUT` is PRESENT → the assertion `includes('BIG-READ-OUTPUT') === false` FAILS. ✓ (This
  is the regression-guard property: the test fails on pre-fix code, passes after S4.)

### Test 2 — LIVE fallback (valid output; documents the bug)
- rewind#1 (exclude cR1): last toolGroup skipping cR1's group (R1) = R2@[8,9] → remove [8,9]. m→9.
- rewind#2 (exclude cR2): on reduced m, cR2's group (aR2) already gone → no group excluded; last =
  grep@[6,7] → remove [6,7]. m→[u0, aRead, rRead('BIG-READ-OUTPUT'), aR1, rR1, note, note] (7).
- `expectNoOrphans` ✓; role-correct ✓; non-empty ✓.
- Documentation assertion: `BIG-READ-OUTPUT` is STILL PRESENT (the live path does NOT hide the
  originally-hidden read — the defect the pin fixes).

## 5. Placement & helpers

- PLACE: append a NEW top-level `describe` at EOF (after line 634, the close of the S4 describe).
  Purely additive — no existing line is touched.
- REUSE file-level imports + builders already in pipeline.test.ts: `filterPipeline`,
  `RewindMarkerLike`, `MarkerBundle`, `ProtectedConfig`, `MessageLike`, `BranchEntry`, `user`,
  `asst`, `custom`, `entry`, `mkRewind`, `cfg`, `expectNoOrphans`.
- ADD a LOCAL `resultText(toolCallId, text)` helper inside the S5 describe (the file's `result()`
  helper defaults content to `"..."`; content-bearing results are required for absence assertions).
  The S4 describe already has its OWN local `resultText` — describe-scoped, so no collision; do NOT
  share/hoist (keeps the diff to "appended one describe block").
- `asst(...callIds)` sets `name:'tool'` for every call — fine: only the toolCall `id` matters for
  pairing + pin resolution; the `read`/`grep`/`rewind` labels in the contract are human-readable
  notation, not required toolName values.

## 6. Scope boundaries (NOT touched by S5)

- `src/transforms.ts` — UNCHANGED (S4 shipped the pin arm; S5 is test-only).
- `src/markers.ts`, `src/tools/rewind.ts`, `src/filter.ts`, `src/config.ts` — UNCHANGED.
- All existing tests in pipeline.test.ts (composition §1.9, protectedOk, property/invariant, S1
  carry-through at line 440, S4 pin-resolution describe at line 537) — UNCHANGED.
- NO new src file, NO new helper module, NO new import beyond what pipeline.test.ts already imports.

## 7. Docs impact

Mode A: S5 is a TEST-ONLY addition. It touches INLINE test documentation only (the new describe
block + test names + comments). No README/spec/src change. The changeset-level BUG-002 doc
(design_decisions.md §BUG-002 step 3 "Test: add a content-level regression guard") is satisfied by
this test. README accuracy is the FINAL Mode B task (P1.M5.T1), not S5.

## 8. Gates (verified working)

- `npx tsc --noEmit` → exit 0 (proves the new describe + local resultText helper typecheck; no src
  change so all consumers stay green). **RUN THIS** — `expectTypeOf` is a runtime no-op, so types
  must be checked separately. NOTE: the project has no `typecheck` script; invoke `npx tsc --noEmit`
  directly (verified baseline exit 0).
- `npx vitest run test/pipeline.test.ts` → green (41 existing + 2 new S5 tests = 43).
- `npx vitest run` → green (full suite, 0 regressions; S5 is additive).
- Level 4 (manual:true): scope check — `git diff --name-only` lists EXACTLY `test/pipeline.test.ts`
  (no src file). Confirm the new PIN test FAILS on pre-S4 code by reasoning (the pin field ignored →
  live resolution re-exposes BIG-READ-OUTPUT) — or by temporarily reverting the pin arm.

## 9. Confidence

10/10. Every assertion in both tests was RUN against the live post-S4 code in a spike
(`test/S5_spike.test.ts`) and produced exactly the predicted output (PIN hides both / LIVE re-exposes
the read / pre-fix simulation re-exposes the read). The change is purely additive (one appended
describe block) — it cannot regress the 41 existing pipeline tests or the wider baseline. The
fixture, markers, branchEntries, traces, and assertions are all concrete and spike-verified.
