/**
 * Structured JSONL logger — Mulligan's primary observability surface in non-TUI modes.
 * spec/04-data-model.md §9 (LogLine), spec/09-configuration.md §4 (fail-open), spec/03 principle #4,
 * spec/11-build-order.md §1 ("log.ts // structured JSONL logger").
 *
 * DESIGN:
 * - Pi-free AND config-free: holds its OWN destination (`logFile`), configured via setLogFile().
 *   index.ts (P1.M7.T1) calls setLogFile(getConfig().log.file) after config load. This breaks the
 *   config↔log cycle (log.ts imports neither config.ts nor Pi) and avoids the chicken-and-egg timing bug
 *   (the log path comes FROM the config under validation).
 * - No-op when `logFile` is null (the default; "off").
 * - Fail-open: a bad path / circular data / BigInt data can NEVER crash the extension — the failing write is
 *   caught, a short note goes to process.stderr, and the error is swallowed (spec/03 #4, spec/09 §4).
 *
 * Level-filter decision: all 4 levels are written verbatim in v1 because config.log has ONLY `file`
 * (no `level` knob). A level filter may be added in v1.1 via env override (spec/09 §5).
 */
import { appendFileSync } from "node:fs";

/** The four severity levels a LogLine may carry (spec/04 §9). */
export type Level = "debug" | "info" | "warn" | "error";

/**
 * LogLine — one JSON object per line, append-only (spec/04-data-model.md §9).
 * `data` is OPTIONAL; when `undefined` it is omitted from the serialized line (JSON.stringify drops
 * undefined-valued keys), matching the `data?` schema.
 */
export interface LogLine {
  /** ISO 8601 UTC timestamp (new Date().toISOString()). */
  ts: string;
  /** Severity. */
  level: Level;
  /** Dotted event name, e.g. "rewind.applied", "filter.fire", "nudge.inject". */
  event: string;
  /** Pi session id this event belongs to. */
  sessionId: string;
  /** Optional structured payload. Omitted from the line when undefined; JSON null stays a real null. */
  data?: unknown;
}

/**
 * Current log destination. `null` ⇒ logging is OFF (no-op). Set by setLogFile() (called from index.ts once
 * config is loaded, P1.M7.T1). Module-level mutable state: tests MUST reset via setLogFile(null) in beforeEach.
 */
let logFile: string | null = null;

/**
 * setLogFile — set/replace the log destination, or pass null to disable logging.
 * Called from index.ts (P1.M7.T1): setLogFile(getConfig().log.file). Assigning a string cannot throw.
 * Opening is DEFERRED to the first write inside log(); no eager open here.
 */
export function setLogFile(path: string | null): void {
  logFile = path;
}

/**
 * log — append one structured JSONL line for `event`.
 *
 * (a) If no log file is configured (null), return immediately (no-op).
 * (b) Build the LogLine { ts, level, event, sessionId, data }.
 * (c) Append `JSON.stringify(line) + "\n"` via appendFileSync, wrapped in try/catch.
 * (d) On ANY error (bad path → ENOENT/EISDIR/EACCES/ENOSPC; circular/BigInt data → TypeError): write a short
 *     note to process.stderr and swallow. NEVER throw — logging must not crash the extension (spec/03 #4).
 */
export function log(level: Level, event: string, sessionId: string, data?: unknown): void {
  const dest = logFile;
  if (dest === null) {
    return; // logging disabled — no-op (spec/09 §3: log.file default null = off)
  }

  const line: LogLine = {
    ts: new Date().toISOString(),
    level,
    event,
    sessionId,
    data,
  };

  try {
    // JSON.stringify AND appendFileSync share this try: stringify throws TypeError on circular refs / BigInt
    // (MDN); appendFileSync throws ENOENT/EISDIR/EACCES on a bad path (Node fs). Both → catch → stderr fallback.
    // (data: undefined is dropped by JSON.stringify, so data-less lines have no `data` key.)
    appendFileSync(dest, JSON.stringify(line) + "\n", "utf8");
  } catch (err) {
    writeStderrFallback(dest, level, event, err);
  }
}

/** logInfo / logDebug / logWarn / logError — convenience helpers that curry the level. */
export function logInfo(event: string, sessionId: string, data?: unknown): void {
  log("info", event, sessionId, data);
}
export function logDebug(event: string, sessionId: string, data?: unknown): void {
  log("debug", event, sessionId, data);
}
export function logWarn(event: string, sessionId: string, data?: unknown): void {
  log("warn", event, sessionId, data);
}
export function logError(event: string, sessionId: string, data?: unknown): void {
  log("error", event, sessionId, data);
}

/**
 * writeStderrFallback — last-resort visibility when a log write fails. Wrapped in its own try/catch so even a
 * failing stderr write can never throw. Uses String(err) (always safe; includes the Node error code in the
 * message for fs errors) rather than err.code (base Error has no .code; the payload may not be an Error).
 */
function writeStderrFallback(dest: string, level: Level, event: string, err: unknown): void {
  try {
    process.stderr.write(
      `[mulligan] log: write failed (event=${event} level=${level} dest=${dest}): ${String(err)}\n`,
    );
  } catch {
    /* swallow — logging must never crash the extension */
  }
}
