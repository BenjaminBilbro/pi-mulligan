/**
 * Pure, Pi-free settings loader — reads Mulligan config from Pi's settings.json files on disk.
 *
 * Honors spec/09 §1: reads the global ~/.pi/agent/settings.json unconditionally,
 * and the project-local <cwd>/.pi/settings.json ONLY when opts.isTrusted === true.
 * Extracts the `mulligan` own-key from each file; applies project-local-over-global
 * TOP-LEVEL REPLACE precedence (NOT deep-merge — spec/09 §1 "project-local wins").
 *
 * This module imports ONLY node: builtins (fs/path/os) — NO pi, NO config, NO log —
 * so it is fully unit-testable with tmp-dir fixtures.
 *
 * Architecture: design_decisions.md BUG-001+BUG-006 section.
 * File locations: external_deps.md §2.
 * No settings accessor on Pi's ExtensionAPI: external_deps.md §1.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Options for loadMulliganSettings.
 * - cwd: project working directory for the local .pi/settings.json read.
 * - isTrusted: must be strictly `true` to read the local file (fail-safe for untrusted projects).
 */
export type LoadMulliganSettingsOptions = {
  cwd?: string;
  isTrusted?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers (module-local; not exported)
// ─────────────────────────────────────────────────────────────────────────────

/** True for plain records and Object.create(null); false for null, primitives, and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the `mulligan` own-key from a parsed JSON value.
 * Returns the value (including null/0/false) when present via hasOwnProperty;
 * returns undefined when absent or when obj is not a record.
 */
function mulliganValueIfPresent(obj: unknown): unknown {
  if (isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, "mulligan")) {
    return obj.mulligan;
  }
  return undefined;
}

/**
 * Fail-safe warn for malformed/unreadable settings files.
 * Wrapped in try/catch so logging itself never throws (mirrors config.ts:warnConfig
 * and log.ts:writeStderrFallback).
 */
function warnUnreadable(filePath: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mulligan] settings: ${filePath} unreadable: ${msg}`);
  } catch {
    /* never throw — logging must not crash the extension */
  }
}

/**
 * Read a settings file and extract its `mulligan` key.
 * Catches ENOENT/EACCES/EISDIR (missing/unreadable) and JSON SyntaxError (malformed, incl. JSONC comments)
 * uniformly — warns on malformed/IO errors, silently skips missing files, and never throws.
 */
function readMulliganKey(filePath: string): unknown {
  try {
    const txt = readFileSync(filePath, "utf8");
    const obj = JSON.parse(txt);
    return mulliganValueIfPresent(obj);
  } catch (e) {
    // ENOENT (missing file) → silently skip (no warn — file simply doesn't exist).
    // All other errors (malformed JSON, EACCES, EISDIR, etc.) → warn + skip.
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    warnUnreadable(filePath, e);
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * loadMulliganSettings — read the `mulligan` config from Pi's settings files on disk.
 *
 * 1. Reads the global ~/.pi/agent/settings.json unconditionally.
 * 2. When opts.isTrusted === true AND opts.cwd is a string, reads the local <cwd>/.pi/settings.json.
 * 3. If the local file has a `mulligan` own-key (any value incl. null), it REPLACES the global value
 *    entirely (top-level replace, NOT deep-merge — spec/09 §1).
 * 4. Returns the merged `mulligan` value, or `undefined` when neither file contributes a mulligan key.
 *
 * Never throws. No caching. No validation (config.ts:validateConfig handles that).
 */
export function loadMulliganSettings(opts?: LoadMulliganSettingsOptions): unknown {
  const globalMulligan = readMulliganKey(join(homedir(), ".pi", "agent", "settings.json"));

  if (opts?.isTrusted === true && typeof opts?.cwd === "string") {
    const localMulligan = readMulliganKey(join(opts.cwd, ".pi", "settings.json"));
    if (localMulligan !== undefined) {
      return localMulligan;
    }
  }

  return globalMulligan;
}
