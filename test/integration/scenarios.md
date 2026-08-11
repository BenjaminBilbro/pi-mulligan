# Mulligan integration smoke harness — scenario playbook

> The integration layer for Mulligan (spec/10-testing.md §2). This doc is the playbook: how to run each F-*
> scenario, what to expect in the logs/JSONL, and what "pass" means. The deterministic suite is the default CI
> gate (`npm run smoke`); the model-driven prompts are the authoritative proof for the 3 model-dependent
> scenarios (F-rewind-core canary-drop, F-shrink-preventive bloat, F-nudge-drift nudge).

---

## How the harness works

### The two-extension load order (CRITICAL)

```
pi -e ./src/index.ts -e ./test/integration/smoke.ts …
#         ① FIRST               ② SECOND
```

Pi loads extensions in `-e` flag order, and context/tool_result/turn_end handlers **chain** in that order —
each handler receives the prior handler's transformed messages. So:

- **Mulligan** (`src/index.ts`) loads **first** → its `context` handler runs first → it returns the
  **filtered** message list.
- **The smoke helper** (`test/integration/smoke.ts`) loads **second** → its `context` handler runs second →
  it sees the **post-filter** messages and logs them (it is an **observer only** — it returns `void` so it
  never overrides Mulligan's filter).

If you reverse the `-e` order, the smoke helper sees pre-filter messages and every assertion fails.

### The deterministic command path

```
pi … -p "/mulligan_smoke <scenario>" -p "Reply with exactly: OK"
```

- The **first** `-p` dispatches the `/mulligan_smoke` extension command (Pi intercepts `/cmd` prompts and runs
  the command handler — no model call). The command sets up the scenario's persisted state using the **REAL**
  Mulligan tools (`makeRewindTool`/`makeShrinkTool`/`makeCheckpointTool` — imported from `src/`, same process).
- The **second** `-p` triggers a model turn, which (a) fires the `context` event so Mulligan's filter runs and
  the smoke helper logs `context.fire`, and (b) produces an assistant message so Pi **persists the session
  JSONL** (Pi only flushes the session file once an assistant message exists).

> **Why a second prompt instead of a queued follow-up?** Print mode (`pi -p`) does NOT drain a follow-up
> queued from inside a `/cmd` dispatch — the command path returns before the agent's drain loop, and
> `pi.sendUserMessage({deliverAs:"followUp"})` is fire-and-forget. A second `-p` prompt reliably triggers the
> observing turn + persists the session. (Verified against Pi 0.84.x `agent-session.js` / `print-mode.js`.)

### The log + the session JSONL

- **Smoke log** (`/tmp/mulligan-smoke.log`, or `$MULLIGAN_SMOKE_LOG`): JSONL, written by the smoke helper.
  One line per event: `session.start`, `setup.canary`, `context.fire`, `tool.rewind`, `tool.shrink`,
  `tool.checkpoint`, `scenario.*`. This is the **primary** assertion source.
- **Session JSONL** (`~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`): persisted by Pi. The smoke helper
  logs its path in the `session.start` line's `detail.sessionFile`. Used for the §2.3 entry-shape invariants.

### A `context.fire` line

```json
{"test":"context.fire","status":"info","detail":{
  "count": 3,
  "msgCanaryPresent": true,      // the session_start canary (MULLIGAN-SMOKE-MSG-CANARY)
  "resultCanaryPresent": false,  // the mulligan_smoke_big canary (MULLIGAN-SMOKE-RESULT-CANARY)
  "notePresent": true,           // a mulligan:note custom message is in context
  "hasRewindMarker": true,       // a mulligan:rewind custom entry exists on the branch
  "shrunkInContext": false,      // the shrink replacement (MULLIGAN-SMOKE-SHRUNK) is in context
  "hasNudge": false              // a mulligan:nudge custom message is in context (ephemeral)
}}
```

### The §2.3 entry-shape invariants (asserted for every marker-creating scenario)

| Entry | Pi `type` | In context? |
|---|---|---|
| `mulligan:rewind` | `custom` | No (control state) |
| `mulligan:shrink` | `custom` | No |
| `mulligan:turn-metric` | `custom` | No |
| `mulligan:note` | `custom_message` | **Yes** (the resumed model reads it) |
| `mulligan:checkpoint:<name>` | `label` | No |
| `mulligan:nudge` | (never persisted) | (ephemeral — constructed in the filter copy only) |

**ZERO `mulligan:nudge` entries may appear on disk** (the §2.3 headline invariant).

### API-key tolerance

The deterministic command path persists all markers **before** any model call. The second `-p "Reply with
exactly: OK"` only needs the model to produce a trivial reply (to persist the session JSONL). If the model is
unavailable or times out, the smoke log assertions (markers, tool results) still hold; only the session-JSONL
assertions are skipped (with a note). So the suite is CI-runnable with any/no working key.

---

## The F-* scenarios (9)

### F-rewind-core

**Tests:** a rewind marker + note persist; the filter sees them on the next inference.

**Run (deterministic):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-rewind-core \
  -p "/mulligan_smoke F-rewind-core" -p "Reply with exactly: OK"
```

**Run (model-driven — the authoritative canary-drop proof):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts \
  -p "Call mulligan_smoke_big, then use mulligan_rewind (granularity last_tool_call_group) to undo it, leaving yourself a note."
```
The model calls the tools; `context.fire` shows `resultCanaryPresent` go `true → false` (the bloated result is
hidden after the rewind) and the message count drops.

**Expect in log:** `tool.rewind` (succeeded); `context.fire` with `hasRewindMarker:true`, `notePresent:true`.

**Expect in JSONL:** `mulligan:rewind` (custom) + `mulligan:note` (custom_message).

**Pass (deterministic):** marker + note persist; context.fire shows the filter sees them; §2.3 invariants hold.
*(The canary-drop / count-decrease and seed hiding are dependent on the `hideEntryIds` pinning mechanism (a later
task). Without it, the filter's live `last_turn` resolution targets the current last user message, which may
differ from the rewind-time target. The smoke harness marks seed-hiding as SOFT until `hideEntryIds` ships.)*

---

### F-shrink-persist

**Tests:** a shrink marker persists; the substitution appears in the filtered view; the original stays on disk.

**Run (deterministic):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-shrink-persist \
  -p "/mulligan_smoke F-shrink-persist" -p "Reply with exactly: OK"
```

**Run (model-driven):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts \
  -p "Call mulligan_smoke_big, then mulligan_shrink it (by_content_includes CANARY) to a one-line summary."
```

**Expect in log:** `tool.shrink` (succeeded); `context.fire` with `shrunkInContext:true`.

**Expect in JSONL:** `mulligan:shrink` (custom) + the **original** canary text still present (shrink is a
view-substitution, NOT a JSONL rewrite).

**Pass:** shrink marker persists; substitution in filtered view; original on disk; §2.3 invariants hold.

---

### F-shrink-preventive

**Tests:** the bloat reminder fires on a tool result exceeding its resolved bloat threshold (default
`bloatThresholdBytes=8192`); a turn-metric with `bloatHit:true` is recorded.

**Run (deterministic):** the orchestrator uses a 2-prompt flow. The first prompt dispatches the
`/mulligan_smoke F-shrink-preventive` command (logs that `smoke_read_big` is registered). The second prompt
instructs the model to **call `smoke_read_big`** — a **NON-`mulligan_*`** test tool whose result exceeds
the threshold (~10KB > 8192 bytes). Because its name lacks the `mulligan_` prefix, `bloatReminderHandler` does
**not** skip it — the real `tool_result` event fires the reminder, appends the `[mulligan]` annotation, and
records the bloat hit. `turnEndMetricHandler` then persists a `mulligan:turn-metric` with `bloatHit:true` and
`bloatHits` naming `smoke_read_big`. The asserter HARD-asserts `data.bloatHit === true` from the session JSONL.

```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-shrink-preventive \
  -p "/mulligan_smoke F-shrink-preventive" -p "Call the smoke_read_big tool, then reply with exactly: OK"
```

**Run (model-driven):** any session where a non-`mulligan_*` tool returns >8192 bytes will fire the bloat
reminder. The deterministic flow above is already model-driven (the second prompt calls `smoke_read_big`),
so it is both the deterministic and model-driven path. Note that `mulligan_smoke_big` remains skipped by
`bloatReminderHandler` (it starts with `mulligan_`) but is retained as the shrink-target canary for F-shrink-persist.

**Expect in log (deterministic):** `tool.smoke_big` logged (confirms the command ran).

**Expect in JSONL:** `mulligan:turn-metric` (custom) with `data.bloatHit === true` and `data.bloatHits`
including `{ toolName: "smoke_read_big" }`.

**Pass (deterministic):** `bloatHit:true` HARD-asserted from the turn-metric; turn-metric exists;
§2.3 invariants hold.

---

### F-nudge-drift

**Tests:** a turn that grows past the drift threshold injects an ephemeral `mulligan:nudge`; ZERO nudges on disk.

**Run (deterministic):** the deterministic path cannot force the nudge — (a) lowering `driftThresholdTokens`
via `setConfig` does not work (Pi's jiti loader gives the smoke helper a separate `config.ts` module instance
from Mulligan's), and (b) the nudge needs two turns (turn 1 establishes the baseline, turn 2 grows past it).
It asserts only that a turn-metric exists + ZERO nudge entries (the §2.3 invariant).

```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-nudge-drift \
  -p "/mulligan_smoke F-nudge-drift" -p "Reply with exactly: OK"
```

**Run (model-driven — the authoritative nudge-injection proof):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts \
  -p "Tell me a very long, detailed story." -p "Now tell me another long one."
```
A turn that grows >3000 tokens (default `driftThresholdTokens`) → the next context fire ends with a
`mulligan:nudge` custom message (`hasNudge:true`); still ZERO `mulligan:nudge` entries in the session JSONL.

**Expect in log (deterministic):** `config.driftLow` logged.

**Expect in JSONL:** `mulligan:turn-metric` (custom) exists; ZERO `mulligan:nudge` entries.

**Pass (deterministic):** turn-metric exists; ZERO nudges on disk; §2.3 invariants hold. *(hasNudge:true is
model-driven — SOFT.)*

---

### F-protected

**Tests:** a rewind that would cross the first-user boundary is refused before persisting (the BUG-006 protected-refusal check in `rewind.ts:step-5b`).

**Run (deterministic):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-protected \
  -p "/mulligan_smoke F-protected" -p "Reply with exactly: OK"
```

**Expect in log:** `tool.rewind` with text containing "refused" (the tool-level refusal: when the rewind would cross the first/only user message, `rewind.ts:step-5b` refuses before persisting).

**Expect in JSONL:** ZERO `mulligan:rewind` markers (the refusal is pre-persist — no marker is created). §2.3 invariants hold.

**Pass:** the protected rewind refused (tool text contains "refused"); ZERO rewind markers persisted; the turn survived (pi exit 0).

---

### F-maxdepth

**Tests:** after 5 active rewind markers, a 6th is refused with a depth message.

**Run (deterministic):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-maxdepth \
  -p "/mulligan_smoke F-maxdepth" -p "Reply with exactly: OK"
```

**Expect in log:** 5 `tool.rewind` lines (succeeded) + a 6th containing "max rewind depth" / "refused".

**Expect in JSONL:** exactly 5 `mulligan:rewind` (custom) entries.

**Pass:** 6th rewind refused with depth message; exactly 5 markers persisted; §2.3 invariants hold.

---

### F-retrycap

**Tests:** the per-prompt retry budget (E22 a–d). With `rewind.maxRetriesPerPrompt:2`, repeated `last_turn`
rewinds that re-land at the SAME prompt are refused at the 3rd attempt with the "per-prompt retry budget"
message; a fresh user prompt restores the budget.

**Run (deterministic):** set `rewind.maxRetriesPerPrompt:2` (via config), then drive repeated same-prompt rewinds.

**Expect in log:** 2 `tool.rewind` lines (succeeded) + a 3rd containing "per-prompt retry budget" / "refused";
a subsequent rewind after a NEW user message succeeds again.

**Expect in JSONL:** exactly 2 `mulligan:rewind` markers persisted for the first prompt (the 3rd refused
persists nothing); the post-new-prompt rewind adds a 3rd marker.

**Pass:** 3rd same-prompt rewind refused with the budget text and persists nothing; fresh prompt restores the
budget; `mulligan_shrink`/`mulligan_audit` remain callable throughout. §2.3 invariants hold.

> Deterministic unit coverage lives in `test/tools/rewind.test.ts` (P4.M1.T3.S1 / spec/10 §1.10); this is the
> Tier-2 live-reproduction path, documented, not auto-run.

---

### F-abortfraction

**Tests:** the context-fraction stop (E22 e). When the filtered context is ≥ `rewind.abortContextFraction`
of the window, a rewind is refused with the "context is at …% of the window" message even though the retry
budget remains; `mulligan_shrink` / `mulligan_audit` stay callable.

**Run (deterministic):** force the filtered view to ≥ `abortContextFraction` (default 0.9) of the window —
e.g. seed a large `mulligan_shrink`-able result so `rt.lastFiltered` ≈ the window — then attempt a rewind.

**Expect in log:** `tool.rewind` refused with "context is at" / "% of the window"; a `mulligan_shrink` call in
the same turn still succeeds (non-refusal).

**Expect in JSONL:** NO new `mulligan:rewind` marker (the rewind was refused before persisting); the
`mulligan:shrink` marker from the still-callable shrink persists.

**Pass:** rewind refused with the context-fraction text and persists nothing; shrink/audit callable; §2.3
invariants hold.

> Deterministic unit coverage lives in `test/tools/rewind.test.ts` (P4.M1.T3.S1 / spec/10 §1.10); this is the
> Tier-2 live-reproduction path, documented, not auto-run.

---

### F-checkpoint

**Tests:** a checkpoint label is set; a rewind to it persists; the label + rewind marker are on disk.

**Run (deterministic):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-checkpoint \
  -p "/mulligan_smoke F-checkpoint" -p "Reply with exactly: OK"
```

**Expect in log:** `tool.checkpoint` (succeeded) + `tool.rewind` (checkpoint granularity).

**Expect in JSONL:** a `label` entry `mulligan:checkpoint:alpha` + a `mulligan:rewind` (custom).

**Pass:** checkpoint label + rewind marker persist; §2.3 invariants hold.

---

### F-failopen

**Tests:** the filter is fail-open — a malformed marker does NOT crash the turn (pass-through).

**Run (deterministic):**
```bash
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-failopen \
  -p "/mulligan_smoke F-failopen" -p "Reply with exactly: OK"
```

The command appends a malformed `mulligan:rewind` marker (missing `note`/`ledger`/etc). Mulligan's filter
wraps its whole body in try/catch → pass-through.

**Expect in log:** `failopen.marker` (appended); `context.fire` still logged (the filter ran without crashing).

**Pass:** pi exited 0 (the turn survived); context.fire logged. *(The authoritative "handler never throws"
proof is the unit test in `filter.test.ts` — GOTCHA #9. The harness verifies pass-through end-to-end.)*

---

### F-reload

**Tests:** a rewind marker survives a session reload (a second `pi` process with the same `--session-id`).

**Run (deterministic — two runs sharing `--session-id`):**
```bash
# Run 1: create the rewind marker.
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-reload \
  -p "/mulligan_smoke F-reload" -p "Reply with exactly: OK"
# Run 2: reopen the SAME session (--session-id smoke-F-reload) and run an observing turn.
pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-F-reload \
  -p "/mulligan_smoke F-reload" -p "Reply with exactly: OK"
```

**Expect in log:** run-1 `tool.rewind`; run-2 `context.fire` with `hasRewindMarker:true`.

**Expect in JSONL:** `mulligan:rewind` (custom) persisted across the reload (both runs append to the same file).

**Pass:** run-2 sees the marker (`hasRewindMarker:true`); marker persisted on disk; §2.3 invariants hold.

---

## Running the whole suite

```bash
npm run smoke
```

Runs all 9 deterministic F-* scenarios via `test/integration/run-smoke.mjs`. Prints a `PASS`/`FAIL`
line per scenario (with per-assertion detail on failure), then a summary; exits 0 if all pass, 1 otherwise.

**Notes:**
- Each scenario spawns a fresh `pi` process with a stable `--session-id` (so F-reload can reopen). The smoke
  log is isolated per scenario under `$TMPDIR/mulligan-smoke/<scenario>.log`.
- Model-dependent sub-criteria (canary-drop, bloatHit, hasNudge) are **SOFT** (warned, not failed)
  in the deterministic suite. The model-driven prompts above are the authoritative proofs for those.
- If `pi` exits non-zero with an empty smoke log, the orchestrator reports `EXTENSION LOAD FAILED` — look at
  `src/index.ts`, not the harness (GOTCHA #12).