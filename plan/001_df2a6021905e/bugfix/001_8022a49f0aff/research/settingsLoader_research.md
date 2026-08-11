# Research Notes — P1_M1_T1_S1: src/settingsLoader.ts

## 1. Task contract (verbatim from work item + design_decisions.md BUG-001/BUG-006)

Create `src/settingsLoader.ts` exporting `loadMulliganSettings(opts?: { cwd?: string; isTrusted?: boolean }): unknown`.
- GLOBAL: `path.join(os.homedir(), ".pi", "agent", "settings.json")` → read if present+valid JSON → its `.mulligan`.
- LOCAL: `path.join(cwd, ".pi", "settings.json")` → read ONLY when `opts.isTrusted === true` → its `.mulligan`.
- MERGE: local `.mulligan` REPLACES global `.mulligan` (top-level replace, NOT deep-merge — spec/09 §1 "project-local wins").
- Return merged `mulligan` value (type `unknown`) or `undefined` when neither contributes.
- NEVER throws. Missing/unreadable → skip. Malformed JSON → `console.warn("[mulligan] settings: <path> unreadable: <msg>")` + skip.
- Non-object `.mulligan` → return as-is (let config.ts validateConfig coerce).
- No caching. No `pi` import (keep unit-testable).
- Exports: `loadMulliganSettings` + its opts type.

## 2. Consumer & verification chain (VERIFIED)

Consumer is P1_M1_T2.S1 which will call `setConfig(loadMulliganSettings(opts))` at factory load + session_start.
- `config.ts:setConfig(raw: unknown)` → `validateConfig(raw)` (lines ~190-205).
- `config.ts:validateConfig(undefined)` → returns structuredClone(DEFAULT_CONFIG) because `isRecord(undefined)` is false (verified: test/config.test.ts asserts `expect(validateConfig(undefined)).toEqual(DEFAULT_CONFIG)`).
- => When loader returns `undefined`, the config yields DEFAULT_CONFIG. CONFIRMED end-to-end.

## 3. Codebase conventions (VERIFIED by reading source)

### Imports
- `node:` builtins: `src/log.ts:18` `import { appendFileSync } from "node:fs";`; `src/markers.ts:29` `import { randomUUID } from "node:crypto";`.
- Local imports use `.js` extension: `src/markers.ts` `from "./config.js"`, `src/index.ts` `from "./config.js"` (ESM + moduleResolution:Bundler).
- **settingsLoader.ts imports NO local modules** (no config, no log, no pi) — it is a pure leaf.

### Fail-open / warn discipline (mirrors config.ts warnConfig)
- config.ts `warnConfig` uses `console.warn("[mulligan] config: ... ")` wrapped in try/catch.
- log.ts `writeStderrFallback` uses `process.stderr.write` wrapped in try/catch.
- For settingsLoader, the contract gives the EXACT warn string: `console.warn("[mulligan] settings: ${path} unreadable: ${msg}")`. Mirror config.ts's try/catch-around-warn so even logging never throws.

### File-read pattern
- `readFileSync(path, "utf8")` (log.test.ts uses `readFileSync(file, "utf8")`).
- JSON.parse throws on malformed JSON AND on JSONC comments (verified: `JSON.parse("{//c\n\"a\":1}")` throws). So a settings.json with `//` comments → SyntaxError → must be caught + warned + skipped.

### Test patterns (test/log.test.ts is the closest analog — tmp-dir fixtures)
- `import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";`
- `import { tmpdir } from "node:os";` `import { join } from "node:path";`
- `let dir; beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mulligan-xxx-")); }); afterEach(() => { rmSync(dir, { recursive: true, force: true }); });`
- `import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";`
- console.warn spy: `const warn = vi.spyOn(console, "warn").mockImplementation(() => {});` ... `warn.mockRestore()` in finally (config.test.ts).
- vitest globals ON (vitest.config.ts `test: { globals: true }`), but tests still import explicitly — follow that style.
- Tests import from `../src/settingsLoader.js`.

## 4. GLOBAL-path testability (RESOLVED)

`os.homedir()` is NOT injectable via opts (contract forbids adding a homeDir param). Resolved via `vi.mock("node:os")`:
- SPIKED in /tmp: `vi.mock("node:os", () => ({ homedir: () => "/tmp/fake-home" }))` redirects `homedir()` and the module-under-test picks it up (vitest hoists the mock). TEST PASSED.
- This keeps the public opts contract clean ({ cwd?, isTrusted? }) AND makes global/local/merge fully deterministic.
- Per-test control: use a module-scoped mutable `let mockHome: string` and a `setMockHome(p)` helper inside the factory, OR use `vi.mocked(homedir).mockReturnValue(p)` per test. Cleaner: factory reads a mutable variable.

## 5. Real-world state on THIS machine (baseline)

- `~/.pi/agent/settings.json` EXISTS, has `packages`/`defaultModel`/etc but **NO `mulligan` key**.
- `<cwd>/.pi/settings.json` EXISTS, has `packages` only, **NO `mulligan` key**.
- => `loadMulliganSettings({ cwd: process.cwd(), isTrusted: true })` returns `undefined` today → DEFAULT_CONFIG. This is the unchanged baseline (BUG-001 root cause: nothing calls it yet).

## 6. Merge-semantics edge cases (determines the helper shape)

- A file with a `mulligan` key whose value is `null` → that IS a present key → local `mulligan:null` REPLACES global (returns null). Then validateConfig(null) → DEFAULT_CONFIG. Reasonable.
- A file whose top-level JSON is a non-object (`[1,2,3]`, `"foo"`, `42`) → has no `.mulligan` key → contributes nothing (undefined).
- `mulligan: undefined` cannot exist in parsed JSON (undefined not serializable) → absence == no key.
- Discriminator: presence of the `mulligan` OWN key on a parsed record. Use `'mulligan' in obj` (works for `{mulligan: null}`) but guard that `obj` is a record first (Object.create(null) and plain {} ok; arrays/primitives/null skip).
- "non-object `.mulligan` → return it as-is": e.g. `{ mulligan: 42 }` → return `42`; `{ mulligan: "off" }` → return `"off"`. validateConfig will coerce (non-record → DEFAULT_CONFIG). Do NOT validate here.

## 7. Internal helper (recommended for clean composition + testability)

Pure `readMulliganKey(filePath: string): unknown`:
  - readFileSync utf8, JSON.parse — any throw → return `undefined` (caller warns with the path/msg).
  - Actually, the WARN must happen here (we have the path + the error msg). So signature: `readMulliganKey(filePath): { value: unknown; present: boolean }` OR just return `unknown` with `undefined`=absent and warn internally. Cleaner: warn inside, return `unknown` (undefined = no contribution). Then loadMulliganSettings = `local !== undefined ? local : global`. (null is !== undefined, so a local null wins — correct.)

## 8. Validation commands (VERIFIED to exist in repo)

- `npm test` (vitest run) — full suite; baseline 635 pass | 2 skipped.
- `npx vitest run test/settingsLoader.test.ts` — single file.
- `npx tsc --noEmit -p tsconfig.json` — typecheck (no build step; jiti loads .ts at runtime).
- No separate lint/format step in package.json (no eslint/ruff/prettier configured).

## 9. DOCS impact

Mode A is not explicitly declared on this leaf task; README §3 already documents the read behavior
(global ~/.pi/agent/settings.json + local <cwd>/.pi/settings.json, project-local wins, re-read on /reload).
This task SHIPS the loader only; the README §3 text becomes TRUE once P1.M1.T2.S1 wires setConfig at
factory+session_start. No README edit in THIS task (deferred to the changeset-level Mode B sync in the
final task). PRP surfaces this so docs aren't silently dropped.
