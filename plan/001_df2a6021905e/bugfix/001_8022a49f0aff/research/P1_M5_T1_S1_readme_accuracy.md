# Research — P1.M5.T1.S1 (README accuracy pass + BUG-fix summary)

> Mode B changeset-level documentation task. NO code changes — `README.md` only.
> Final gate before declaring P1 Complete. Depends on all M1–M4 implementing subtasks.

## 0. Task contract (verbatim from tasks.json `P1.M5.T1.S1.context_scope`)
- §3: confirm "loaded lazily … re-read on /reload" + the Disabling claim now match behavior
  (post-M1). Cross-check `test/integration/disabled-config.test.ts`.
- Add a ONE-LINE note: project-local settings require a trusted project (`isProjectTrusted`).
- §6: IF it quotes the audit Suggestion → update to role-aware wording (P1.M3.T3.S1).
- Add/append a short "Bug fixes"/changelog section: all 8 BUG IDs, one line each, BUG-00x → fix.
- Do NOT invent new features or knobs. Keep tone consistent with the existing README.

## 1. Dependency status — ALL SHIPPED (verified by reading src/ + execution-summaries)
| Dep | Milestone | BUG | What landed (the fix the README must reflect) |
|----|-----------|-----|-----------------------------------------------|
| P1.M1.T2.S2 | M1 config wiring | BUG-001 + BUG-006 | `src/index.ts` factory calls `setConfig(loadMulliganSettings({}))` at load; `session_start` (fires on /reload) calls `setConfig(loadMulliganSettings({cwd, isTrusted: ctx.isProjectTrusted()}))`. Every knob now honored. Headline proof = `test/integration/disabled-config.test.ts` (writes `{"mulligan":{"enabled":false}}` to tmp `.pi/settings.json`, asserts all 4 tools refuse `Mulligan: refused — Mulligan is disabled.` + context pass-through). |
| P1.M2.T1.S5 | M2 targeting | BUG-002 | `filterPipeline` resolves each rewind against pinned `hideEntryIds` (captured at creation); a later rewind can no longer retarget an earlier one → originally-hidden content stays hidden (success criterion #4). |
| P1.M2.T2.S2 | M2 protection | BUG-003 | `protectedOk` enforces `latest:user`; rewind tool refuses a `checkpoint` rewind that would hide the latest user message. |
| P1.M3.T1.S1 | M3 scoping | BUG-004 | marker/label reads use `getBranch()` (current branch) not `getEntries()` (all branches) → no cross-branch leakage after `/tree`. |
| P1.M3.T2.S1 | M3 integrity | BUG-005 | rewind tool null-checks marker id; refuses + skips note when persist failed (no false success). |
| P1.M3.T3.S1 | M3 audit polish | BUG-008 | `renderAuditReport` Suggestion line is role-aware (toolResult→shrink; assistant→rewind/shrink; non-tool→"no Mulligan operation applies"). |
| P1.M4.T3.S1 | M4 smoke | BUG-007 | smoke harness makes bloat-hit/drift-nudge/seed-hiding assertions GATING (HARD); marks `F-retrycap`/`F-abortfraction` out-of-scope (their knobs are not in v1). |

## 2. README current state — line-precise findings (grep-verified 2026-08-11)
- **§3 Configuration** (header `## 3. Configuration` @ L75).
  - L77: *"…the project-local `.pi/settings.json` (project-local overrides global). It is loaded lazily on first use, cached for the session, and re-read on `/reload`."* — **now TRUE** post-M1 (factory load + session_start re-read). The task author confirmed it matches; cross-check = `disabled-config.test.ts`. **No rewrite needed** — CONFIRM only.
  - `#### Disabling` block @ L122–125: exact refusal wording `Mulligan: refused — Mulligan is disabled.` (em-dash U+2014) — **now TRUE**; this string is asserted verbatim by `disabled-config.test.ts`. CONFIRM.
  - **MISSING**: no mention that project-local settings require a trusted project. `src/settingsLoader.ts:105` reads local ONLY when `opts.isTrusted === true`. → ADD one-line note.
- **§4 Tools → `mulligan_audit`** (L177–183): describes the report but does **NOT** quote the `Suggestion:` line. No edit needed here for BUG-008 (the wording lives in code, surfaced only when the agent runs the tool).
- **§6 Guarantees** (L227–231): Soft-delete / Fail-open / Zero-config. Does **NOT** quote the audit Suggestion. → the task's "§6 (if it quotes the audit Suggestion)" condition is **NOT met** → **no §6 edit required** for BUG-008. (If any quote is found during the end-to-end read, update it to the role-aware form; verified none exists today.)
- **No "Changelog" section exists** (`grep '^## Changelog' README.md` → empty). README ends: §7 Known Limitations (L235) → §8 License (L248) → `## Further reading` (L254). → APPEND a new `## Changelog` section at EOF (lowest churn; "append" matches the contract).

## 3. Exact landed wording to mirror (so the changelog + notes are accurate)
- Disabling refusal (verbatim, em-dash): `Mulligan: refused — Mulligan is disabled.`
- session_start re-read (src/index.ts):
  `setConfig(loadMulliganSettings({ cwd: ctx.cwd, isTrusted: ctx.isProjectTrusted() }));` — runs for EVERY session_start reason (startup|reload|new|resume|fork) → fixes BUG-006 in the same change as BUG-001.
- settingsLoader trust gate (src/settingsLoader.ts:105): `if (opts?.isTrusted === true && typeof opts?.cwd === "string") { … read local … }`
- audit role-aware Suggestion (src/tools/audit.ts:474–482): branches on `rows[0].role`:
  - `toolResult` → `Suggestion: the \`${label}\` result is the largest contributor. Consider mulligan_shrink.`
  - `assistant` → `Suggestion: the assistant turn \`${label}\` is the largest contributor. Consider mulligan_rewind (last_tool_call_group) or mulligan_shrink.`
  - else → `Suggestion: the largest contributor is the \`${label}\` message (role: \`${role}\`); no Mulligan operation applies to a non-tool message.`

## 4. BUG→fix one-liners (ready to drop into the changelog)
- **BUG-001** (critical, inert config) → wired a disk-reading `settingsLoader` + `setConfig` at factory load and on every `session_start`; every documented knob is now honored.
- **BUG-002** (critical, stacked rewinds re-exposed hidden content) → each rewind now pins its target entry ids at creation; the filter resolves against the pin, so a later rewind can no longer retarget an earlier one.
- **BUG-003** (major, checkpoint could hide the latest user message) → `latest:user` is now enforced (`protectedOk` + a tool-layer guard); a checkpoint rewind that would cross it is refused.
- **BUG-004** (minor, cross-branch marker leakage) → marker/checkpoint reads now use the current branch (`getBranch()`) instead of all branches (`getEntries()`).
- **BUG-005** (minor, false success on persist failure) → the rewind tool now null-checks the persisted marker id and refuses (with no stray note) when persist failed.
- **BUG-006** (minor, `/reload` did not re-read config) → `session_start` (which fires on `/reload`) now re-reads settings and calls `setConfig`.
- **BUG-007** (minor, smoke SOFT coverage) → the smoke harness now makes the bloat-hit, drift-nudge, and seed-hiding assertions GATING, and marks the unimplemented `F-retrycap`/`F-abortfraction` scenarios out-of-scope.
- **BUG-008** (cosmetic, audit Suggestion) → the `mulligan_audit` Suggestion line is now role-aware.

## 5. Validation (verified working 2026-08-11)
- `npm test` → **697 passed | 2 skipped** (1.72s). GREEN. Includes `test/integration/disabled-config.test.ts` (the §3 "Disabling" proof).
- `npx tsc --noEmit` → EXIT 0 (README change won't affect, but confirms tree compiles).
- No markdown linter installed (`markdownlint` absent) → content gates are `grep`-based.
- Positive-content `grep -q` gates are allowed (G1.1 only forbids negated file/dir existence).

## 6. Anti-scope reminders (do NOT do these)
- Do NOT invent new config knobs, tools, or features (the README must describe shipped behavior only).
- Do NOT delete/move pipeline-state files (PRD §5.1): `PRD.md`, any `PRP.md`, anything under `plan/`.
- Do NOT edit `src/` — this is a README-only task.
- Do NOT renumber existing README sections unless absolutely necessary (prefer appending `## Changelog` at EOF to minimize churn).
