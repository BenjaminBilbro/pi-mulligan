# Research notes — P1.M2.T2.S1 (extractFileLedger)

## Work item
`src/ledger.ts` — pure, deterministic `extractFileLedger(messages, range)` that classifies the tool
calls in a rewound span into `{ readFiles, modifiedFiles, bashSideEffects }`, de-duplicated + sorted.
Feeds `notes.renderNote` (P1.M2.T3) + stored in the rewind marker (P1.M3.T1); drives the
requireMutationWarning (P1.M4.T1). NO Pi dep. IMPLICIT TDD: `test/ledger.test.ts`.

## Dependency graph (tasks.json)
- `P1.M2.T2.S1` status Planned, deps `[P1.M1.T1.S1]` (the scaffold — Complete). The `src/ledger.ts`
  slot already exists as an `export {};` stub. No other M2 task blocks this (tokens P1.M2.T1.S1 is
  Complete and independent — ledger imports nothing from it).
- Downstream consumers (NOT this task): notes.renderNote (P1.M2.T3) imports `FileLedger`; the rewind
  tool (P1.M4.T1) calls `extractFileLedger` over the resolved target span preview; RewindMarker.ledger
  field (spec/04 §3) stores it.

## The verified oracle (read-only sibling)
`/home/dustin/projects/pi-mulligan/src/ledger.ts` (~310 lines) + `test/ledger.test.ts` (39 tests, GREEN).
Per `architecture/system_context.md §3` this is the authoritative read-only reference impl. Reproduce
its public surface + behavior verbatim, adapted to ship as ONE module.

## Contract resolution decisions (the oracle's choices — adopt them)
1. **INPUT shape** = `(messages: MessageLike[] | null | undefined, range: number[] | null | undefined)`.
   The contract offered two options ("tool-call descriptors array OR AgentMessage[]"); the oracle picks
   **AgentMessage[] + a `range` of message INDICES**. `range` is NOT a [start,end) tuple — it is the
   `Unit.indices` number[] the rewind resolver (P1.M2.T4 transforms) produces (which includes BOTH the
   assistant message AND its toolResult messages). ledger filters to `role==="assistant"` only, since
   only assistant messages carry `toolCall` content blocks. Document this; the rewind tool MUST produce
   this shape.
2. **OUTPUT** = `FileLedger { readFiles: string[]; modifiedFiles: string[]; bashSideEffects: string[] }`
   (spec/04 §2.2 — field names are load-bearing, consumed by renderNote + marker).
3. **Exports**: `extractFileLedger`, `FileLedger`, `MessageLike` (+ module-private `ToolCallContent`,
   `ContentBlock`). `MessageLike` is EXPORTED so tests + tools/rewind.ts can type inputs (like tokens.ts).

## The classification rules (spec/04 §2.2 + spec/10 §1.6 pinned example)
- **readFiles** = union of `path ?? file_path` args from tool calls whose `name` ∈ {read,grep,rg,glob}.
  Oracle ADDS `find` and `ls` (Pi's ACTUAL read-only discovery tools — there is no `glob`/`rg` tool in Pi).
- **modifiedFiles** = union of `path ?? file_path` from {write,edit} + high-confidence bash write paths.
- **bashSideEffects** = bash commands NOT provably read-only (verbatim), "when in doubt, INCLUDE".
- **Pinned example** (spec/10 §1.6): `read(a.ts) + edit(b.ts) + bash(git commit) + bash(ls)` →
  `{ readFiles:["a.ts"], modifiedFiles:["b.ts"], bashSideEffects:["git commit"] }`. `ls` omitted. ✓
- **Empty span** → all three `[]`. De-dup + sort (lexicographic, case-sensitive — `[...set].sort()`).

## The bash policy crux — ASYMMETRIC (precision vs recall)
- **bashSideEffects = HIGH-RECALL**: a WHITELIST of provably-read-only commands (ls/cat/grep/wc/find/
  echo/diff/…) + redirect detection + find-destructive-flag detection. ANY command not provably
  read-only → included verbatim. A missed write (E5) is the dangerous failure; a false-positive
  bashSideEffect is harmless.
- **modifiedFiles-from-bash = HIGH-PRECISION**: redirect targets (`> file`, always) + file-like args
  from commands KNOWN to mutate files by path (`rm,mv,cp,mkdir,touch,chmod,chown,chgrp,ln,tee,truncate,
  install,patch,sed,split,csplit,curl,wget`). `git/node/npm/make` → bashSideEffects ONLY (their
  path-like args are scripts/targets, not "modified files").
- `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, … are IGNORE_PATHS — never modifiedFiles.
- `find -delete/-exec/-ok/-fls/-fprint…` → NOT read-only (FIND_MUTATING_RE) → bashSideEffects.

## Purity / defensive rules (mirrors tokens.ts + config.ts fail-open)
- ZERO imports (not Pi, not config, not log, not tokens). `Math`/`JSON`/`String`/`RegExp` are builtins.
- NEVER throws (rewind-tool hot path, spec/08 E13). `isRecord`/`readOwn` swallow Proxy-trap throws;
  non-array messages/range/content → empty ledger; out-of-bounds/non-integer/non-assistant/non-toolCall →
  skipped. We only read `.path`/`.file_path`/`.command` — NEVER `JSON.stringify(arguments)`, so circular
  arguments are harmless (unlike tokens.ts which sizes arguments).
- Paths returned VERBATIM — no cwd normalization, no fs access (pure). "Relative to cwd" is the CALLER's
  invariant (Pi's read tool already returns relative paths); ledger does not touch the filesystem.

## Verified gates (run in hack tree)
- `npx tsc --noEmit` → exit 0 (tsconfig include [src,test]; current tree green).
- `npx vitest run test/ledger.test.ts` → 39 tests pass (verified in sibling).
- `npx vitest run` → 5 files / 108 tests pass (config/log/tokens/runtime/load); the new ledger test
  must keep this green.

## Test tiers to cover (from oracle test/ledger.test.ts — 39 tests, 6 describe blocks)
1. spec/10 §1.6 PINNED contract (the load-bearing test) + empty span/null messages/null range.
2. readFiles: path vs file_path; grep/glob/find/ls; missing/mistyped path; de-dup + sort.
3. modifiedFiles: write/edit; bash redirect; rm/mv/cp/sed; /dev/null excluded; git-commit→bashSideEffects
   only; node/npm→empty; curl -o extracts, curl-to-stdout doesn't; cross-source de-dup.
4. bashSideEffects: read-only omitted; read-only pipelines omitted (2>&1 is fd-dup not a write); non-
   read-only included verbatim + sorted; unknown command included; find -delete/-exec included; tee via
   pipe; de-dup; empty/missing command ignored.
5. range iteration: toolResult in range skipped; out-of-range messages ignored; out-of-bounds/garbage
   indices skipped defensively; user message skipped.
6. defensive never-throws: non-array content; non-record/non-toolCall blocks; non-record arguments;
   circular arguments (no throw, .path still read); throwing-Proxy (fail-open); real Pi shape
   (structural typing). + type-level expectTypeOf (FileLedger shape, return type, MessageLike accepts a
   toolCall-bearing assistant message).

## Gate rules honored (G1.1–G1.5)
- No negative-existence gates; no scope-boundary shell gates. Scope (zero imports, purity, never-throws,
  no handler/tool wiring, no doc file) = success criteria + manual Level-4 gate.
- Deliverables survive the coder's turn (G1.4): do NOT delete ledger.ts/test after verifying.

## DOCS impact
M2 tasks are pure helpers — no per-item doc file. Whole-feature README is Mode B changeset-level
documentation in P1.M5.T4. No per-item DOCS line to echo.
