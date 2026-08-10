/**
 * ledger.ts — deterministic file-ledger extraction for Mulligan's rewind note.
 * spec/04-data-model.md §2.2 (FileLedger + extraction rules), spec/10-testing.md §1.6 (pinned test),
 *   spec/05-tools.md §1 step 5 (the rewind tool is the consumer; "the ledger is advisory / best-effort"),
 *   spec/08-edge-cases.md E5/E1/E8/E13 (side-effect safety, orphan toolResult, empty span, fail-open),
 *   spec/03-architecture.md §2.3/§7 (pure helper, sibling of tokens.ts), spec/06 §2-§4 (range = number[] of indices).
 *
 * DESIGN (read GOTCHA #1–#14 in the PRP):
 * - Foundation-tier and Pi-FREE. Imports NOTHING — not Pi, not config, not log, not runtime, NOT tokens.ts. It is a
 *   pure, deterministic, side-effect-free function fully unit-testable in isolation; it is the consumer of NO other
 *   module (sibling of tokens.ts per spec/11 §1). It defines its OWN local structural types.
 * - `extractFileLedger(messages, range)` scans the assistant messages at the given indices, classifies their toolCall
 *   blocks into readFiles / modifiedFiles / bashSideEffects, de-duplicates + sorts each, and returns the FileLedger.
 *   `range` is a number[] of MESSAGE INDICES (from the rewind resolver — NOT a [start,end) tuple; a unit's indices
 *   include both assistant and toolResult messages, so we filter to assistant messages).
 * - The bash policy is ASYMMETRIC (the contract crux): bashSideEffects is HIGH-RECALL ("when in doubt, include" — a
 *   missed write is the dangerous failure, E5); modifiedFiles-from-bash is HIGH-PRECISION (redirect targets always,
 *   file-like args only from commands known to mutate files by path). git commit → bashSideEffects only, no
 *   modifiedFiles. Paths are returned VERBATIM (no cwd normalization — pure function, GOTCHA #6).
 * - NEVER throws (rewind-tool hot path, E13). isRecord/readOwn swallow Proxy-trap throws; non-array messages/range/
 *   content → empty ledger; out-of-bounds/non-assistant/non-toolCall → skipped. We only read .path/.file_path/.command
 *   (never JSON.stringify arguments), so circular arguments are harmless (unlike tokens.ts which sizes arguments).
 */

// ── local structural types (mirror tokens.ts; api_verification.md §6.1/§6.2) ────

/** A tool-call content block (assistant only) — the substance is name + arguments. */
interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Any content block (we only ever inspect toolCall blocks; others are ignored). */
type ContentBlock = ToolCallContent | { type: string; [key: string]: unknown };

/**
 * Minimal structural message shape. Any Pi AgentMessage variant (user / assistant / toolResult / custom /
 * bashExecution / branchSummary / compactionSummary) satisfies this: each carries a `content` that is a plain string
 * or an array of content blocks. EXPORTED so tests + tools/rewind.ts can type their inputs (like tokens.ts's MessageLike).
 */
export interface MessageLike {
  role?: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}

/** The deterministic file ledger appended to the rewind note (spec/04 §2.2 — field names are load-bearing). */
export interface FileLedger {
  /** Paths from read/grep/rg/glob/find/ls tool calls' path/file_path args (de-duplicated, sorted). */
  readFiles: string[];
  /** Paths from write/edit tool calls + high-confidence bash write paths (de-duplicated, sorted). */
  modifiedFiles: string[];
  /** Non-read-only bash command strings, verbatim (de-duplicated, sorted). High-recall ("when in doubt, include"). */
  bashSideEffects: string[];
}

// ── tool-name sets ──────────────────────────────────────────────────────────────
// Contract (spec/04 §2.2): readFiles from {read,grep,rg,glob}; modifiedFiles from {write,edit,bash}. We ADD `find`
// and `ls` to the read set because those are Pi's ACTUAL read-only discovery tool names (there is no `glob`/`rg` tool
// in Pi — GOTCHA #3). The set is a const Set; trivially extensible. Do NOT add write/edit/bash here.
const READ_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "rg", "glob", "find", "ls"]);
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);
const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(["bash"]);

// ── bash classification constants ───────────────────────────────────────────────
// Commands PROVABLY read-only (stdout only, no fs mutation in their common form). Excludes commands with mutating
// forms that need flag inspection (sort -o, hostname <name>, date -s, dd) — those default to side-effect (safe).
// `find` IS here (contract lists it read-only) but is guarded by FIND_MUTATING_RE (GOTCHA #9). `cd`/`export`/`source`
// are intentionally ABSENT: `.`/source execute arbitrary code; cd/export are shell-state (left as side-effect = safe).
const READ_ONLY_BASH_COMMANDS: ReadonlySet<string> = new Set([
  // listing / inspection
  "ls", "tree", "file", "stat", "readlink", "realpath", "du", "df", "free", "find",
  // reading / paging
  "cat", "head", "tail", "less", "more", "tac", "nl",
  // counting / formatting (stdout only)
  "wc", "echo", "printf", "seq", "column", "fold", "rev",
  // identity / system info
  "pwd", "whoami", "id", "uname", "uptime", "tty", "arch", "nproc", "getconf",
  // command lookup
  "which", "type", "command", "whereis", "hash",
  // environment print
  "env", "printenv", "locale",
  // comparison
  "diff", "cmp", "comm", "test", "[",
  // text filters (stdout only)
  "uniq", "cut", "paste", "tr",
  // search
  "grep", "egrep", "fgrep", "rg", "ag",
  // path components
  "basename", "dirname",
  // control / no-op
  "sleep", "true", "false",
]);

// Commands KNOWN to mutate files by PATH argument (used for precision-favoring modifiedFiles extraction from bash).
// For these, non-flag args that look like file paths → modifiedFiles. curl/wget included: looksLikeFilePath rejects
// URLs, so `curl -o out.txt <url>` → out.txt and `curl <url>` → no path. git/node/npm/make are intentionally ABSENT:
// their path-like args (script.js, build target) are NOT reliable "modified files" → bashSideEffects only (GOTCHA #5).
const FILE_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln", "tee", "truncate",
  "install", "patch", "sed", "split", "csplit", "curl", "wget",
]);

// Device/special targets that must NEVER appear in modifiedFiles (GOTCHA #11).
const IGNORE_PATHS: ReadonlySet<string> = new Set([
  "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/full", "/dev/zero",
]);

// Output redirect that WRITES TO A FILE. Excludes fd-duplication (2>&1, 1>&2, >&1 — target begins with '&') and
// comparison (>= — '>' followed by '='). Capture group 1 = the target path. Validated (GOTCHA #8).
const REDIRECT_WRITE_RE: RegExp = /(?:\d?&?>{1,2}\|?)\s*(?!&|=)([^\s;|&<>]+)/;

// find's destructive flags → the find command is NOT read-only (prevents `find . -delete` mis-classification, GOTCHA #9).
const FIND_MUTATING_RE: RegExp = /(?:^|\s)-(?:delete|exec|ok|okdir|fls|fprint|fprint0)(?=\s|$|=)/;

/**
 * extractFileLedger — deterministic read/modified/bash classification of the tool calls in a message span.
 *
 * Iterates `range` (a number[] of message indices into `messages`), inspects only `assistant` messages' `toolCall`
 * blocks, and classifies each by tool name: read family → readFiles; write/edit → modifiedFiles; bash → read-only
 * (ignored) or bashSideEffects (+ a high-confidence modifiedFiles path when parseable). Unknown tool names are
 * ignored (forward-compat). All three arrays are de-duplicated + sorted. Returns the FileLedger.
 *
 * Pure + defensive: null/non-array `messages` or `range` → empty ledger; out-of-bounds indices, non-assistant
 * messages, non-array content, non-record/non-toolCall blocks, missing/mistyped fields, circular `arguments`, and
 * throwing-Proxy messages are all skipped — NEVER throws (E13; sits on the rewind-tool hot path).
 *
 * @param messages the full message list (a real Pi AgentMessage[] assigns in with no cast)
 * @param range    number[] of MESSAGE INDICES defining the span to scan (NOT a [start,end) tuple)
 * @returns { readFiles, modifiedFiles, bashSideEffects } — each a de-duplicated, sorted string[]
 */
export function extractFileLedger(
  messages: MessageLike[] | null | undefined,
  range: number[] | null | undefined,
): FileLedger {
  const read = new Set<string>();
  const modified = new Set<string>();
  const bash = new Set<string>();

  const list = Array.isArray(messages) ? messages : [];
  const indices = Array.isArray(range) ? range : [];

  for (const i of indices) {
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= list.length) continue; // out-of-bounds/garbage
    const msg = list[i];
    if (!isRecord(msg)) continue;
    if (readOwn(msg, "role") !== "assistant") continue; // only assistant messages carry toolCall blocks
    const content = readOwn(msg, "content");
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (readOwn(block, "type") !== "toolCall") continue; // only toolCall blocks
      const name = readStringField(block, "name");
      const args = readOwn(block, "arguments");
      classifyToolCall(name, args, read, modified, bash);
    }
  }

  return {
    readFiles: dedupeSorted(read),
    modifiedFiles: dedupeSorted(modified),
    bashSideEffects: dedupeSorted(bash),
  };
}

/** Classify one tool call into the three accumulating buckets (module-private). */
function classifyToolCall(
  name: string,
  args: unknown,
  read: Set<string>,
  modified: Set<string>,
  bash: Set<string>,
): void {
  if (!name) return;
  if (READ_TOOL_NAMES.has(name)) {
    const p = pathArg(args);
    if (p) read.add(p);
    return;
  }
  if (WRITE_TOOL_NAMES.has(name)) {
    const p = pathArg(args);
    if (p) modified.add(p);
    return;
  }
  if (BASH_TOOL_NAMES.has(name)) {
    const command = isRecord(args) ? readStringField(args, "command") : "";
    if (!command || isReadOnlyBash(command)) return; // read-only (or empty) → ignore
    bash.add(command); // HIGH-RECALL: any non-provably-read-only command → bashSideEffects (verbatim)
    for (const p of extractWritePaths(command)) modified.add(p); // HIGH-PRECISION: confident paths only
    return;
  }
  // unknown tool name → ignore (forward-compat; e.g. mulligan_rewind's own call, if ever in range)
}

/** Read the path argument: arguments.path ?? arguments.file_path (Pi's read accepts either — GOTCHA #4). */
function pathArg(args: unknown): string {
  if (!isRecord(args)) return "";
  const path = readStringField(args, "path");
  if (path) return path;
  return readStringField(args, "file_path");
}

// ── bash classification helpers (module-private) ───────────────────────────────

/** True iff the command is PROVABLY read-only: every top-level segment is a read-only command, no write redirect,
 *  and no destructive find flags. Conservative by design ("when in doubt, include" → return false). */
function isReadOnlyBash(command: string): boolean {
  for (const seg of splitTopLevel(command)) {
    if (seg.trim() === "") continue;
    if (!isSegmentReadOnly(seg)) return false;
  }
  return true;
}

/** One pipeline/compound segment is read-only iff: no write redirect, its command is in the read-only set, and (for
 *  find) it has no destructive flag. */
function isSegmentReadOnly(seg: string): boolean {
  if (hasWriteRedirect(seg)) return false; // any output redirect → not read-only
  const name = firstCommandName(seg);
  if (!READ_ONLY_BASH_COMMANDS.has(name)) return false; // unknown / mutating command → not read-only
  if (name === "find" && FIND_MUTATING_RE.test(seg)) return false; // find -delete/-exec → not read-only (GOTCHA #9)
  return true;
}

/** Extract high-confidence MODIFIED-FILE paths from a non-read-only command: redirect targets (always) + file-like
 *  args from segments whose command is a known file-mutator. Precision-favoring (GOTCHA #5). */
function extractWritePaths(command: string): string[] {
  const paths = new Set<string>();
  for (const p of extractRedirectTargets(command)) paths.add(p); // `> file` / `>> file` / `&> file` (excludes /dev/null)
  for (const seg of splitTopLevel(command)) {
    const name = firstCommandName(seg);
    if (!FILE_MUTATING_COMMANDS.has(name)) continue; // git/node/npm/make → no token-scan (their args aren't reliable)
    for (const tok of splitShellTokens(seg)) {
      const t = stripQuotes(tok);
      if (looksLikeFilePath(t) && !IGNORE_PATHS.has(t)) paths.add(t);
    }
  }
  return [...paths];
}

/** True if the command contains an output redirect that writes to a file (excludes 2>&1 fd-dup and >= comparison). */
function hasWriteRedirect(command: string): boolean {
  return REDIRECT_WRITE_RE.test(command);
}

/** Extract the file-path targets of write-redirect operators, dropping device/special paths (GOTCHA #11). */
function extractRedirectTargets(command: string): string[] {
  const global = /(?:\d?&?>{1,2}\|?)\s*(?!&|=)([^\s;|&<>]+)/g; // global-flag copy for the exec loop
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = global.exec(command)) !== null) {
    const p = stripQuotes(m[1]);
    if (p && !IGNORE_PATHS.has(p)) out.push(p);
  }
  return out;
}

/** True iff a token is LIKELY a file path (rejects URLs, flags, numbers, operators, fd-dup, bare ., sed-programs). */
function looksLikeFilePath(token: string): boolean {
  if (!token) return false;
  const t = stripQuotes(token);
  if (!t) return false;
  if (t === "." || t === "..") return false; // bare dot/dotdot
  if (/^-/.test(t)) return false; // flags: -x, --foo
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return false; // URLs: scheme://
  if (/^[^/\s@]+@[^:\s]+:/.test(t)) return false; // ssh/scp: user@host:path
  if (/^\d+$/.test(t)) return false; // pure number
  if (/^[<>|&;]+$/.test(t)) return false; // operators / redirect tokens
  if (/^&\d/.test(t)) return false; // fd-dup targets: &1 &2
  if (/^[a-z]\/.*\/[a-z]*$/.test(t)) return false; // sed/awk program shape: s/a/b/, y/a/b/, g/.../  (GOTCHA #10)
  // positive signals
  return (
    t.includes("/") || // any path separator
    /\.[a-zA-Z0-9]{1,8}$/.test(t) || // a short file extension: foo.ts, report.md
    /^\.\.?(\/|$)/.test(t) || // ./x, ../x, ..
    /^\.[A-Za-z_]/.test(t) // dotfile: .env, .gitignore
  );
}

/**
 * Split a command into top-level segments on | ; && || and newlines, quote-aware (so pipes inside quotes / `||` /
 * `$(...)` are not naively split — though `$(...)` is handled only by quote-awareness, not full subshell tracking; an
 * unbalanced edge is a rare, safe false-positive per "when in doubt, include"). Module-private.
 */
function splitTopLevel(command: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += c;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += c;
      continue;
    }
    if (!inSingle && !inDouble) {
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        segs.push(cur);
        cur = "";
        i++;
        continue;
      }
      if (c === "|" || c === ";" || c === "\n") {
        segs.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

/** The command name of a segment: the first non-env-assignment token's basename (/usr/bin/ls → ls). Module-private. */
function firstCommandName(seg: string): string {
  const tokens = seg.trim().split(/\s+/);
  for (let raw of tokens) {
    if (!raw) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue; // skip leading VAR=val env assignments
    raw = stripQuotes(raw);
    if (!raw) continue;
    const base = raw.split("/").pop();
    return base ?? raw;
  }
  return "";
}

/** Quote-aware whitespace tokenizer (strips surrounding quotes). Module-private. */
function splitShellTokens(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(c) && !inSingle && !inDouble) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ── module-private defensive helpers (mirror tokens.ts — never throw) ───────────

/** De-duplicate + sort a string set (lexicographic) → string[] (GOTCHA #12). */
function dedupeSorted(set: Set<string>): string[] {
  return [...set].sort();
}

/** Strip a single layer of surrounding single/double quotes from a token (module-private). */
function stripQuotes(token: string): string {
  return typeof token === "string" ? token.replace(/^['"]|['"]$/g, "") : "";
}

/** Read a string field from a record; "" if absent/mistyped/non-string (module-private). */
function readStringField(obj: unknown, key: string): string {
  const v = readOwn(obj, key);
  return typeof v === "string" ? v : "";
}

/** True for plain records (and Object.create(null)); false for null, primitives, and arrays (mirror tokens.ts). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read an own property without throwing (a Proxy get-trap may throw); undefined if absent/unreadable (mirror tokens.ts). */
function readOwn(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) return undefined;
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}
