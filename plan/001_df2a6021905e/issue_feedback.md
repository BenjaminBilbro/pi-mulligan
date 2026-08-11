Fundamental plan contradiction: PRP header says 'NO src/ changes' but L3 gate requires 'all 9 green'. Three F-* scenarios (F-rewind-core, F-protected, F-checkpoint) fail due to pre-existing src/ bugs that the smoke harness correctly detects:

1. F-rewind-core (SEED leak): src/transforms.ts lacks `resolvePinnedHide` + `hideEntryIds` support (BUG-001/002). The oracle has a `resolvePinnedHide` function (~80 lines) that maps pinned entry IDs to message indices for stable hiding; the hack's transforms.ts uses only legacy relative resolution which loses alignment when new messages arrive.

2. F-protected (refusal missing): src/tools/rewind.ts lacks the step-5b protected-refusal check (oracle lines 561-574). When to_previous_prompt=true would cross the first/only user message, the oracle refuses before persisting; the hack creates a marker with K=0.

3. F-checkpoint (K=0): src/transforms.ts `resolveCheckpoint` has differences in entry→message mapping and unit-snapping logic that cause the checkpoint rewind to find nothing to hide.

The smoke harness files are byte-identical to the oracle (except run-smoke.mjs needs `-ne` to avoid global pi-mulligan tool-name conflicts). The harness is working correctly — it detects real regressions. To achieve L3 'all 9 green', the 3 src/ files must be synced from the oracle (~493-876 lines of diff per file), which violates the 'NO src/ changes' constraint.

Resolution: Either (a) relax L3 to 'all scenarios run and produce correct assertions (harness working)' accepting that bug-detection is the harness's job, or (b) permit src/ sync from oracle to fix the 3 known bugs.