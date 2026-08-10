# Research notes — P1.M5.T2.S1 (E1–E20 edge-case suite + integration for load-bearing ones)

## Task
Create `test/edge-cases.test.ts` (the CONSOLIDATION + gap-fill pass over spec/08 E1–E20) plus focused
real-`pi -p` integration for the load-bearing edges (E6/E11/E13/E20; E7 is a documented limitation).
Produce README known-limitation content (E7/E15/E18) for P1.M5.T4. This is the definition-of-done
verification tier for the whole matrix; the pairing-invariant randomized property test MUST be included + green.

## Codebase state (verified 2026-08-10)
- Dependency P1.M5.T1.S1 (wiring) is **Complete**: `src/index.ts` is the full SYNC factory; `pi -e ./src/index.ts -p "hi"` exits 0.
- Full suite is GREEN: **600 tests, 19 files** (`npx vitest run` → all pass). `pi 0.84.1` on PATH at `/home/dustin/.local/bin/pi`.
- Spec/08 (E1–E20) is the authoritative input. spec/10 §3 property tests + spec/06 §9 (parallel) + spec/02 (C2/C4/C5/C12) govern behavior.

## Coverage map — what is ALREADY proven elsewhere (T2 = consolidation, not re-derivation)
| Edge | Behavior | Existing coverage (file:line) | T2 role |
|------|----------|-------------------------------|---------|
| E1 | orphan toolResult → plain unit, never hide alone | transforms.test.ts (orphan tests + expectPairingInvariant) | consolidate (named it) |
| E2 | rewind excludes own toolCallId; targets completed turns | transforms.test.ts resolveLastToolCallGroup exclude tests; rewind.test.ts | consolidate |
| E3 | protected message → tool refuses + filter no-ops | tools/rewind.test.ts (to_previous_prompt first user); transforms protectedOk | consolidate |
| E4 | maxDepth → tool refuses | tools/rewind.test.ts (maxDepth) | consolidate |
| E5 | mutation warning (VERBATIM) | tools/rewind.test.ts (MUTATION_WARNING) | consolidate |
| E6 | parallel: keep shared assistant+results, hide previous | transforms.test.ts:166,461-475,584 (assistantIssuedCall skip) | **unit gap-fill + integration note** |
| E7 | compaction leak = bounded/transient LIMITATION | (none — documented) | **assert no-crash + README note** |
| E8 | marker targets nothing → no-op | transforms (resolve null→no-op); rewind.test.ts K=0 | consolidate |
| E9 | note validation refuses | tools/rewind.test.ts (NOTE_INVALID_REASON) | consolidate |
| E10 | checkpoint name/exists refuses | tools/checkpoint.test.ts; tools/rewind.test.ts | consolidate |
| E11 | reload: markers survive, filter re-hides | markers persisted (custom entries); filter readMarkers fresh | **unit + real-pi --session-id integration** |
| E12 | getContextUsage undefined → audit tolerates | tools/audit.test.ts (fallback path) | consolidate |
| E13 | tool/handler throws → fail-open pass-through | filter.test.ts (throwOnGetEntries→undefined); all tools try/catch | **unit + real-pi integration (turn completes)** |
| E14 | config.enabled=false → no-op | index.test.ts; filter.test.ts; all tools tests | consolidate |
| E15 | marker accumulation, no GC → LIMITATION | (none — documented) | **assert cheap/no-crash + README note** |
| E16 | audit before inference → fallback low | tools/audit.test.ts (lastFiltered null→fallback) | consolidate |
| E17 | two shrinks same target → last wins | transforms.test.ts applyShrink last-wins | consolidate |
| E18 | model ignores nudges → advisory LIMITATION | (none — documented) | **assert advisory + README note** |
| E19 | shrink non-toolResult → role preserved | transforms.test.ts applyShrink role-preserve | consolidate |
| E20 | appendEntry→sendMessage land in call order | markers.ts appendRewindMarker→leaveNote sequencing | **unit + real-pi JSONL integration** |

## Property test (spec/10 §3) — ALREADY EXISTS
- `test/pipeline.test.ts:437-525` has the full property suite: pairing-invariant (300 iters, mulberry32 seeded PRNG),
  monotonic shrinkage (300 iters), idempotency (shrinks-only, 200 iters), determinism (200 iters). GREEN.
- T2 requirement: "Pairing-invariant property test (randomized) MUST be included and green." Since it exists &
  is green, T2's `test/edge-cases.test.ts` will INCLUDE a focused self-contained randomized pairing check
  (consolidation) so the edge file is self-sufficient as the DoD gate, and reference pipeline.test.ts.

## Integration design decisions (load-bearing edges)
- **The wired extension has NO test hook for forcing filter exceptions** (E13). Adding one to `src/filter.ts`
  is out of T2's "tests only" scope (and spec/10 §2.1 F-failopen anticipates a test hook = T3's harness).
  → E13 failopen: DEFINITIVE proof at unit level (filter.test.ts throwOnGetEntries→undefined; edge-cases.test.ts
  re-asserts). Real-pi integration = "a normal `pi -p` turn completes with the extension loaded" (filter ran,
  didn't break the turn). Forced-throw end-to-end = T3's F-failopen.
- **The filter is a VIEW transform — it does NOT alter the session JSONL.** So "the model didn't see X" is NOT
  JSONL-provable. JSONL-provable facts: entry TYPES/ORDER (mulligan:rewind=custom, mulligan:note=custom_message,
  mulligan:nudge NEVER persisted), marker persistence across --session-id reopen. View-behavior (the actual hide)
  needs instrumentation (T3's context.fire logging) or model behavior.
  → JSONL-reliable integration: E20 (ordering: rewind-marker BEFORE note, after tool result) + E11 (marker
  survives --session-id reopen). E6/E13 view-behavior = unit-definitive + T3 harness.
- **D8 forbids commands** → spec/10 §2.2's "/mulligan_smoke deterministic fallback" is NOT viable for Mulligan
  (would require registerCommand). Integration is model-driven with explicit prompts (spike-proven: glm-5.2
  honors explicit tool-call instructions) OR pure JSONL inspection.
- `pi --session-id <id>` (creates if missing) + `--session-dir <dir>` exist for E11 pinning. Session file =
  `<timestamp>_<id>.jsonl` under `~/.pi/agent/sessions/--<dashed-cwd>--/`. Glob `*_<id>.jsonl`.

## Boundary with P1.M5.T3 (smoke harness)
- T3 owns the full 9-scenario F-* harness + run-smoke driver + (likely) the filter test-hook for F-failopen,
  and is the authoritative end-to-end integration tier. T3 DEPENDS on T2.
- T2's integration is a focused subset (E20 ordering, E11 persistence) that is reliably JSONL-provable NOW,
  without T3's harness. T2 does NOT build the run-smoke driver or the 9-scenario matrix (that's T3).
- T2 must NOT duplicate T3's deliverables; it consolidates the unit matrix + adds the reliable integration.

## Test patterns to reuse (NO new patterns)
- **Fake pi** (`makePi`): test/tools/rewind.test.ts — captures `appendEntry`/`sendMessage` into arrays; hand-rolled (NO vi.fn).
- **Fake ctx** (`makeCtx`): test/filter.test.ts (sessionManager getSessionId/getEntries/getBranch/buildContextEntries) +
  test/tools/rewind.test.ts (richer: leafId/labels/throwOnBuildContext).
- **Entry builders** (`rewindEntry`/`shrinkEntry`): test/filter.test.ts — exact `type:"custom"` + `data:{schema,v,kind,...}` shape.
- **Message builders** (`user`/`asst`/`asstText`/`res`/`custom`): test/transforms.test.ts + test/pipeline.test.ts (`genMessages`, `mkRewind`, `mkShrink`, `expectNoOrphans`, `mulberry32`).
- **beforeEach/afterEach**: `clearAll()` (runtime reset — nextSeq mutates shared map) + `setConfig(undefined)` (reset config cache) + `setLogFile(null)`. MANDATORY (leakage would flake siblings).
- Import paths use `.js` extensions (ESM convention). `import { describe, it, expect, beforeEach, afterEach } from "vitest"` (globals:true but explicit import is the house style).

## Validation gates (verified commands)
- `npx tsc --noEmit` → exits 0 today.
- `npx vitest run test/edge-cases.test.ts` → new suite (deterministic, fast).
- `npx vitest run` → full suite (currently 600 green; must stay green).
- `pi -e ./src/index.ts -p "<explicit edge prompt>"` → exits 0 (load-bearing integration driving; spike-proven viable).

## Deliverables
1. `test/edge-cases.test.ts` — deterministic E1–E20 unit consolidation + self-contained randomized pairing property + documented-limitation assertions (E7/E15/E18).
2. `test/integration/edge-cases.integration.test.ts` — real-`pi -p` integration for E20 (JSONL ordering) + E11 (marker survives --session-id reopen); robust (beforeAll skips if `pi`/model unavailable).
3. README known-limitation NOTE TEXT for E7/E15/E18 → handed to P1.M5.T4 (this task produces content; T4 owns the README file).
