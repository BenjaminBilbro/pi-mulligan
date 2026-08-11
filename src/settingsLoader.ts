/**
 * Settings loader — reads Mulligan's `mulligan` config from Pi's settings.json files.
 *
 * Pure, Pi-free leaf module: imports ONLY node: builtins (fs / path / os).
 * No config.ts, no log.ts import — fully
 * unit-testable with tmp-dir fixtures.
 *
 * Precedence: project-local REPLACES global at the `mulligan` key (top-level
 * replace, NOT deep-merge). validateConfig() in config.ts fills sub-key defaults.
 *
 * Source: spec/09-configuration.md §1, architecture/external_deps.md §1-§2,
 * architecture/design_decisions.md BUG-001.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Options accepted by loadMulliganSettings. */
export type LoadMulliganSettingsOptions = {
  /** Project working directory for local .pi/settings.json. */
  cwd?: string;
  /** Only read the local file when strictly true (fail-safe for untrusted projects). */
  isTrusted?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers (module-local; not exported)
// ─────────────────────────────────────────────────────────────────────────────

/** True for plain records and Object.create(null); false for null, primitives, and arrays.
 *  Mirrors config.ts:isRecord. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return obj.mulligan when it exists as an own property (incl. null/0/false),
 *  or undefined when absent / obj is not a record. */
function mulliganValueIfPresent(obj: unknown): unknown {
  if (isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, "mulligan")) {
    return obj.mulligan;
  }
  return undefined;
}

/** Emit a console.warn for an unreadable settings file. Wrapped in try/catch
 *  so the warn itself never throws (mirrors config.ts:warnConfig / log.ts:writeStderrFallback). */
function warnUnreadable(filePath: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mulligan] settings: ${filePath} unreadable: ${msg}`);
  } catch {
    /* never throw — logging must not crash the extension */
  }
}

/** Check whether an error is a "file not found" class error (ENOENT).
 *  Node fs errors have a .code property; ENOENT means the file simply doesn't exist. */
function isNotFound(err: unknown): boolean {
  return (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT");
}

/** Read and parse a settings.json file, returning the `mulligan` own-key value
 *  if present, or undefined. Missing file (ENOENT) → silently skip.
 *  Malformed JSON (SyntaxError) or other fs errors → warn + skip. */
function readMulliganKey(filePath: string): unknown {
  try {
    const txt = readFileSync(filePath, "utf8");
    const obj = JSON.parse(txt);
    return mulliganValueIfPresent(obj);
  } catch (e) {
    if (!isNotFound(e)) {
      warnUnreadable(filePath, e);
    }
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * loadMulliganSettings — read the `mulligan` config from Pi's settings files.
 *
 * 1. GLOBAL: ~/.pi/agent/settings.json — always read (user's own home is trusted).
 * 2. LOCAL:  <cwd>/.pi/settings.json — read ONLY when opts.isTrusted === true.
 * 3. MERGE:  if the local file contributes a `mulligan` key (any value, incl. null),
 *            it REPLACES the global `mulligan` entirely (top-level replace, NOT deep-merge).
 *            Otherwise the global `mulligan` (if any) is used.
 * 4. Return the merged `mulligan` value (unknown), or undefined when neither file
 *    has a `mulligan` key. Non-object `.mulligan` values are returned as-is for
 *    config.ts:validateConfig to coerce.
 * 5. NEVER throws (missing/unreadable → silent skip; malformed → warn + skip).
 * 6. No caching — the caller (factory / session_start) decides when to re-read.
 */
export function loadMulliganSettings(opts?: LoadMulliganSettingsOptions): unknown {
  const globalMulligan = readMulliganKey(join(homedir(), ".pi", "agent", "settings.json"));

  // Local file is only read when the caller explicitly trusts the project (strict === true).
  // If cwd is missing despite isTrusted===true, skip local (fail-safe — no ENOENT from join).
  if (opts?.isTrusted === true && typeof opts?.cwd === "string") {
    const localMulligan = readMulliganKey(join(opts.cwd, ".pi", "settings.json"));
    if (localMulligan !== undefined) {
      return localMulligan; // local REPLACES global (top-level replace)
    }
  }

  return globalMulligan;
}
