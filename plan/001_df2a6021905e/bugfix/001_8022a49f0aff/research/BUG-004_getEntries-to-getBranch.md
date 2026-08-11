# BUG-004 Research Notes — getEntries() → getBranch() (branch scoping)

## The bug
`getEntries()` returns the raw append-only stream across **EVERY branch** (incl. abandoned
siblings after `/tree` navigation). `getBranch()` returns only the **current branch** (leaf→root
path). Four marker/label reads use `getEntries()`, so sibling-branch markers/labels leak into
the active branch's filter/tools.

## The 4 leak sites (verified, exact file:line)
1. `src/filter.ts:106` — `readMarkers`: `entries = ctx.sessionManager.getEntries();`
2. `src/tools/rewind.ts:210` — `countRewindMarkers`: `entries = ctx.sessionManager.getEntries();`
3. `src/tools/rewind.ts:247` — `checkpointExists`: `entries = ctx.sessionManager.getEntries();`
4. `src/tools/audit.ts:563` — `listCheckpoints` CALL SITE:
   `ctx.sessionManager.getEntries() as unknown[]`.
   (`listCheckpoints` itself is a PURE fn taking `entries[]` — src/tools/audit.ts:309 —
   UNCHANGED; only its caller swaps the source.)

## Order-insensitivity (why no reordering needed) — verified per consumer
- `readMarkers`: buckets by (customType, kind); picks latest metric by `seq`. Order-insensitive.
- `countRewindMarkers`: counts `type==="custom" && customType==="mulligan:rewind"`. Count, order-insensitive.
- `checkpointExists`: walks entries to discover candidate `label` targetIds, then resolves
  latest-wins via `ctx.sessionManager.getLabel(id)` (the authoritative latest-wins source).
  The raw walk is ONLY for candidate discovery → order-insensitive.
- `listCheckpoints`: builds its OWN latest-wins labelMap internally, then emits active
  checkpoints in first-occurrence order. Order-insensitive w.r.t. source.

`getBranch()` ordering is leaf→root (verified: session-manager.d.ts:261 "Walk from entry to
root, returning all entries in path order"). Since all four consumers are order-insensitive,
leaf→root vs root→leaf is irrelevant to them.

## Type safety — verified
`getBranch` is on `ReadonlySessionManager` (session-manager.d.ts:140 Pick includes it), so
`ctx.sessionManager.getBranch()` compiles with NO type change. `getBranch(fromId?):
SessionEntry[]`. The four sites either iterate generically (unknown[]) or assign to `unknown`
then `Array.isArray`-guard — no narrowing change needed.

## DO-NOT-TOUCH sites (correct as-is, confirmed)
`getBranch().slice().reverse()` reverses leaf→root → root→leaf for ORDER-SENSITIVE consumers
(message-position walks). These must stay:
- `src/filter.ts:183` — contextHandler passes `branchEntries` (root→leaf) to filterPipeline
  (resolveCheckpoint walks root→leaf).
- `src/tools/rewind.ts:279` (resolvePreview) — builds the advisory snapshot root→leaf.
- `src/tools/audit.ts:519` — builds the audit branch root→leaf.

## Test impact (verified by grep + reading each fake)
Five test files have a hand-rolled `makeCtx` fake whose `getEntries` feeds markers/labels to
the now-changed readers. After the switch those readers call `getBranch`, so the fakes must
make `getBranch()` return the marker-bearing array.

Affected fakes (all currently default `branch = opts.branch ?? []`):
- `test/filter.test.ts` — `makeCtx` (~line 41)
- `test/drift_nudge.test.ts` — `makeCtx` (~line 34)
- `test/edge-cases.test.ts` — `makeCtx` (~line 86)
- `test/tools/rewind.test.ts` — `makeCtx` (~line 100)
- `test/tools/audit.test.ts` — `makeCtx` (~line 62)

**Minimal consistent fix:** in each fake, default `getBranch` to return `entries` when no
explicit `branch` opt is passed, i.e. `const branch = opts.branch ?? entries;` (replacing
`opts.branch ?? []`). One line per fake; the majority of tests that set `entries` and never
touch `branch` keep working automatically.

### Targeted per-test fixes (tests that explicitly set `branch` AND need markers/labels found)
- `test/filter.test.ts` test (n) "branchEntries reversal" (~line 466): sets
  `entries:[rewindEntry]` + `branch: branchLeafToRoot` (no rewind marker in branch).
  readMarkers now reads branch → marker missing → breaks. Fix: merge the rewind marker into
  the branch array too: `branch: [...branchLeafToRoot, rewindEntry(1,{granularity:"checkpoint",checkpoint:"my-cp"})]`.
  (readMarkers is order-insensitive, so appending is fine.)
- `test/filter.test.ts` test (m) "C12 fresh-read" (~line 405): overrides `getEntries` via a
  mutable array; must ALSO override `getBranch` to return the same mutable array.
- `test/filter.test.ts` "NEVER throws when getEntries throws" (~line 175): readMarkers now
  reads getBranch; update to `throwOnGetBranch: true` (the fake already supports it).
- `test/edge-cases.test.ts` "contextHandler with throwOnGetEntries" (~line 665): stale
  comment only (test still passes — getBranch default [] → no markers → round-trip). Update
  the comment to reflect readMarkers reads getBranch.
- `test/tools/rewind.test.ts` checkpoint-success (~line 436): `entries:[label], branch:[]`.
  After switch, checkpointExists reads getBranch → empty → label missing → REFUSAL (breaks).
  Fix: merge label into branch, e.g. `branch: [checkpointLabelEntry("my-cp","entry-5")]`
  (resolveCheckpoint tolerates a label-only branch → k=0, still succeeds; test doesn't assert k).

### Unaffected (verified — raw-stream assertion reads, not reader-driven)
- `test/markers.test.ts` — getEntries used to assert persisted markers in raw stream (append*
  read-back). Not readMarkers-driven.
- `test/index.test.ts:18` — `getEntries: vi.fn(()=>[])` returns empty; no markers either way.
- `test/integration/smoke.ts:369` — reads getEntries for raw-stream assertions only.

## New branch-isolation test (the deliverable test)
Add to `test/filter.test.ts` (or a focused new file). Mock sessionManager where:
- `getBranch()` returns ONLY branch-B entries (1 rewind + 1 shrink, say).
- `getEntries()` returns A+B (branch-A has extra rewind/shrink + a checkpoint).

Assertions:
1. `readMarkers(ctx)` returns ONLY branch-B rewinds/shrinks (direct — readMarkers is exported).
2. (rewind/depth) `countRewindMarkers` counts only branch-B markers — tested via the rewind
   tool's depth guard: set `maxDepth` so B's count is under the cap but A+B would exceed it;
   assert the tool SUCCEEDS (proves it counted only B). countRewindMarkers is module-private,
   so the behavioral depth-guard path is the idiomatic seam (no export change needed).

Optional extension: assert `listCheckpoints` (audit call site) lists only branch-B checkpoints.

## Baseline (verified 2026-08-11)
`npx vitest run` → **687 passed + 2 skipped** (1 skipped file). The task brief says "635" — the
suite has grown; the authoritative gate is "suite stays green" (no newly-failing tests).

## Validation gates (verified executable)
- typecheck: `npx tsc --noEmit -p tsconfig.json` (strict mode; tsc 5.9.3 present)
- full suite: `npm test` (== `vitest run`)
