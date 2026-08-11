# Research notes — P1.M5.T3.S1 (Smoke harness + run-smoke driver + 9 F-* scenarios)

Verified against the live environment on 2026-08-10.

## 1. Situational awareness (task graph)
- P1.M5.T1.S1 (wiring src/index.ts) = **Complete** ✓ (4 tools + 5 handlers, zero-config)
- P1.M5.T2.S1 (edge-cases E1–E20 + E20/E11 real-pi integration) = **Complete** ✓
- **P1.M5.T3.S1 (THIS task)** = Planned — smoke harness + run-smoke + 9 F-* scenarios
- P1.M5.T4.S1 (README/docs, Mode B) = Planned (downstream — owns user-facing docs)
- This is the ONLY PRP being written this session. No batching.

## 2. Environment verification
- `pi --version` → **0.84.1** (on PATH at /home/dustin/.local/bin/pi)
- `npx vitest run` → **635 passed, 2 skipped** (the 2 skipped = test/integration/edge-cases.integration.test.ts gated by RUN_INTEGRATION). Full suite green in 1.37s.
- Wired extension loads zero-config: `pi -e ./src/index.ts -p "hi"` exits 0 (verified by T1).
- Target files do NOT exist yet: `test/integration/smoke.ts`, `test/integration/run-smoke.mjs`, `test/integration/scenarios.md` (only `load.test.ts` placeholder + `edge-cases.integration.test.ts` from T2 are present).
- Current `package.json` smoke script: `pi -ne -e ./src/index.ts -p "hi"` (a LOAD test only — this task repoints it to run the driver).

## 3. The proven architecture (the deliverable is a 3-file test harness)
Inputs the implementer MUST consult (in priority order):
1. **spec/10-testing.md §2** — the canonical contract: the 9-scenario F-* table (§2.1), driving reliability (§2.2), session-JSONL assertions (§2.3).
2. **spec/reference/looper-smoke.proto.ts** — the spike's PROVEN harness template (the original `looper_*` precursor). Adapt the logging-to-JSONL + `pi -e … -p` driving + session-JSONL parsing approach. Rename `looper_*` → `mulligan_*`.
3. **/home/dustin/projects/pi-mulligan/test/integration/{smoke.ts,run-smoke.mjs,scenarios.md}** — the sibling main worktree's COMPLETE, EVOLVED, GREEN reference (read-only oracle per system_context.md §3). This is the single richest source of solved-patterns. Consult for: the helper-extension-loads-2nd observer pattern, the run-smoke orchestrator shape, the SEED-canary determinism flows, the RUN_ID idempotency pattern, the per-scenario assertion functions, and ALL the GOTCHAs below.

### 3.1 `test/integration/smoke.ts` — a Pi HELPER extension (NOT a vitest test)
- Loaded **SECOND** via `pi -e ./src/index.ts -e ./test/integration/smoke.ts …`. Handlers chain in `-e` order, so its `context` handler runs AFTER Mulligan's filter → it sees the **post-filter** messages.
- Its `context` handler is an **OBSERVER ONLY**: returns `void` (NEVER `{messages}`) so it never overrides Mulligan's filter.
- Truncates a smoke JSONL log once at factory time; provides a never-throwing `smokeLog(test, status, detail)` helper (append JSONL line + stderr line).
- `session_start` → log `sessionFile` (so the driver finds the session JSONL) + inject a msg-canary CustomMessage.
- `context` handler logs the spec/10 §2.2 observable set every fire: `{count, msgCanaryPresent, resultCanaryPresent, notePresent, hasRewindMarker, shrunkInContext, hasNudge}`.
- Registers `mulligan_smoke_big` tool (returns a large canary result; NOTE: bloat reminder SKIPS mulligan_* tools — its role is a shrink TARGET, not a bloat trigger).
- Registers `/mulligan_smoke <scenario>` **command** (the deterministic driver). Dispatches per scenario using the REAL tool factories (`makeRewindTool`/`makeShrinkTool`/`makeCheckpointTool`/`auditTool` + `appendRewindMarker` — shared module, same process).

### 3.2 `test/integration/run-smoke.mjs` — plain Node ESM orchestrator (NOT typechecked)
- Per scenario: set `MULLIGAN_SMOKE_LOG`, spawn `pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-<scenario>-<RUN_ID> -p "/mulligan_smoke <scenario>" -p "Reply with exactly: OK"`, parse the smoke log + session JSONL, assert, print PASS/FAIL.
- Exits 0 if all pass, 1 otherwise. Detects "EXTENSION LOAD FAILED" (non-zero pi exit + empty smoke log) distinctly.
- `RUN_ID = ${process.pid}-${Date.now().toString(36)}` — run-scoped --session-id for IDEMPOTENCY (no cross-run JSONL accumulation; F-reload/E11 share it across their 2 spawns WITHIN one run).

### 3.3 `test/integration/scenarios.md` — playbook documenting each scenario

## 4. The 9 scenarios (spec/10 §2.1) + pass criteria
| Scenario | Drive | Pass criteria |
|---|---|---|
| F-rewind-core | SEED model turn → `/mulligan_smoke F-rewind-core` → observing turn | context.fire hasRewindMarker:true + notePresent:true; seed reply HIDDEN on observing inference; JSONL has mulligan:rewind(custom)+mulligan:note(custom_message) |
| F-shrink-persist | `/mulligan_smoke F-shrink-persist` → observing turn | context.fire shrunkInContext:true; JSONL has mulligan:shrink(custom); ORIGINAL canary still on disk (view-substitution, not rewrite) |
| F-shrink-preventive | `/mulligan_smoke F-shrink-preventive` → observing turn | tool.smoke_big logged; JSONL has turn-metric(custom). bloatHit:true is model-driven (SOFT) |
| F-nudge-drift | `/mulligan_smoke F-nudge-drift` → observing turn | config.driftLow logged; JSONL has turn-metric; ZERO mulligan:nudge on disk. hasNudge:true is model-driven (SOFT) |
| F-protected | `/mulligan_smoke F-protected` (only user msg) | tool refuses (crosses first user); pi exit 0; ZERO mulligan:rewind persisted |
| F-maxdepth | `/mulligan_smoke F-maxdepth` | 5 rewinds succeed; 6th refuses with depth msg; JSONL has exactly 5 mulligan:rewind |
| F-checkpoint | SEED_ANCHOR → set checkpoint → SEED_HIDDEN → rewind to 'alpha' → observing turn | label mulligan:checkpoint:alpha exists; checkpoint rewind K>0; post-checkpoint seed hidden + anchor survives |
| F-failopen | `/mulligan_smoke F-failopen` → observing turn (malformed marker appended) | pi exit 0 (turn survived); context.fire logged (filter ran fail-open) |
| F-reload | run1 `/mulligan_smoke F-reload`; run2 same --session-id + observing turn | run-2 context.fire hasRewindMarker:true (marker survived reload); JSONL has mulligan:rewind |

## 5. §2.3 global invariants (asserted for EVERY marker-creating scenario)
- `mulligan:rewind`, `mulligan:shrink`, `mulligan:turn-metric` → type `custom`
- `mulligan:note` → type `custom_message`
- `mulligan:checkpoint:<name>` → type `label`
- `mulligan:nudge` → **NEVER persisted** (ZERO on disk) — the headline DoD invariant (spec/11 §3 #3)

## 6. CRITICAL GOTCHAs (from the oracle — these are the load-bearing discoveries)
- **G1** smoke's `context` handler returns VOID (observer only — NEVER `{messages}`, which would override Mulligan's filter).
- **G2** Print mode (`pi -p`) does NOT drain a followUp queued from inside a `/cmd` dispatch → use a SECOND `-p` prompt to trigger the observing turn + persist the session JSONL (Pi only flushes the session file once an assistant message exists).
- **G3** `mulligan_*` tools SKIP the bloat reminder (src/nudges.ts). A tool RESULT canary needs a real model tool call (ReadonlySessionManager has no mutator — cannot synthesize a toolResult). Use scenario-specific canaries.
- **G5** Role-gate canary detection on `role:"assistant"` (the user PROMPT also contains the canary text, so a naive includes() matches the prompt, not the reply).
- **G6** `.js` extensions for ESM Bundler imports of sibling src/ modules.
- **G7** jiti gives EACH extension its OWN module cache → `setConfig`/`setLogFile` in smoke.ts mutate a DIFFERENT config.ts/log.ts instance than Mulligan's. Smoke OBSERVES via its OWN context handler + drives scenarios via the REAL tool factories (which are stateless closures capturing `pi` — work regardless of module-cache identity).
- **G8** SEED canary string literals MUST be byte-identical between smoke.ts and run-smoke.mjs (there is NO shared module between a jiti-loaded .ts extension and a Node .mjs script). A mismatch → seed never matches → K=0 → fail.
- **G9** The filter.ts handler-never-throws UNIT test (test/filter.test.ts) is the AUTHORITATIVE failopen proof. F-failopen verifies pass-through END-TO-END (turn survives + context.fire logged).
- **G12** Detect EXTENSION LOAD FAILED: non-zero pi exit + empty smoke log → src/index.ts failed to load (report distinctly from a scenario-assertion failure).

## 7. The SEED-canary determinism strategy (makes hiding assertions deterministic)
A plain 2-prompt flow gives K=0 for F-rewind-core/F-checkpoint (nothing after the last user message at command time). The SEED flow prepends a deterministic model turn (`-p "Reply with exactly: <SEED>"`) that commits a hideable assistant message BEFORE the `/mulligan_smoke` command:
- **F-rewind-core**: 3-prompt flow `[Reply SEED_HIDDEN, /mulligan_smoke F-rewind-core, Reply OK]`. The rewind pins the seed reply (K≥1); the observing inference shows it HIDDEN.
- **F-checkpoint**: 5-prompt flow `[Reply SEED_ANCHOR, /mulligan_smoke F-checkpoint-set, Reply SEED_HIDDEN, /mulligan_smoke F-checkpoint-rewind, Reply OK]`. Checkpoint labels the anchor; rewind hides the post-checkpoint seed.
- This REQUIRES two smoke.ts scenario-name branches (`F-checkpoint-set` + `F-checkpoint-rewind`) that share `currentScenario="F-checkpoint"` so the context-handler hiding assertion fires in both phases.

## 8. D8/C2 constraint — CRITICAL CLARIFICATION
spec/02 D8/C2 forbids `registerCommand` in **Mulligan's production extension (src/index.ts)** — Mulligan ships NO human commands. BUT the `/mulligan_smoke <scenario>` command lives in the **TEST helper extension (test/integration/smoke.ts)**, which is a separate test artifact, NOT Mulligan proper. spec/10 §2.2 EXPLICITLY calls for this deterministic-command fallback. The T2 PRP's "don't register /mulligan_smoke" was scoped to T2's deliverables (edge-cases tests only). THIS task MUST build it — in the helper extension. The grep gate `grep registerCommand src/index.ts` must STILL print nothing (src/index.ts is untouched by this task).

## 9. Scope boundaries (coordinate, don't duplicate)
- **THIS task OWNS**: test/integration/smoke.ts + run-smoke.mjs + scenarios.md + package.json smoke-script repoint + (property tests already exist — verify only).
- **T2 already shipped**: test/integration/edge-cases.integration.test.ts (E20 JSONL ordering + E11 marker-survives-reopen, gated RUN_INTEGRATION). DON'T duplicate; note the overlap (F-reload≈E11 persistence; F-failopen≈E13 forced-throw) and that T3 adds the context.fire VIEW instrumentation + the broader 9-scenario matrix.
- **P1.M5.T4 owns**: README.md (Mode B docs). This task does NOT edit README.
- **Property tests (spec/10 §3)**: ALREADY GREEN — test/pipeline.test.ts (pairing 300 iters, monotonic, idempotency, determinism, seeded mulberry32) + test/edge-cases.test.ts (self-contained property block). Task says "add if not already present" → they ARE present → NO new property tests required (verify + note).

## 10. Source API surface (verified exports — for smoke.ts to drive the REAL tools)
- `makeRewindTool(pi)` / `makeShrinkTool(pi)` / `makeCheckpointTool(pi)` → ToolDefinition (factories capturing pi). `auditTool` plain const.
- `appendRewindMarker(pi, ctx, data: RewindMarkerInput): string | null` — RAW wrapper (bypasses tool depth guard — used for F-maxdepth's 5 rewinds via tool, and E15's 50 via raw wrapper).
- `RewindMarkerInput = Omit<RewindMarker, "schema"|"v"|"kind"|"id"|"seq"|"ts">`.
- Tool execute signature: `execute(toolCallId, params, signal, onUpdate, ctx)`. Refusals encoded in result text ("Mulligan: refused — …").
- `defineTool` + `ExtensionCommandContext` + `ExtensionContext` + `ExtensionAPI` all root-exported from `@earendil-works/pi-coding-agent`. `registerCommand(name, {description, handler})` confirmed in types.d.ts:903.

## 11. Validation gates (verified working in this env)
- `npx tsc --noEmit` — smoke.ts typechecks (tsconfig include ["src","test"]; .mjs NOT typechecked — correct, it's plain Node).
- `npx vitest run` — full suite stays green (smoke harness is NOT a vitest test; it's a separate spawned-pi harness).
- `node test/integration/run-smoke.mjs` (repointed `npm run smoke`) — HEADLINE gate: all 9 F-* scenarios green against real pi 0.84.1.
- mulligan:nudge JSONL grep returns 0 across all scenarios (the §2.3/DoD #3 invariant).

## 12. Residual risk / confidence
- The architecture is PROVEN (oracle is green; spike proved every primitive). The implementer adapts a working reference + a spec — low feasibility risk.
- Model-dependent scenarios (F-shrink-preventive bloatHit, F-nudge-drift hasNudge) are asserted SOFT (deterministic path proves the surrounding invariants; model-driven path documented in scenarios.md). This matches spec/10 §2.2 ("deterministic-command fallback for scenarios that don't need model judgment").
- One environment dependency: `npm run smoke` spawns real `pi -p` which needs a working default model/API key (the gate env has one — T1 verified `pi -e ./src/index.ts -p hi` exits 0).
