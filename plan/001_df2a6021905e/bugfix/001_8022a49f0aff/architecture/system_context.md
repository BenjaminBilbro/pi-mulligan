# System Context — Mulligan Bugfix (TEST_RESULTS.md mini-PRD)

## What Mulligan is

`pi-mulligan-hack` is a pi coding-agent **extension** (loaded via `pi.extensions` → `src/index.ts`).
It gives the agent a context "mulligan": the ability to **rewind** (hide recent context it
produced by mistake), **shrink** (substitute a bloated result with a summary), **checkpoint**
(label a point to rewind back to), and **audit** (token breakdown of the filtered view). Hidden
content is a *permanent soft-delete from the model's view* — it stays on disk for the human.

## Architecture tiers (confirmed by reading src/)

| Tier | Files | Role |
|---|---|---|
| **Pure / Pi-FREE** | `transforms.ts`, `tokens.ts`, `ledger.ts`, `notes.ts`, `config.ts` | Zero imports from Pi. Fully unit-testable. The correctness heart is `transforms.ts` (`filterPipeline` + resolvers + `protectedOk`). |
| **Pi-coupled glue** | `filter.ts`, `markers.ts`, `runtime.ts`, `log.ts`, `nudges.ts` | Thin wrappers around `ctx.sessionManager` / `pi.appendEntry` etc. |
| **Agent tools** | `tools/rewind.ts`, `tools/shrink.ts`, `tools/checkpoint.ts`, `tools/audit.ts` | typebox-schema'd, validation-owning, fail-open (never throw — E13). |
| **Wiring** | `index.ts` | Default-export factory: registers 4 tools + 5 event handlers. |

**Key invariant:** `filterPipeline` (transforms.ts) is PURE — it takes `(messages, markers, config, branchEntries)` and returns a new array. The `context` event handler (`filter.ts:contextHandler`) is thin glue: getConfig → readMarkers → getBranch → filterPipeline → cache → return `{messages}`. All fail-open (E13).

## Confirmed bug locations (all 8 validated against source)

| Bug | Severity | Root cause file(s) | Confirmed symptom |
|---|---|---|---|
| BUG-001 | critical | `index.ts`, `config.ts` | Factory never calls `setConfig`; never reads any `settings.json`. `getConfig()` returns `validateConfig(undefined)` = DEFAULT_CONFIG. **Every documented knob is inert.** |
| BUG-002 | critical | `transforms.ts` (`filterPipeline` re-resolves each rewind LIVE; `resolveLastToolCallGroup` skips only the *current* rewind's own callId) | A second `last_tool_call_group` rewind re-targets the first rewind's resolution → originally-hidden span reappears. |
| BUG-003 | major | `transforms.ts` (`protectedOk` enforces only `first:user`), `tools/rewind.ts` (step-5b guard covers only last_turn/nuclear) | `checkpoint` rewind can delete the protected latest user message (`latest:user` never enforced). |
| BUG-004 | minor | `filter.ts` (`readMarkers`), `tools/rewind.ts` (`countRewindMarkers`, `checkpointExists`), `tools/audit.ts` (`listCheckpoints`) | All scan `ctx.sessionManager.getEntries()` (EVERY branch) instead of `getBranch()` (current branch). `/tree` navigation leaks sibling-branch markers. |
| BUG-005 | minor | `tools/rewind.ts` execute step 7 | `appendRewindMarker` returns `null` on failure but the tool does NOT null-check → proceeds to `leaveNote` + returns success text. Silent correctness failure. |
| BUG-006 | minor | `index.ts` `session_start` handler | Only calls `resetRuntime(...)`; never re-reads settings/config on `/reload`. |
| BUG-007 | minor | `test/integration/smoke.ts`, `test/integration/scenarios.md` | F-rewind-core, F-checkpoint, F-shrink-preventive, F-nudge-drift headline assertions are SOFT/model-driven-only. F-retrycap/F-abortfraction reference unimplemented config knobs. |
| BUG-008 | cosmetic | `tools/audit.ts` `renderAuditReport` | Suggestion line hard-codes `"...result is the largest contributor. Consider mulligan_shrink."` even when rows[0] is a user/assistant message. |

## Spec contracts that are VIOLATED by these bugs

- **spec/09 §1** ("Mulligan reads a `mulligan` object from Pi's `settings.json`... loaded lazily... re-read on `/reload`") → BUG-001 + BUG-006.
- **spec/06 §11** (composition example: two rewinds each shed their own tool group; both hidden, both confirmations survive) + **success criterion #4** ("Hidden content is never silently lost") → BUG-002.
- **spec/06 §8** / **spec/08 §8** (`latest:user` is a protected role: "a rewind that would remove the latest user message ... is refused") → BUG-003.
- **spec/02 C12** (read fresh from getEntries each invocation) — readMarkers uses getEntries, but the *correct* source for "current branch" markers is `getBranch()`; BUG-004.
- **README §3** ("`enabled: false` → all four tools refuse cleanly with `Mulligan: refused — Mulligan is disabled.`") → BUG-001 (false claim today).
- **spec/05 §4** (audit Suggestion — only meaningful for a toolResult carrier) → BUG-008.

## Baseline state (confirmed this session)

- `npm test` (vitest): **635 passed | 2 skipped** (1 file skipped). GREEN.
- `npm run smoke`: PRD reports 9/9 deterministic pass (not re-run this session; the SOFT caveats are the BUG-007 scope).
- TypeScript: no separate build step; pi loads `src/index.ts` via jiti (ESM, `.js` import specifiers).
- The `RewindMarker` type (markers.ts) and `RewindMarkerLike` (transforms.ts) both already carry a code comment *"NO `hideEntryIds` — that's a later fix task"* — i.e. the codebase ANTICIPATES the pinned-target field that BUG-002 needs.

## Dependency / ordering graph for the fixes

```
BUG-001 (config wiring) ──┬──> standalone (index.ts + config.ts + a new loader helper)
BUG-006 (/reload) ────────┘    (BUG-006 is the reload half of the SAME wiring; fix together)

BUG-002 (pinned targeting) ───> transforms.ts (resolver + filterPipeline) + markers.ts (field) + tools/rewind.ts (capture) + pipeline.test.ts (content assertion)
                                INDEPENDENT of BUG-001.

BUG-003 (latest:user) ────────> transforms.ts (protectedOk) + tools/rewind.ts (checkpoint guard) + pipeline.test.ts
                                INDEPENDENT; touches the same protectedOk fn as nothing else.

BUG-004 (branch scoping) ─────> filter.ts + tools/rewind.ts + tools/audit.ts (getEntries→getBranch). INDEPENDENT.

BUG-005 (null-check) ─────────> tools/rewind.ts step 7. INDEPENDENT (tiny).

BUG-007 (smoke determinism) ──> test/integration/smoke.ts + scenarios.md. DEPENDS on BUG-001 (config load
                                makes threshold-lowering testable) and BUG-002 (pinned targets make
                                last_turn/checkpoint seed-hiding deterministic). Run AFTER those land.

BUG-008 (audit suggestion) ───> tools/audit.ts renderAuditReport + audit.test.ts. INDEPENDENT (tiny).
```

**Critical sequencing note:** BUG-007's whole premise (deterministic coverage for the SOFT scenarios) is only achievable *after* BUG-001 (so config knobs like `driftThresholdTokens` can be lowered deterministically) and BUG-002 (so pinned last_turn/checkpoint targets hide deterministically). So BUG-007 must come last.
