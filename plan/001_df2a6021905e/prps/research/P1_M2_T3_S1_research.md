# Research Notes — P1.M2.T3.S1 (notes.ts: validateNote + renderNote + renderBloatReminder + renderDriftNudge)

## Task
Implement the FOUR pure note/nudge renderers + the note validator in `src/notes.ts` (replacing the `export {};` stub)
+ its vitest suite `test/notes.test.ts`. The confabulation defense (D17): the structured `mulligan:note` the resumed
model reads, the gate that refuses a vacuous note, and the text of the two ride-along nudges.

## Dependencies (verified Complete + present in THIS repo)
- P1.M2.T1.S1 → `src/tokens.ts` (DONE; style oracle — zero-import pure helper, defensive isRecord/readOwn).
- P1.M2.T2.S1 → `src/ledger.ts` (DONE; exports `FileLedger` at line 50 + `extractFileLedger` + `MessageLike`).
- P1.M1.T2.S1 → `src/config.ts` (DONE; exports `Granularity` at line 8:
  `"last_tool_call_group" | "last_turn" | "checkpoint"`; default `bloatThresholdBytes: 8192`, `driftThresholdTokens: 3000`).

## Type imports the impl needs (type-only — erased at compile, keeps notes.ts Pi-free)
- `import type { FileLedger } from "./ledger.js";`
- `import type { Granularity } from "./config.js";`
Unlike tokens.ts/ledger.ts (PERMANENT zero-imports), notes.ts is the pure-HELPER tier (spec/11 §1) and MAY import
type-only from sibling pure modules. No Pi import, no config-runtime import.

## Oracle (read-only sibling — architecture/system_context.md §3 designates it THE reference)
- `/home/dustin/projects/pi-mulligan/src/notes.ts` (398 lines) — COMPLETE passing impl. Captured in full this session.
- `/home/dustin/projects/pi-mulligan/test/notes.test.ts` (654 lines, ~20 describe blocks).

### Oracle exports (verified via grep)
```
NoteInput           interface { what_happened, avoid, true_current_state, next }   (spec/04 §2.1)
NoteValidation      interface { valid: boolean; reason?: string }
NOTE_INVALID_REASON const = "note fields must all be non-empty"                    (spec/05 §1 step2 / E9, no trailing period)
validateNote(note)  → NoteValidation
DriftNudgeInput     interface { deltaTokens: number|null; bloatHits: ReadonlyArray<{toolName, approxTokens}> }
renderNote(note, ledger, granularity) → string
renderBloatReminder(_toolName, bytes, thresholdBytes) → string
renderDriftNudge(metric) → string
```
Module-private (mirrored from tokens.ts/ledger.ts, reused across S1/S2/S3): `isRecord`, `readOwn`,
`readNoteField`, `readLedgerList`, `bytesToKb`, `kTokens`, `resultWord`, `readDelta`, `readBloatHits`,
`NOTE_FIELDS` (the 4 keys), `LEDGER_BLOCKS` (3 [tag,field] tuples).

## CRITICAL DECISION — validation result shape: `{valid, reason}` (oracle) vs `{ok, error}` (task blurb)
The task description item 3 says `validateNote(note): {ok:boolean, error?:string}`. The proven ORACLE uses
`{ valid: boolean; reason?: string }` with `NOTE_INVALID_REASON`. **Decision: follow the ORACLE
(`{valid, reason}` + `NOTE_INVALID_REASON`).** Rationale:
1. The oracle is the designated read-only reference (architecture/system_context.md §3); matching it lets the
   downstream rewind tool (P1.M4.T1) be reproduced faithfully — it consumes this result.
2. spec/10 §1.8 does NOT pin field names — only behavior ("refuses; structured error, not thrown"). So the shape is
   an implementation detail owned by this task.
3. `NOTE_INVALID_REASON` (exported const) lets the rewind tool reuse the exact literal (DRY) and lets tests pin it.
The PRP documents `ok↔valid`, `error↔reason` so the executing agent is not confused by the blurb's shorthand.

## Spec contracts (verified verbatim against spec/ files this session)
- **spec/04 §2.3 rendered template** (grep-confirmed lines 81–107): sections joined by `\n\n` (blank line):
  `## 🔄 Mulligan rewind (<granularity>)` → `**What happened:** <…>` → `**Avoid:** <…>` →
  `**Current true state:** <…>` → (`<files-read>…</files-read>` omitted iff empty) →
  (`<files-modified>…</files-modified>` omitted iff empty) → (`<bash-side-effects>…</bash-side-effects>` omitted iff empty)
  → `**Next:** <…>`. Block tags mirror Pi compaction convention. granularity interpolated VERBATIM. NO trailing newline.
- **spec/07 §1 renderBloatReminder** (grep-confirmed lines 42–43): leading `\n---\n` (markdown horizontal rule) +
  4-line body: `[mulligan] This result is ~<KB> KB in your context (threshold <T> KB).` / `If you don't need the full
  output going forward, call \`mulligan_shrink\` with a` / `summary, or \`mulligan_rewind(granularity:"last_tool_call_group")\`
  if the whole` / `call was a mistake. (The hidden/shrunk content stays on disk for the human.)`.
  `<KB>`=`bytesToKb(bytes)=Math.round(n/1024)` (8192→8); `<T>`=`bytesToKb(thresholdBytes)`. `toolName` ACCEPTED but NOT
  interpolated in v1 text (`_toolName` prefix, reserved — mirrors tokens.ts `_model`). NO trailing newline.
- **spec/07 §2 renderDriftNudge** (grep-confirmed lines 124–126): 3 lines joined by `\n`. First line VARIES by
  (delta!=null)×(bloat non-empty); 2 tail lines FIXED:
  `If that growth was wasteful, consider \`mulligan_rewind\` (undo the turn) or \`mulligan_shrink\` (compact a result).`
  / `Run \`mulligan_audit\` for a breakdown.`
  First-line cases: delta-only → `Previous turn added ~<k> tokens to your context`; delta+bloat → same + ` and produced
  <N> bloated result(s)`; bloat-only(delta null) → `Previous turn produced <N> bloated result(s)`; both empty →
  `Previous turn changed your context` (unreachable via shouldNudge; totality fallback). `<k>`=`kTokens(delta)=
  Math.round((delta/1000)*10)/10+"k"` (4200→"4.2k", 3000→"3k"); `<N>`=`bloatHits.length`; result(s)=`resultWord(N)`
  (1→result, else results). deltaTokens===null means UNKNOWN (first turn) → delta clause dropped, bloat leads (NOT "~0k").
- **spec/05 §1 step 2 + spec/08 E9**: validate note — all four non-empty after trim; refusal text
  "note fields must all be non-empty". NEVER throws (rewind-tool hot path; structured error not exception).
- **spec/10 §1.8** (grep-confirmed): all 4 present → renders w/ ledger blocks; empty ledger lists → blocks omitted;
  any empty field → validation refuses (structured error, not thrown); snapshot tests for representative notes.
- **architecture/external_deps.md §3.1** (grep-confirmed lines 29–83): notes.ts owns all 4 functions;
  `filterPipeline` (transforms.ts, M2.T6) handles rewinds+shrinks ONLY — nudge injected in filter.ts glue (M3.T2/T3)
  AFTER the pure pipeline. So renderDriftNudge is consumed by `nudges.ts` `injectNudge`, NOT by transforms.ts.

## Downstream consumers (do NOT build here)
- `tools/rewind.ts` (P1.M4.T1): `validateNote` (step 2 gate) + `renderNote` (step 5 → sendMessage content).
- `nudges.ts` (P1.M3.T3): `renderBloatReminder` (tool_result handler appends to content) + `renderDriftNudge`
  (injectNudge constructs the ephemeral `mulligan:nudge` custom message — NEVER persisted).
- `markers.ts` (P1.M3.T1): stores `NoteInput` verbatim into `RewindMarker.note` (spec/04 §3).

## Current repo baseline (verified this session)
- `src/notes.ts` = `export {};` (stub) → REPLACE.
- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → 6 files / 147 tests pass (config 35, log 15, tokens 51, ledger 39, runtime, load).
  Target after this task: 7 files, +~50–60 notes tests, no regression.
- vitest 1.6.1 + typescript ^5 in node_modules — gates run WITHOUT `npm install`.
- Test import convention: `from "../src/notes.js"` (.js mandatory; moduleResolution Bundler → resolves to .ts).
  vitest globals available (tsconfig types include "vitest/globals").

## Oracle test describe blocks (reproduce coverage + exact pinned assertions)
validateNote: pinned contract; every field independently required; non-string/missing→invalid; reason is single
  spec-pinned string; trim doesn't over-reject; defensive never-throws; types.
renderNote: spec/04 §2.3 pinned format; snapshot-style cases; field values AS-IS (no escaping); defensive
  never-throws; types.
renderBloatReminder: spec/07 §1 pinned format; defensive (bad numbers→0 KB); snapshot-style.
renderDriftNudge: spec/07 §2 pinned format (first line varies; tails fixed); rounding & pluralization;
  defensive never-throws; snapshot-style.
types: NoteInput/NoteValidation/DriftNudgeInput shapes + return types via expectTypeOf.

## Gates (verified executable in THIS tree)
- L1: `test -f src/notes.ts -a -f test/notes.test.ts`
- L2: `npx tsc --noEmit`
- L3: `npx vitest run test/notes.test.ts`
- L4: `npx vitest run` (full suite — no regression) — actually make this the full-suite gate; manual scope checks via
  success criteria (per G1.2 scope boundaries are NOT shell gates).

## Confidence: 10/10
Fully deterministic contract + a verified passing reference impl (oracle notes.ts 398L + test 654L) + both
type-only deps (FileLedger, Granularity) present + green baseline. No inference required.

## DOCS impact
No per-item documentation file — M2 tasks are pure helpers; whole-feature README is Mode B changeset-level
documentation in P1.M5.T4. (Mirrors the ledger PRP's DOCS handling.)
