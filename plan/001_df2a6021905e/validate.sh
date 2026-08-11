#!/usr/bin/env bash
#
# validate.sh — deterministic, exit-code-driven proof that pi-mulligan satisfies its PRD.
#
# Pipeline contract: the FIRST failing gate exits non-zero (set -e propagates it) and the
# pipeline treats that as an ABORT (PRD §4.4 abort-on-failure). Exit 0 only if EVERY gate
# passes. The pipeline enforces its own VALIDATION_TIMEOUT watchdog on the whole script, so
# this script does NOT wrap itself in an unbounded `timeout`. A per-gate timeout is used only
# on the single extension-load model call, so a stall there surfaces as a clean failure
# instead of silently consuming the whole budget.
#
# Gate → PRD "Definition of done" (spec/11 §3) mapping:
#   0 preflight    environment sanity (tools + project files present)            [fail-fast]
#   1 readme       README documents install + 4 tools + config + soft-delete      [DoD #6]
#   2 typecheck    tsc --noEmit — strict types (ReadonlySessionManager contract)  [DoD #1/edge §E13]
#   3 unit tests   vitest run — Tier-1 pure helpers + property tests + tools      [DoD #1, #4, #5-unit]
#   4 load         extension loads under real pi with zero config                 [spec/11 §2 Step 0]
#   5 smoke        all F-* scenarios via real `pi -p`; zero persisted nudges       [DoD #2, #3, #5-integration]
#
set -euo pipefail

# ── locate the repo root (this script ships in plan/001_df2a6021905e/) ──────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

fail() { echo; echo "✗ VALIDATION FAILED: $*" >&2; exit 1; }

# Print a one-line context header (gate name + exact command), then run the command.
# set -e propagates any non-zero exit as an immediate abort.
run_gate() {
  local label="$1"; shift
  echo
  echo "▶ GATE: $label"
  echo "  \$ $*"
  "$@"
}

echo "═══════════════════════════════════════════════════════════"
echo "  pi-mulligan — PRD validation (spec/11 §3 definition of done)"
echo "  repo: $REPO_ROOT"
echo "═══════════════════════════════════════════════════════════"

# ── Gate 0: preflight (fail fast on a broken environment) ──────────────────────
echo "▶ GATE: preflight — toolchain & project files"
for c in node npm npx pi; do
  command -v "$c" >/dev/null 2>&1 || fail "required command not on PATH: $c"
done
[ -f package.json ]        || fail "package.json not found at repo root ($REPO_ROOT)"
[ -f src/index.ts ]        || fail "src/index.ts not found (extension entry missing)"
[ -x node_modules/.bin/vitest ] || fail "node_modules/.bin/vitest missing — run 'npm install' first"
[ -x node_modules/.bin/tsc ]    || fail "node_modules/.bin/tsc missing — run 'npm install' first"
echo "  ok: node/npm/npx/pi on PATH; package.json, src/index.ts, local vitest+tsc present"

# ── Gate 1: README documentation (DoD #6) ──────────────────────────────────────
# README must document: install, all four tools, configuration, and the soft-delete // /tree
# audit-trail guarantee. Cheap and deterministic; catches a documentation regression.
echo "▶ GATE: README documents install + 4 tools + config + soft-delete guarantee (DoD #6)"
check_doc() { grep -q -- "$1" README.md || fail "README.md missing required mention: $1"; }
check_doc "Installation"
check_doc "mulligan_rewind"
check_doc "mulligan_shrink"
check_doc "mulligan_checkpoint"
check_doc "mulligan_audit"
check_doc "Configuration"
check_doc "soft-delete"
check_doc "/tree"
echo "  ok: README.md documents install, all four tools, configuration, and the soft-delete // /tree guarantee"

# ── Gate 2: typecheck (DoD #1 surface; the spec leans on exact Pi types) ────────
# Strict TS catches contract drift on the load-bearing surfaces (e.g. ReadonlySessionManager
# is a read-only Pick — a stray mutator call fails to compile).
run_gate "typecheck (tsc --noEmit) — strict types" npx tsc --noEmit
echo "  ok: tsc --noEmit exit 0"

# ── Gate 3: unit tests (DoD #1, #4, #5-unit) ────────────────────────────────────
# vitest run = non-interactive CI mode. Covers the Tier-1 pure helpers (transforms, ledger,
# tokens, notes, pipeline), the pairing-invariant property test on randomized inputs, the
# config.enabled=false no-op behavior, and the filter fail-open unit test.
run_gate "unit tests (npm test → vitest run) — Tier-1 helpers, property tests, tools, filter" npm test
echo "  ok: npm test (vitest run) passed"

# ── Gate 4: extension loads under real pi (spec/11 §2 Step 0) ───────────────────
# -ne disables extension discovery so ONLY ./src/index.ts loads (isolated, deterministic —
# same isolation the smoke harness uses). `-p "hi"` drives one model turn so a load error or a
# thrown factory surfaces. Bounded so a stalled model call fails fast instead of hanging.
run_gate "extension loads under real pi, zero config (spec/11 §2 Step 0)" timeout 180 pi -ne -e ./src/index.ts -p "hi"
echo "  ok: pi -ne -e ./src/index.ts -p hi exit 0 (extension loaded cleanly with defaults)"

# ── Gate 5: integration smoke (DoD #2, #3, #5-integration) ─────────────────────
# Drives all F-* scenarios (F-rewind-core, F-shrink-persist, F-shrink-preventive, F-nudge-drift,
# F-protected, F-maxdepth, F-checkpoint, F-failopen, F-reload) against a real `pi -p` run and
# asserts on the smoke JSONL log + session JSONL. The harness also enforces the §2.3 global
# invariants per scenario — including ZERO persisted mulligan:nudge entries (DoD #3) and that
# markers are `custom` entries while notes are `custom_message`. The harness self-manages a
# per-spawn timeout; the pipeline's VALIDATION_TIMEOUT bounds the overall run.
run_gate "integration smoke — all F-* scenarios via real pi -p (npm run smoke)" npm run smoke
echo "  ok: npm run smoke — all F-* scenarios passed"

echo
echo "═══════════════════════════════════════════════════════════"
echo "  ALL GATES PASSED"
echo "═══════════════════════════════════════════════════════════"
