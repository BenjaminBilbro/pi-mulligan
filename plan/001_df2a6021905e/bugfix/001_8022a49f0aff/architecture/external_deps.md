# External Dependencies — Pi API surface relevant to these bugfixes

Source of truth: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
(pi 0.84.1, confirmed present in this checkout).

## 1. There is NO settings accessor on the Pi API (drives BUG-001 design)

Confirmed by grep of `types.d.ts`: the only `settings` mentions are unrelated
(`enabledModels` catalogue filtering at line 225, OpenAI-compat settings at line 1100).
**There is no `pi.getSettings()`, no `ctx.getSettings()`, and no event carries the merged
settings object.** Therefore the ONLY way to honor spec/09 §1 ("Mulligan reads
`settings.mulligan`") is to **read the JSON files from disk** (Pi's documented convention).

## 2. The file locations to read (spec/09 §1 + README §3)

- **Global:** `~/.pi/agent/settings.json` → compute via `path.join(os.homedir(), ".pi", "agent", "settings.json")`.
  (Confirmed this machine HAS this file at `/home/dustin/.pi/agent/settings.json`; it already
  carries a top-level `packages` array and other keys — Mulligan must read only the `mulligan`
  key and ignore everything else.)
- **Project-local:** `<cwd>/.pi/settings.json` → `path.join(ctx.cwd, ".pi", "settings.json")`.
  (The current project HAS `.pi/settings.json` with a `packages` key — again, read only `mulligan`.)
- **Merge precedence:** project-local overrides global (per spec/09 §1). Project-local is read
  ONLY when `ctx.isProjectTrusted()` is true (untrusted project → global-only, fail-safe).

## 3. Where `cwd` and `isProjectTrusted()` live (confirmed in types.d.ts)

`ExtensionContext` (the 2nd arg to every event handler) exposes:
- `cwd: string` (line 217)
- `isProjectTrusted(): boolean` (line 234)

**The factory `export default function (pi: ExtensionAPI): void` does NOT receive a ctx.**
So project-local config (which needs `cwd`) can only be read inside an event handler that
has `ctx` — specifically `session_start`. Global config (needs only `os.homedir()`) CAN be
read at factory time as an early best-effort.

## 4. SessionStartEvent.reason (drives BUG-006 / the reload half of BUG-001)

`pi.on("session_start", handler)` — `SessionStartEvent.reason` is
`"startup" | "reload" | "new" | "resume" | "fork"` (line 418). README §3 promises config is
"re-read on `/reload`". So the `session_start` handler must (re-)read+merge+setConfig on
**every** session_start (startup AND reload AND new/resume/fork all warrant a fresh read —
cheapest correct behavior). Today the handler only calls `resetRuntime(ctx.sessionManager.getSessionId())`.

## 5. getBranch() vs getEntries() (drives BUG-004)

Both are on `ctx.sessionManager` (ReadonlySessionManager):

- `getEntries()` — returns entries from **EVERY branch** (the raw append-only stream). Used
  today by `filter.ts:readMarkers`, `tools/rewind.ts:countRewindMarkers`+`checkpointExists`,
  `tools/audit.ts:listCheckpoints`. **This is the BUG-004 leak source.**
- `getBranch()` — returns the **current branch's** entries, root→leaf (filter.ts already does
  `getBranch().slice().reverse()` for the checkpoint `branchEntries`). Markers read from
  `getBranch()` are scoped to the active branch — correct under `/tree` navigation/forking.

**BUG-004 fix = switch the four marker/label reads from `getEntries()` → `getBranch()`.**
Caveat to verify during implementation: confirm `getBranch()` ordering matches what each
consumer expects (readMarkers is order-insensitive — it buckets; countRewindMarkers is a
count — order-insensitive; checkpointExists/listCheckpoints need latest-wins label semantics
which they already resolve via `getLabel(id)`, so the raw-walk is only for *discovering
candidates* — order-insensitive). So the switch is safe for all four consumers.

## 6. appendEntry / getLeafId / sendMessage / setLabel (markers.ts, already shipped)

- `pi.appendEntry(customType, data)` → returns `void`; the new entry's id is captured via
  `ctx.sessionManager.getLeafId()` in the same synchronous tick (C7). `appendRewindMarker`
  returns `string | null` (null on failure). **BUG-005 = the rewind tool ignores the null.**
- `pi.sendMessage({customType, content, display, details})` — for the note (no `triggerTurn`).
- `pi.setLabel(entryId, label)` — for checkpoints (latest-wins via `getLabel(id)`).

## 7. buildContextEntries + sessionEntryToContextMessages (rewind.ts preview / audit fallback)

`ctx.sessionManager.buildContextEntries()` → `SessionEntry[]`. `sessionEntryToContextMessages(e)`
→ the LLM message(s) an entry yields. `rewind.ts:resolvePreview` already builds a flat
message list this way for the advisory K/ledger preview. **This is the seam BUG-002's
target-capture step will reuse** (build the messages, resolve the target toolGroup, then map
the target message indices back to their source `SessionEntry.id`s to pin on the marker).

## 8. Node builtins available (no extra deps; package.json `dependencies: {}`)

`node:fs` (`readFileSync`), `node:path` (`join`), `node:os` (`homedir`). All already used
elsewhere in the repo (`markers.ts` uses `node:crypto`; `log.ts`/`audit.ts` use `node:fs`
via `Buffer`; `smoke.ts` uses `node:fs`). **No new dependency is needed for any fix.**

## 9. Test harness conventions (vitest)

- Tests import from `../src/*.js` (ESM bundler resolution; `.js` specifiers point at `.ts`).
- Mocks: hand-rolled `createMockPi()` / `createMockCtx()` with `vi.fn()` (see `test/index.test.ts`).
  `vi.resetModules()` in `beforeEach` to reset module-level caches (important: `config.ts`
  caches `cachedConfig` at module scope — tests must reset modules to test setConfig effects).
- **The jiti double-module gotcha (smoke.ts notes):** when pi loads two extensions, each gets
  its OWN module cache. This is WHY the smoke harness cannot configure Mulligan via `setConfig`
  from the helper. But Mulligan reading its OWN `settings.json` at its OWN `session_start`
  works fine (same module instance). This is exactly what enables deterministic config tests
  once BUG-001 lands.
