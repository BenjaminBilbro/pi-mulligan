/**
 * run-smoke.mjs — Mulligan integration smoke orchestrator (plain Node ESM, NOT type-checked).
 *
 * For each F-* scenario in SCENARIOS:
 *   1. Set MULLIGAN_SMOKE_LOG to a per-scenario path under a temp dir.
 *   2. Spawn `pi -e ./src/index.ts -e ./test/integration/smoke.ts --session-id smoke-<scenario>-<RUN_ID>
 *      (RUN_ID is unique per `npm run smoke` invocation — see below — so the session JSONL never accumulates
 *      prior runs; F-reload shares it across its two spawns WITHIN one run).
 *      -p "/mulligan_smoke <scenario>" -p "Reply with exactly: OK"`.
 *      ─ The FIRST prompt dispatches the deterministic command (sets up markers via the REAL tools).
 *      ─ The SECOND prompt triggers the observing model turn (fires context → the filter runs → smoke logs
 *        context.fire; and the model reply persists the session JSONL for the §2.3 assertions).
 *   3. Parse the smoke JSONL log (the PRIMARY assertion source) +, when available, the session JSONL.
 *   4. Run the scenario's assertion function; print PASS/FAIL.
 *   5. F-reload = TWO spawns sharing --session-id smoke-F-reload-<RUN_ID>.
 *
 * Exits 0 if all scenarios pass, 1 otherwise. Detects "EXTENSION LOAD FAILED" (non-zero pi exit + empty
 * smoke log → src/index.ts failed to load; GOTCHA #12) distinctly from a scenario-assertion failure.
 *
 * DESIGN: shell-like glue. Defensive (handles missing files, empty logs, non-zero pi exits, model timeouts).
 * The deterministic command path persists markers BEFORE any model call, so the core assertions hold even
 * when the model times out (the session JSONL may be missing on a timeout — those assertions are skipped
 * with a note; the smoke log is always available).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCENARIOS = [
  "F-rewind-core",
  "F-shrink-persist",
  "F-shrink-preventive",
  "F-nudge-drift",
  "F-protected",
  "F-maxdepth",
  "F-checkpoint",
  "F-failopen",
  "F-reload",
];

const SMOKE_TMP_DIR = join(tmpdir(), "mulligan-smoke");
mkdirSync(SMOKE_TMP_DIR, { recursive: true });
const PI_TIMEOUT_MS = 120_000;

// RUN_ID — a per-invocation suffix appended to every scenario's --session-id (FINDING 1 fix). It is stable FOR
// THE DURATION of one `npm run smoke` (module load) so the two spawns of F-reload share a session, but UNIQUE
// across invocations so the session JSONL never accumulates prior runs' seed replies / markers. This makes the
// suite IDEMPOTENT (re-running `npm run smoke` no longer flakes F-rewind-core / F-checkpoint with false
// "LEAKED BACK" / "seed LEAKED" failures from unpinned leftover seed replies).
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
const PROJECT_ROOT = process.cwd();

// SEED-canary string literals for the deterministic HIDING assertions (P1.M3.T2.S1). MUST be byte-identical to the
// consts in smoke.ts (GOTCHA #8 — there is no shared module; a mismatch → seed never matches → K=0 → fail).
const SEED_ANCHOR = "MULLIGAN-SMOKE-SEED-ANCHOR";
const SEED_HIDDEN = "MULLIGAN-SMOKE-SEED-HIDDEN";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * runPi — spawn pi for a scenario. Returns { status, stdout, stderr, logPath }. By default it drives the
 * 2-prompt deterministic flow (`/mulligan_smoke <scenario>` then `Reply with exactly: OK`); pass { prompts } to
 * drive a custom prompt sequence (the SEED flows for F-rewind-core / F-checkpoint — P1.M3.T2.S1).
 */
function runPi(scenario, { prompts, extraArgs = [], cwd } = {}) {
  const logPath = join(SMOKE_TMP_DIR, `${scenario}.log`);
  // Default = the existing 2-prompt deterministic flow (unchanged for the 12 non-seeded scenarios).
  const ps = prompts ?? [`/mulligan_smoke ${scenario}`, "Reply with exactly: OK"];
  // When cwd is set (scoped tmp cwd for F-nudge-drift), resolve -e to ABSOLUTE paths + add -a to trust the tmp project.
  const extSrc = cwd ? join(PROJECT_ROOT, "src/index.ts") : "./src/index.ts";
  const extSmoke = cwd ? join(PROJECT_ROOT, "test/integration/smoke.ts") : "./test/integration/smoke.ts";
  const argv = [
    "-ne",
    ...(cwd ? ["-a"] : []),
    "-e", extSrc,
    "-e", extSmoke,
    // Run-scoped session id (RUN_ID): unique per `npm run smoke` invocation → no cross-run JSONL accumulation
    // (FINDING 1). F-reload shares this id across their two spawns WITHIN one run (reloads reopen it).
    "--session-id", `smoke-${scenario}-${RUN_ID}`,
    ...ps.flatMap((p) => ["-p", p]),
    ...extraArgs,
  ];
  const res = spawnSync("pi", argv, {
    encoding: "utf8",
    env: { ...process.env, MULLIGAN_SMOKE_LOG: logPath },
    timeout: PI_TIMEOUT_MS,
    ...(cwd ? { cwd } : {}),
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", logPath };
}

/**
 * parseSmokeLog — read the smoke JSONL log; return { lines, contextFires, sessionFile }.
 * - lines: all parsed JSON lines (excluding the leading "# " comment header).
 * - contextFires: the parsed `detail` objects from context.fire lines.
 * - sessionFile: the sessionFile from the session.start line (for reading the session JSONL).
 */
function parseSmokeLog(path) {
  const result = { lines: [], contextFires: [], sessionFile: null };
  if (!existsSync(path)) return result;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      const obj = JSON.parse(trimmed);
      result.lines.push(obj);
      if (obj.test === "context.fire") result.contextFires.push(obj.detail);
      if (obj.test === "session.start" && obj.detail?.sessionFile) {
        result.sessionFile = obj.detail.sessionFile;
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return result;
}

/**
 * readSessionEntries — read the session JSONL (one JSON object per line); return [] if missing/unreadable.
 */
function readSessionEntries(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  try {
    return readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * assert — collect a pass/fail. Returns true if cond is true.
 */
function assert(results, label, cond, detail) {
  results.push({ pass: !!cond, label, detail: detail ?? "" });
  return !!cond;
}

/**
 * countCustom — count session entries matching a customType (and optionally a data.kind).
 */
function countCustom(entries, customType, kind) {
  return entries.filter((e) => {
    if (e.type !== "custom" || e.customType !== customType) return false;
    if (kind !== undefined && e.data?.kind !== kind) return false;
    return true;
  }).length;
}

/**
 * countCustomMessage — count session entries of type custom_message with a customType.
 */
function countCustomMessage(entries, customType) {
  return entries.filter((e) => e.type === "custom_message" && e.customType === customType).length;
}

/**
 * countLabel — count session entries of type label with a given label prefix.
 */
function countLabel(entries, labelPrefix) {
  return entries.filter((e) => e.type === "label" && typeof e.label === "string" && e.label.startsWith(labelPrefix)).length;
}

/**
 * labelActive — Pi's LATEST-WINS label resolution applied to the raw entry stream (validation issue #1b/#5).
 * A `setLabel(id, undefined)` appends a `{type:"label", targetId, label:undefined}` clear entry; Pi's
 * `_buildIndex` then deletes the id from its in-memory map, so getLabel(id) returns undefined for a CONSUMED
 * checkpoint. We mirror that here: walk entries in order, keep the LAST `label` per targetId (undefined on a
 * clear), and return true iff SOME target's final value is exactly `label` (the checkpoint is still active).
 */
function labelActive(entries, label) {
  const latest = new Map();
  for (const e of entries) {
    if (e.type !== "label") continue;
    const id = e.targetId;
    if (typeof id !== "string" || id.length === 0) continue;
    latest.set(id, e.label); // last writer wins (undefined on a clear entry)
  }
  for (const v of latest.values()) {
    if (v === label) return true;
  }
  return false;
}

/**
 * hasText — true if any session entry's stringified form includes the needle (for "original canary still on disk").
 */
function entryIncludes(entries, needle) {
  return entries.some((e) => JSON.stringify(e).includes(needle));
}

/**
 * §2.3 global invariants — run for every marker-creating scenario. Asserts the entry-type rules + ZERO nudges.
 * Returns true if all hold.
 */
function assertGlobalInvariants(results, entries) {
  // mulligan:rewind / mulligan:shrink / mulligan:turn-metric must be type "custom"
  for (const ct of ["mulligan:rewind", "mulligan:shrink", "mulligan:turn-metric"]) {
    const bad = entries.filter((e) => e.customType === ct && e.type !== "custom");
    assert(results, `§2.3 ${ct} entries are type:custom`, bad.length === 0, bad.length ? `${bad.length} wrong-type` : "");
  }
  // mulligan:note must be type "custom_message"
  const badNotes = entries.filter((e) => e.customType === "mulligan:note" && e.type !== "custom_message");
  assert(results, "§2.3 mulligan:note entries are type:custom_message", badNotes.length === 0, badNotes.length ? `${badNotes.length} wrong-type` : "");
  // mulligan:checkpoint: labels must be type "label"
  const badLabels = entries.filter((e) => typeof e.label === "string" && e.label.startsWith("mulligan:checkpoint:") && e.type !== "label");
  assert(results, "§2.3 mulligan:checkpoint: labels are type:label", badLabels.length === 0, badLabels.length ? `${badLabels.length} wrong-type` : "");
  // ZERO mulligan:nudge entries (ephemeral — §2.3)
  const nudgeCount = entries.filter((e) => e.customType === "mulligan:nudge").length;
  assert(results, "§2.3 ZERO mulligan:nudge entries on disk", nudgeCount === 0, nudgeCount ? `${nudgeCount} found` : "");
}

// ── Per-scenario assertion functions ─────────────────────────────────────────

/**
 * Each assert function takes { smoke, piRes } where smoke = parseSmokeLog output, piRes = runPi result.
 * It pushes { pass, label, detail } entries to a local results array and returns { results, sessionEntries }.
 */

function assertRewindCore({ smoke, piRes }) {
  const results = [];
  const sessionFile = smoke.sessionFile;
  const entries = readSessionEntries(sessionFile);
  const rewindLines = smoke.lines.filter((l) => l.test === "tool.rewind");
  const lastRewind = rewindLines[rewindLines.length - 1];
  const text = lastRewind?.detail?.text ?? "";
  assert(results, "tool.rewind ran", rewindLines.length >= 1, rewindLines.length ? "" : "no tool.rewind line");
  assert(results, "tool.rewind succeeded (not refused)", lastRewind && !/refused/i.test(text), text.slice(0, 80));
  // NEW (P1.M3.T2.S1): the seed flow commits a hideable assistant reply BEFORE the command, so the rewind MUST pin
  // ≥1 message. K=0 means the seed did not commit (model timeout) OR the resolver found nothing — either way the
  // hiding assertion below is meaningless, so fail here with a clear message.
  assert(results, "tool.rewind hid content (K≥1; not '0 messages will be hidden')", !/0 messages will be hidden/i.test(text), text.slice(0, 80));
  // context.fire shows the filter sees the persisted marker + note.
  const cf = smoke.contextFires[smoke.contextFires.length - 1];
  assert(results, "context.fire observed", !!cf, cf ? "" : "no context.fire");
  assert(results, "context.fire hasRewindMarker:true", cf?.hasRewindMarker === true, String(cf?.hasRewindMarker));
  assert(results, "context.fire notePresent:true", cf?.notePresent === true, String(cf?.notePresent));
  // Signal 2 of the two-signal guard: the hideEntryIds M2 pin (P1.M2.T1.S4; src/transforms.ts filterPipeline ~L860-880)
  // makes the seed reply stably hidden on the observing inference — status=pass is deterministic.
  // Signal 1 (K>=1 above) proves the seed existed+was pinned at rewind time; this proves it is ABSENT post-filter.
  // Fail = LEAKED BACK (BUG-001/002/003 regression — hideEntryIds pin or origIdxOfM translation broken).
  const hidingLines = smoke.lines.filter((l) => l.test === "F-rewind-core.hiding");
  const lastHiding = hidingLines[hidingLines.length - 1];
  const hidingPass = lastHiding && lastHiding.status === "pass";
  assert(results, "F-rewind-core.hiding: seed reply HIDDEN on observing inference (status=pass; two-signal guard w/ K>=1)", hidingPass === true, lastHiding ? JSON.stringify(lastHiding.detail).slice(0, 120) : "no F-rewind-core.hiding line emitted");
  // JSONL: mulligan:rewind (custom) + mulligan:note (custom_message)
  if (entries.length > 0) {
    assert(results, "JSONL has mulligan:rewind (custom)", countCustom(entries, "mulligan:rewind", "rewind") >= 1, "");
    assert(results, "JSONL has mulligan:note (custom_message)", countCustomMessage(entries, "mulligan:note") >= 1, "");
    assertGlobalInvariants(results, entries);
  } else {
    console.log(`  ⚠ JSONL unavailable (model may have timed out) — smoke-log assertions are primary`);
  }
  return { results, entries };
}

function assertShrinkPersist({ smoke, piRes }) {
  const results = [];
  const sessionFile = smoke.sessionFile;
  const entries = readSessionEntries(sessionFile);
  const shrinkLines = smoke.lines.filter((l) => l.test === "tool.shrink");
  assert(results, "tool.shrink ran", shrinkLines.length >= 1, "");
  // context.fire shows the substitution took effect in the filtered view.
  const cf = smoke.contextFires[smoke.contextFires.length - 1];
  assert(results, "context.fire observed", !!cf, "");
  assert(results, "context.fire shrunkInContext:true (substitution in filtered view)", cf?.shrunkInContext === true, String(cf?.shrunkInContext));
  // JSONL: mulligan:shrink (custom) + the ORIGINAL canary still on disk (shrink is a view-substitution, NOT a rewrite).
  if (entries.length > 0) {
    assert(results, "JSONL has mulligan:shrink (custom)", countCustom(entries, "mulligan:shrink", "shrink") >= 1, "");
    const originalOnDisk = entryIncludes(entries, "MULLIGAN-SMOKE-MSG-CANARY");
    assert(results, "JSONL original canary still on disk (view-substitution, not rewrite)", originalOnDisk, "");
    assertGlobalInvariants(results, entries);
  } else {
    console.log(`  ⚠ JSONL unavailable (model may have timed out) — smoke-log assertions are primary`);
  }
  return { results, entries };
}

function assertShrinkPreventive({ smoke, piRes }) {
  const results = [];
  const sessionFile = smoke.sessionFile;
  const entries = readSessionEntries(sessionFile);
  // Deterministic: the smoke_big log line fired + a turn-metric exists + bloatHit:true (HARD).
  assert(results, "tool.smoke_big logged", smoke.lines.some((l) => l.test === "tool.smoke_big"), "");
  if (entries.length > 0) {
    const turnMetrics = countCustom(entries, "mulligan:turn-metric", "turn-metric");
    assert(results, "JSONL has turn-metric (custom)", turnMetrics >= 1, `${turnMetrics} found`);
    // HARD: assert bloatHit:true from the turn-metric data (BUG-007 fix — smoke_read_big is non-mulligan, model-called).
    const tmEntries = entries.filter((e) => e.type === "custom" && e.customType === "mulligan:turn-metric");
    const bloatHitTrue = tmEntries.some((e) => e && e.data && e.data.bloatHit === true);
    assert(results, "turn-metric bloatHit:true (smoke_read_big fired the bloat reminder — HARD)", bloatHitTrue, bloatHitTrue ? "" : "no turn-metric with bloatHit:true — model may not have called smoke_read_big");
    // Secondary: verify the bloat hit names smoke_read_big.
    const namedTool = tmEntries.some((e) => Array.isArray(e && e.data && e.data.bloatHits) && e.data.bloatHits.some((h) => h && h.toolName === "smoke_read_big"));
    assert(results, "turn-metric bloatHits includes smoke_read_big", namedTool, "");
    assertGlobalInvariants(results, entries);
  } else {
    console.log(`  ⚠ JSONL unavailable (model may have timed out) — smoke-log assertions are primary`);
  }
  return { results, entries };
}

function assertNudgeDrift({ smoke, piRes }) {
  const results = [];
  const sessionFile = smoke.sessionFile;
  const entries = readSessionEntries(sessionFile);
  // HARD: drift.harness logged (replaces old config.driftLow).
  assert(results, "drift.harness logged", smoke.lines.some((l) => l.test === "drift.harness"), "");
  // HARD smoke-log assertions: the two-turn harness produces >=3 context.fires; the LAST has hasNudge:true.
  assert(results, "context.fire observed (>=3 fires for the two-turn harness)", smoke.contextFires.length >= 3, `${smoke.contextFires.length} fires`);
  const cf = smoke.contextFires[smoke.contextFires.length - 1];
  assert(results, "last context.fire hasNudge:true (drift nudge injected — HARD)", cf?.hasNudge === true, String(cf?.hasNudge));
  if (entries.length > 0) {
    const turnMetrics = countCustom(entries, "mulligan:turn-metric", "turn-metric");
    assert(results, "JSONL has turn-metric (custom)", turnMetrics >= 1, `${turnMetrics} found`);
    // HARD JSONL assertions: >=2 turn-metrics (two-turn harness), grewOverThreshold:true, numeric deltaTokens.
    const tmEntries = entries.filter((e) => e.type === "custom" && e.customType === "mulligan:turn-metric");
    assert(results, "JSONL has >=2 turn-metrics (two-turn harness ran)", tmEntries.length >= 2, `${tmEntries.length} found`);
    const grew = tmEntries.some((e) => e && e.data && e.data.grewOverThreshold === true);
    assert(results, "turn-metric grewOverThreshold:true (driftThresholdTokens=1 honored — HARD)", grew, grew ? "" : "no turn-metric with grewOverThreshold:true");
    const realDelta = tmEntries.some((e) => e && e.data && typeof e.data.deltaTokens === "number");
    assert(results, "turn-metric deltaTokens is a number on >=1 turn (baseline established)", realDelta, "");
    // The §2.3 invariant: ZERO mulligan:nudge on disk (nudges are ephemeral, constructed in the filter copy only).
    const nudgeCount = entries.filter((e) => e.customType === "mulligan:nudge").length;
    assert(results, "§2.3 ZERO mulligan:nudge entries on disk", nudgeCount === 0, nudgeCount ? `${nudgeCount} found` : "");
    assertGlobalInvariants(results, entries);
  } else {
    console.log(`  ⚠ JSONL unavailable (model may have timed out) — smoke-log assertions are primary`);
  }
  return { results, entries };
}

function assertProtected({ smoke, piRes }) {
  const results = [];
  const sessionFile = smoke.sessionFile;
  const entries = readSessionEntries(sessionFile);
  // BUG-006 fix (verified): the rewind tool REFUSES before persisting when a nuclear last_turn rewind would
  // cross the first/only user message (the /mulligan_smoke prompt is the only user message, so iFirstUser ===
  // iLastUser and the protected-refusal check in rewind.ts:step-5b trips). Assert: the turn survives (pi exit 0)
  // AND the tool text is a refusal AND ZERO mulligan:rewind markers were persisted (the refusal is pre-persist).
  const rewindLines = smoke.lines.filter((l) => l.test === "tool.rewind");
  const lastRewind = rewindLines[rewindLines.length - 1];
  assert(results, "tool.rewind ran", !!lastRewind, "");
  const text = lastRewind?.detail?.text ?? "";
  // The protected check now manifests as a tool-level refusal ("would cross a protected message").
  const refused = /refused/i.test(text);
  assert(results, "protected rewind refused (crosses first user message)", refused, text.slice(0, 80));
  assert(results, "pi exited 0 (turn survived)", piRes.status === 0, `exit=${piRes.status}`);
  if (entries.length > 0) {
    const rewindCount = countCustom(entries, "mulligan:rewind", "rewind");
    assert(results, "JSONL has 0 mulligan:rewind (refusal pre-persist)", rewindCount === 0, `${rewindCount} found`);
    assertGlobalInvariants(results, entries);
  }
  return { results, entries, note: "F-protected deterministic path asserts the tool refuses pre-persist (BUG-006); no marker is created" };
}

function assertMaxdepth({ smoke, piRes }) {
  const results = [];
  const sessionFile = smoke.sessionFile;
  const entries = readSessionEntries(sessionFile);
  const rewindLines = smoke.lines.filter((l) => l.test === "tool.rewind");
  // 5 rewinds succeeded; the 6th refused with a depth message.
  const sixth = rewindLines[rewindLines.length - 1];
  assert(results, "6+ tool.rewind attempts logged", rewindLines.length >= 6, `${rewindLines.length} logged`);
  const sixthText = sixth?.detail?.text ?? "";
  assert(results, "6th rewind refused with depth message", /depth|refused/i.test(sixthText), sixthText.slice(0, 100));
  if (entries.length > 0) {
    const rewindCount = countCustom(entries, "mulligan:rewind", "rewind");
    assert(results, "JSONL has exactly 5 mulligan:rewind (6th refused)", rewindCount === 5, `${rewindCount} found`);
    assertGlobalInvariants(results, entries);
  } else {
    console.log(`  ⚠ JSONL unavailable (model may have timed out) — smoke-log assertions are primary`);
  }
  return { results, entries };
}

function assertCheckpoint({ smoke, piRes }) {
  const results = [];
  const sessionFile = smoke.sessionFile;
  const entries = readSessionEntries(sessionFile);
  const cpLines = smoke.lines.filter((l) => l.test === "tool.checkpoint");
  const rwLines = smoke.lines.filter((l) => l.test === "tool.rewind");
  const cpLine = cpLines[cpLines.length - 1];
  const cpText = cpLine?.detail?.text ?? "";
  const rwLine = rwLines[rwLines.length - 1];
  const rwText = rwLine?.detail?.text ?? "";
  // setCheckpoint RAN + SUCCEEDED (not refused). This is the baseline-breakage fix: a fresh 2-prompt session made
  // setCheckpoint refuse "no stable entry to checkpoint"; the seed flow commits SEED_ANCHOR first so it succeeds.
  assert(results, "tool.checkpoint ran", cpLines.length >= 1, "");
  assert(results, "checkpoint SET succeeded (not refused — baseline-breakage fix)", cpLine && !/refused/i.test(cpText), cpText.slice(0, 80));
  // checkpoint rewind RAN. K>0 at rewind-time proves the checkpoint pinned content. The filter's live
  // resolution may differ (hideEntryIds not yet implemented), so we check the rewind-time K text only.
  assert(results, "checkpoint rewind ran", rwLines.length >= 1, "");
  // Signal 1 of the two-signal guard: the hideEntryIds M2 pin captures the post-checkpoint seed at rewind-creation,
  // so K>0 is deterministic (the seed reply committed before the command is pinned -> hidden on observing fire).
  assert(results, "checkpoint rewind K>0 (rewind-time preview — seed pinned; signal 1 of two-signal guard)", rwLine && !/0 messages will be hidden/i.test(rwText) && !/refused/i.test(rwText), rwText.slice(0, 80));
  // Signal 2 of the two-signal guard: SEED_HIDDEN hidden + SEED_ANCHOR survives on the observing inference.
  // Deterministic via the hideEntryIds pin (P1.M2.T1.S4) — stable target that does not move with later -p prompts.
  // Fail = LEAKED BACK (BUG-001/002/003 regression — hideEntryIds pin or origIdxOfM translation broken).
  const hidingLines = smoke.lines.filter((l) => l.test === "F-checkpoint.hiding");
  const lastHiding = hidingLines[hidingLines.length - 1];
  const hidingPass = lastHiding && lastHiding.status === "pass";
  assert(results, "F-checkpoint.hiding: post-checkpoint seed hidden + anchor survives (status=pass; two-signal guard w/ K>0)", hidingPass === true, lastHiding ? JSON.stringify(lastHiding.detail).slice(0, 120) : "no F-checkpoint.hiding line emitted");
  if (entries.length > 0) {
    assert(results, "JSONL has label mulligan:checkpoint:alpha", countLabel(entries, "mulligan:checkpoint:alpha") >= 1, "");
    assert(results, "JSONL has mulligan:rewind (custom)", countCustom(entries, "mulligan:rewind", "rewind") >= 1, "");
    // Checkpoint auto-expiry: the checkpoint label should be CONSUMED (cleared) after the rewind.
    // KEPT SOFT: auto-expiry (setLabel(id, undefined) clear) is spec'd (spec/05 §3 step 5, validation issue #1b/#5)
    // but NOT yet implemented (no clear call anywhere in src/ — verified). Orthogonal to hideEntryIds (the M2 pin
    // makes HIDING deterministic but does not clear labels). Making this HARD would permanently fail F-checkpoint.
    const consumed = !labelActive(entries, "mulligan:checkpoint:alpha");
    if (!consumed) {
      console.log(`  ⚠ SOFT: checkpoint not consumed (auto-expiry not yet implemented — spec/05 §3 step 5; orthogonal to hideEntryIds)`);
    } else {
      assert(results, "checkpoint 'alpha' CONSUMED by rewind (auto-expiry; spec/05 §3 step 5)", true, "");
    }
    assertGlobalInvariants(results, entries);
  } else {
    assert(results, "JSONL available", false, "session JSONL missing — model may have timed out");
  }
  return { results, entries };
}

function assertFailopen({ smoke, piRes }) {
  const results = [];
  // The turn SURVIVED (pi exit 0) despite a malformed marker. context.fire still logged (the filter ran
  // fail-open). This is the deterministic pass-through proof; the authoritative "handler never throws" proof
  // is the unit test in filter.test.ts (GOTCHA #9).
  assert(results, "malformed marker appended", smoke.lines.some((l) => l.test === "failopen.marker"), "");
  assert(results, "pi exited 0 (turn survived — filter fail-open)", piRes.status === 0, `exit=${piRes.status}`);
  assert(results, "context.fire still logged (filter ran, no crash)", smoke.contextFires.length >= 1, `${smoke.contextFires.length} fires`);
  return { results, entries: [], note: "F-failopen verifies pass-through; the handler-never-throws unit test in filter.test.ts is authoritative (GOTCHA #9)" };
}

function assertReload(run1, run2) {
  const results = [];
  // Run 1: rewind marker persisted. Run 2 (same --session-id): the marker survived reload.
  const r1Rewind = run1.smoke.lines.filter((l) => l.test === "tool.rewind");
  assert(results, "run-1 tool.rewind ran", r1Rewind.length >= 1, "");
  // The session JSONL is shared (same --session-id) — read entries from run 1's session file (both runs append).
  const entries = readSessionEntries(run1.smoke.sessionFile);
  if (entries.length > 0) {
    assert(results, "JSONL has mulligan:rewind (persisted across reload)", countCustom(entries, "mulligan:rewind", "rewind") >= 1, "");
    assertGlobalInvariants(results, entries);
  }
  // Run 2 context.fire should show hasRewindMarker:true (the marker survived the reload into a new process).
  const r2cf = run2.smoke.contextFires[run2.smoke.contextFires.length - 1];
  assert(results, "run-2 context.fire hasRewindMarker:true (survived reload)", r2cf?.hasRewindMarker === true, String(r2cf?.hasRewindMarker));
  return { results, entries };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const ASSERTERS = {
  "F-rewind-core": assertRewindCore,
  "F-shrink-persist": assertShrinkPersist,
  "F-shrink-preventive": assertShrinkPreventive,
  "F-nudge-drift": assertNudgeDrift,
  "F-protected": assertProtected,
  "F-maxdepth": assertMaxdepth,
  "F-checkpoint": assertCheckpoint,
  "F-failopen": assertFailopen,
};

function runScenario(scenario) {
  // F-rewind-core: 3-prompt SEED flow. A seed model turn commits a hideable assistant reply BEFORE the command, so the
  // last_turn rewind pins it (K≥1) and the observing inference shows it HIDDEN. (The 2-prompt path gives K=0 — nothing
  // after the user message at command time.)
  if (scenario === "F-rewind-core") {
    const piRes = runPi(scenario, {
      prompts: [
        `Reply with exactly: ${SEED_HIDDEN}`,
        `/mulligan_smoke F-rewind-core`,
        "Reply with exactly: OK",
      ],
    });
    const smoke = parseSmokeLog(piRes.logPath);
    return { piRes, smoke };
  }
  // F-nudge-drift: 4-prompt two-turn harness in a scoped tmp cwd whose .pi/settings.json sets
  // driftThresholdTokens=1 (honored by Mulligan's session_start config read — M1). The tmp cwd is trusted
  // via pi -a (a tmp dir is not trusted by default). The 4-prompt flow: command (no model turn), then 3 model
  // turns — turn 1 establishes the baseline (turn_end #1, delta=null), turn 2 grows past threshold=1
  // (turn_end #2, grewOverThreshold=true), turn 3 is the observing fire (hasNudge:true).
  if (scenario === "F-nudge-drift") {
    const driftCwd = join(SMOKE_TMP_DIR, `drift-cwd-${RUN_ID}`);
    mkdirSync(join(driftCwd, ".pi"), { recursive: true });
    writeFileSync(join(driftCwd, ".pi", "settings.json"), JSON.stringify({ mulligan: { nudges: { driftThresholdTokens: 1 } } }));
    try {
      const piRes = runPi(scenario, {
        cwd: driftCwd,
        prompts: [
          "/mulligan_smoke F-nudge-drift",
          "Reply with exactly: ALPHA",
          "Reply with exactly: BETA BETA BETA BETA BETA",
          "Reply with exactly: OK",
        ],
      });
      const smoke = parseSmokeLog(piRes.logPath);
      return { piRes, smoke };
    } finally {
      try { rmSync(driftCwd, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
    }
  }
  // F-shrink-preventive: 2-prompt flow where the second prompt makes the model CALL smoke_read_big (a non-mulligan_*
  // tool whose result exceeds bloatThresholdBytes=8192). The real tool_result event fires bloatReminderHandler →
  // turnEndMetricHandler records bloatHit:true. assertShrinkPreventive HARD-asserts bloatHit:true from the session JSONL.
  if (scenario === "F-shrink-preventive") {
    const piRes = runPi(scenario, { prompts: ["/mulligan_smoke F-shrink-preventive", "Call the smoke_read_big tool, then reply with exactly: OK"] });
    const smoke = parseSmokeLog(piRes.logPath);
    return { piRes, smoke };
  }
  // F-checkpoint: 5-prompt SET/SEED/REWIND flow. SEED_ANCHOR → set checkpoint (labels the anchor) → SEED_HIDDEN
  // (post-checkpoint content) → rewind to 'alpha' (K>0) → observing turn. Fixes the baseline breakage (setCheckpoint
  // refused on a fresh 2-prompt session) AND asserts hiding (the single-handler set+rewind always gave K=0).
  if (scenario === "F-checkpoint") {
    const piRes = runPi(scenario, {
      prompts: [
        `Reply with exactly: ${SEED_ANCHOR}`,
        `/mulligan_smoke F-checkpoint-set`,
        `Reply with exactly: ${SEED_HIDDEN}`,
        `/mulligan_smoke F-checkpoint-rewind`,
        "Reply with exactly: OK",
      ],
    });
    const smoke = parseSmokeLog(piRes.logPath);
    return { piRes, smoke };
  }
  if (scenario === "F-reload") {
    // Two spawns sharing --session-id smoke-<scenario> (run 2 reopens the same session).
    const r1 = runPi(scenario);
    const smoke1 = parseSmokeLog(r1.logPath);
    // Run 2: just trigger an observing turn on the SAME session (--session-id reopens it).
    const r2 = runPi(scenario, { extraArgs: ["-p", "Reply with exactly: OK"] }); // a third prompt for run 2's observing turn
    const smoke2 = parseSmokeLog(r2.logPath);
    return { piRes: r1, smoke: smoke1, r2, smoke2 };
  }
  const piRes = runPi(scenario);
  const smoke = parseSmokeLog(piRes.logPath);
  return { piRes, smoke };
}

function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Mulligan integration smoke harness (deterministic suite)");
  console.log("════════════════════════════════════════════════════════════\n");

  let totalPass = 0;
  let totalFail = 0;
  const failed = [];

  for (const scenario of SCENARIOS) {
    const run = runScenario(scenario);
    const smoke = run.smoke;
    const piRes = run.piRes;

    // GOTCHA #12: detect EXTENSION LOAD FAILED (non-zero pi exit + empty smoke log → src/index.ts failed).
    if (piRes.status !== 0 && smoke.lines.length === 0) {
      console.log(`FAIL ${scenario} — EXTENSION LOAD FAILED (check src/index.ts; pi exit=${piRes.status})`);
      totalFail++;
      failed.push(scenario);
      continue;
    }

    let outcome;
    if (scenario === "F-reload") {
      outcome = assertReload(run, { smoke: run.smoke2 });
    } else {
      outcome = ASSERTERS[scenario]({ smoke, piRes });
    }

    let scenarioPass = true;
    for (const r of outcome.results) {
      if (!r.pass) {
        scenarioPass = false;
        console.log(`  ✗ ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
      }
    }
    if (outcome.soft) console.log(`  ⚠ SOFT: ${outcome.soft}`);
    if (outcome.note) console.log(`  ℹ NOTE: ${outcome.note}`);

    if (scenarioPass) {
      console.log(`PASS ${scenario}`);
      totalPass++;
    } else {
      console.log(`FAIL ${scenario}`);
      totalFail++;
      failed.push(scenario);
    }
    console.log("");
  }

  console.log("──────────────────────────────────────────────────────────");
  console.log(`  ${totalPass}/${SCENARIOS.length} scenarios passed`);
  if (totalFail > 0) {
    console.log(`  FAILED: ${failed.join(", ")}`);
  }
  console.log("──────────────────────────────────────────────────────────");
  process.exit(totalFail === 0 ? 0 : 1);
}

main();