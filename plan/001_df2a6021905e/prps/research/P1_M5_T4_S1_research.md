# Research notes — P1.M5.T4.S1 (README + zero-config confirmation + optional pi packaging)

Verified against the live environment on 2026-08-11.

## 1. Situational awareness (task graph)
- P1.M5.T1.S1 (wire src/index.ts) = Complete ✓ — 4 tools + 5 handlers, zero-config.
- P1.M5.T2.S1 (edge-cases E1–E20 + E20/E11 real-pi integration) = Complete ✓.
- P1.M5.T3.S1 (smoke harness + 9 F-* scenarios) = Complete ✓ (per cache; smoke green).
- **P1.M5.T4.S1 (THIS task)** = the Mode B documentation subtask. Depends on ALL of M5.T1–T3.
- This is the ONLY PRP being written this session. No batching.

## 2. The deliverable (CONTRACT OUTPUT)
- **REQUIRED:** `README.md` at repo root (`/home/dustin/projects/pi-mulligan-hack/README.md`). Does NOT exist yet (verified `ls README.md` → no).
- **OPTIONAL:** packaging manifest edits to `package.json` (pi-package keyword + peerDependencies move) per docs/packages.md.
- **NO src/ changes** (the extension is the verified input). **NO new tests.** This is pure Mode B documentation.

## 3. CRITICAL DISTINCTION — v1 (THIS repo) vs the sibling main worktree's POST-SPEC evolution
The sibling `/home/dustin/projects/pi-mulligan/README.md` (275 lines) exists and is excellent STRUCTURALLY, but it documents a **POST-SPEC, evolved** implementation that has DIVERGED from the v1 contract THIS task must ship. DO NOT copy it wholesale. Differences:

| Aspect | v1 (THIS task — spec/05, spec/09, src/) | Sibling README (post-spec evolution — DO NOT copy content) |
|---|---|---|
| Tool count | **4**: rewind, shrink, checkpoint, audit | 5 (+ `mulligan_cancel`) |
| Config knobs | **12** (src/config.ts DEFAULT_CONFIG / spec/09 §2) | ~20 (adds maxRetriesPerPrompt, abortContextFraction, shrink.maxActive/staleAfterFires/notifyMaxChars, bloatThresholdBytesByTool, driftWindowTurns, highWaterFraction) |
| Bloat threshold | single `nudges.bloatThresholdBytes: 8192` | global 16384 + per-tool map |
| Drift nudge | single-turn delta > 3000 | windowed (driftWindowTurns=3) + high-water signal |
| `mulligan_cancel` | DOES NOT EXIST in v1 | documented |

**RULE:** The sibling README is a STRUCTURAL guide only (section headings, install recipes, how to present guarantees/limitations, "Further reading" pattern). For CONTENT (tool descriptions, config table, nudge descriptions, tool count), the canonical sources are:
- **Tool descriptions** → VERBATIM from `src/tools/*.ts` `_DESC` constants (copied below in §5).
- **Config table** → `src/config.ts` `DEFAULT_CONFIG` + `spec/09-configuration.md` §2/§3 (12 knobs).
- **Nudges** → `spec/07-preventive-and-nudges.md` §1 (bloat) + §2 (drift) — exactly TWO, no windowing, no high-water.

## 4. README required content (task contract + spec/11 §3 #6 + spec/11 §2 Step 9)
1. **Overview** — what mulligan is, the name origin, why agents need it, why Pi's existing tools (compaction/head-summarization; `/tree`/`/compact`/`/fork` human-only — proven spec/02 C2) don't solve it.
2. **Installation** — three ways to load:
   - `pi -e ./src/index.ts` (quick test / `-e` / `--extension` flag).
   - Auto-discovery: `.pi/extensions/*.ts` (project-local) or `~/.pi/agent/extensions/*.ts` (global) — supports `/reload`. Repo ships as `src/index.ts`; symlink/copy into the auto-discovery dir, or keep using `pi -e` for dev.
   - **Optional `pi install`** (npm/git/local) per `docs/packages.md`.
   - npm-for-editor-types note (optional; NOT required to run — Pi resolves deps from its own install at runtime via jiti).
   - Requirements: Pi `0.84.x`, Node ESM (`"type":"module"` in package.json).
3. **Configuration** — read `mulligan` from Pi `settings.json` (global `~/.pi/agent/settings.json` + project `.pi/settings.json`, project wins). Lazy/cached/re-read on `/reload`. **Zero-config** emphasis. The 12-knob defaults table. Minimal commented-out example `settings.json`. **Disabling:** `enabled:false` → entire extension no-op (filter passes through; all 4 tools refuse cleanly with `Mulligan: refused — Mulligan is disabled.`).
4. **Tools** — the FOUR tools. For each: the VERBATIM `_DESC` string (as a blockquote — "the agent's documentation, reproduced here") + when-to-use guidance from spec/05.
5. **How it works** — the append-only-tree insight (spec/02), the marker-driven context-filter data flow (rewind/shrink), the two ride-along nudges (zero extra requests), `/tree` as the audit trail. Brief.
6. **Guarantees** — (1) soft-delete/audit trail (hidden never lost; visible in `/tree`); (2) fail-open (every handler/tool try/catch-wrapped; error → logged no-op, never breaks a turn); (3) zero-config + zero extra model requests.
7. **Known limitations** — the four surfaced in the task contract:
   - **E7** compaction may transiently summarize hidden content (bounded/transient; Mulligan reducing context makes compaction fire later).
   - **E15** markers persist with no GC (intentional = audit trail; `maxDepth=5` bounds active rewind markers; cost is disk only, not context).
   - **E18** nudges are advisory (never force behavior; ~25–40 token cost when they fire).
   - **Per-tool-bloat refinement is FUTURE** (system_context.md §7) — v1 uses a single global `bloatThresholdBytes`; per-tool thresholds are a documented post-v1 refinement, NOT shipped.
   - Plus **D6** (no undo — agent rewinds/shrinks are permanent; human recovery via native `/tree`) and **D1** (soft retry only — hidden side effects persist on disk; no replay).
8. **Zero-config confirmation** — `pi -e ./src/index.ts` with NO `mulligan` config works out of the box (all defaults). This is the IMPLICIT TDD acceptance check (spec/11 §2 Step 9). VERIFIED: `pi -ne -e ./src/index.ts -p "Reply with exactly: OK"` → exit 0, model replied "OK".
9. **Decision log → spec/** — "Further reading" section pointing to `spec/SPEC.md` §9 (decision log D1–D8) and the companion docs (spec/05 tools, spec/06 filter, spec/07 nudges, spec/08 edge cases, spec/09 config).
10. **License** — MIT (per spec/SPEC.md). A top-level `LICENSE` file does NOT exist in this repo yet (verified). Creating one is OUT OF the core OUTPUT contract (README.md + optional packaging manifest); the README should state MIT and may reference `./LICENSE`. Creating a LICENSE file is OPTIONAL polish.

## 5. The FOUR v1 tool descriptions — VERBATIM from src/tools/*.ts (copy these into README as blockquotes)
```
REWIND_DESC (src/tools/rewind.ts:129):
"Shed recent context you produced by mistake (a bloated tool result, or a whole wrong-direction turn) and leave yourself a note so you can try again with a clean view. The hidden content disappears from your view permanently (it stays on disk for the human). Costs only a short note. Use granularity 'last_tool_call_group' to undo just the last tool interaction, or 'last_turn' to redo the whole turn from the user's last message."

SHRINK_DESC (src/tools/shrink.ts:93):
"Replace a specific past tool result with a compact summary you provide, in your view, going forward. Use when the call was fine but its output is too big to keep carrying. Unlike rewind, the call stays in context (just with your summary as its result)."

CKPT_DESC (src/tools/checkpoint.ts:57):
"Name the current position so a later mulligan_rewind can jump straight back to it. Use before a speculative sub-task you might want to undo in one shot."

AUDIT_DESC (src/tools/audit.ts:66):
"Show a token breakdown of the context you're currently carrying (what the model actually sees), flag the biggest contributors, and list active Mulligan markers. Use this to decide whether to rewind or shrink."
```
These match spec/05 §5 (the tool registration summary's description strings). The sibling README's tool blurbs are LONGER (post-spec authoring) — do NOT use them; use these exact strings.

## 6. v1 config — the 12 knobs (src/config.ts DEFAULT_CONFIG / spec/09 §2 §3)
| Knob | Default |
|---|---|
| `enabled` | `true` |
| `rewind.enabled` | `true` |
| `rewind.protectedRoles` | `["first:user", "latest:user"]` |
| `rewind.maxDepth` | `5` |
| `rewind.requireMutationWarning` | `true` |
| `shrink.enabled` | `true` |
| `nudges.bloatReminder` | `true` |
| `nudges.perTurnDrift` | `true` |
| `nudges.bloatThresholdBytes` | `8192` |
| `nudges.driftThresholdTokens` | `3000` |
| `audit.estimateConfidence` | `"medium"` |
| `log.file` | `null` |

Validation rules (spec/09 §4): unknown keys ignored; type-mismatched → default + warn; booleans `!!`; numbers finite (`>0` for thresholds); protectedRoles only known selectors; estimateConfidence one of low/medium/high; **never throws.**

## 7. Optional pi packaging (docs/packages.md)
The repo ALREADY has the pi manifest in package.json: `"pi": {"extensions": ["./src/index.ts"]}`. To make it a DISTRIBUTABLE pi package (optional polish):
- Add `"keywords": ["pi-package"]` (gallery discoverability).
- Move pi-bundled deps to `peerDependencies` with `"*"` range (per docs/packages.md "Dependencies"): `@earendil-works/pi-coding-agent`, `typebox` (and `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui` if imported). Currently they're in `dependencies` with `"*"`.
- Install paths (documented in README): `pi install npm:@scope/pkg@ver`, `pi install git:github.com/user/repo@ref`, `pi install ./relative/path`, `pi install /abs/path`. `-l` for project settings; `-e`/`--extension` to try without installing.
- This is OPTIONAL. The REQUIRED deliverable is README.md that DOCUMENTS the `pi install` path; the manifest edits are polish.

## 8. Validation gates (verified working in this env)
- `npx tsc --noEmit` — exits 0 (README is markdown; confirms no src/ breakage).
- `npx vitest run` — 635 green, 2 skipped (no regression; README doesn't affect tests).
- `pi -ne -e ./src/index.ts -p "Reply with exactly: OK"` — **exit 0**, model replied "OK" (VERIFIED 2026-08-11). This IS the IMPLICIT TDD zero-config load test.
- Level 4 (manual): fresh-eyes content attestation that README documents install / 4 tools / config table / soft-delete guarantee / zero-config / known limitations (E7/E15/E18 + future per-tool-bloat) / spec decision-log link.

## 9. Scope boundaries (coordinate, don't duplicate)
- **THIS task OWNS:** README.md (+ optional packaging manifest edits to package.json).
- **T3 already shipped:** test/integration/scenarios.md (the harness playbook — a dev-facing doc). README is the USER-facing changeset-level doc; do NOT duplicate scenarios.md content.
- **Do NOT edit src/.** The extension is the verified input (T1–T3 green).
- **LICENSE file:** does NOT exist. Creating one is OPTIONAL polish (out of the core OUTPUT contract). README states MIT regardless.

## 10. Confidence
- The content is fully specified (spec/05/06/07/08/09 + the shipped src/). The sibling README provides a proven STRUCTURE. The only risk is accidentally importing the sibling's POST-SPEC content (5th tool, 20 knobs) — heavily flagged in §3 above.
- Zero-config load is VERIFIED working. The README is a documentation task with no code risk.
- Confidence: 9/10.
