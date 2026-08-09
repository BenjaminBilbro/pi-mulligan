import { describe, it, expect, expectTypeOf, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  log,
  logInfo,
  logDebug,
  logWarn,
  logError,
  setLogFile,
  type Level,
  type LogLine,
} from "../src/log.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mulligan-log-"));
  file = join(dir, "log.jsonl");
  setLogFile(null); // reset module-level state
});

afterEach(() => {
  setLogFile(null);
  rmSync(dir, { recursive: true, force: true });
});

/** Read back the log file, split on newlines, drop empties, JSON.parse each line. */
function readLines(): LogLine[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LogLine);
}

describe("LogLine shape (spec/04 §9)", () => {
  it("writes one valid JSON line matching LogLine, with structured data", () => {
    setLogFile(file);
    logInfo("test.event", "session-1", { foo: 1, nested: [1, 2] });
    const lines = readLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.level).toBe("info");
    expect(line.event).toBe("test.event");
    expect(line.sessionId).toBe("session-1");
    expect(line.data).toEqual({ foo: 1, nested: [1, 2] });
    expect(typeof line.ts).toBe("string");
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false); // valid ISO
    expect(line.ts.endsWith("Z")).toBe(true); // UTC
  });

  it("omits the `data` key entirely when data is not provided (data? is optional)", () => {
    setLogFile(file);
    logWarn("no.data", "s");
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain('"event":"no.data"');
    expect(raw).not.toContain('"data"'); // undefined is dropped by JSON.stringify
    const line = JSON.parse(raw.trim()) as LogLine;
    expect(line).not.toHaveProperty("data");
  });

  it("preserves an explicit null data as a real JSON null (null is a provided value)", () => {
    setLogFile(file);
    logInfo("null.data", "s", null);
    const line = JSON.parse(readFileSync(file, "utf8").trim()) as LogLine;
    expect(line).toHaveProperty("data");
    expect(line.data).toBeNull();
  });

  it("writes each of the four levels verbatim", () => {
    setLogFile(file);
    logDebug("d", "s");
    logInfo("i", "s");
    logWarn("w", "s");
    logError("e", "s");
    expect(readLines().map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("append-only behavior", () => {
  it("appends one line per call; lines accumulate (never truncate)", () => {
    setLogFile(file);
    logInfo("a", "s");
    logInfo("b", "s");
    logWarn("c", "s");
    const lines = readLines();
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.event)).toEqual(["a", "b", "c"]);
  });

  it("does not overwrite a pre-existing file's contents (true append)", () => {
    writeFileSync(file, JSON.stringify({ preexisting: true }) + "\n", "utf8");
    setLogFile(file);
    logInfo("after", "s");
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ preexisting: true });
    expect(lines[1].event).toBe("after");
  });
});

describe("no-op when logFile is null (default = off)", () => {
  it("does nothing and throws nothing when logging is disabled (file never created)", () => {
    setLogFile(null);
    expect(() => logInfo("x", "s", { a: 1 })).not.toThrow();
    expect(() => readFileSync(file, "utf8")).toThrow(); // never created → ENOENT
  });

  it("setLogFile(null) turns logging off mid-session", () => {
    setLogFile(file);
    logInfo("one", "s");
    setLogFile(null);
    logInfo("two", "s"); // dropped (no-op)
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("one");
  });

  it("switching destinations writes to the new file only", () => {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    setLogFile(a);
    logInfo("to-a", "s");
    setLogFile(b);
    logInfo("to-b", "s");
    expect((JSON.parse(readFileSync(a, "utf8").trim()) as LogLine).event).toBe("to-a");
    expect((JSON.parse(readFileSync(b, "utf8").trim()) as LogLine).event).toBe("to-b");
  });
});

describe("fail-open: a bad path / bad data NEVER throws (spec/03 #4, spec/09 §4)", () => {
  it("swallows ENOENT (missing parent dir) and writes to stderr instead", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      setLogFile(join(dir, "no-such-dir", "log.jsonl")); // parent dir absent → ENOENT
      expect(() => logInfo("boom", "s", { x: 1 })).not.toThrow();
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls[0]?.[0] ?? "")).toContain("boom");
    } finally {
      spy.mockRestore();
    }
  });

  it("swallows EISDIR (path is a directory)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      setLogFile(dir); // the temp dir itself → EISDIR
      expect(() => logError("isdir", "s")).not.toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("swallows a circular `data` payload (JSON.stringify throws TypeError) WITHOUT appending a partial line", () => {
    setLogFile(file);
    logInfo("seed", "s"); // create the file + one good line first
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => logInfo("circular", "s", circular)).not.toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // only the seed survived — no corrupt/partial line (readLines would throw on a bad line):
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("seed");
  });

  it("swallows a BigInt `data` payload (JSON.stringify throws TypeError)", () => {
    setLogFile(file);
    logInfo("seed", "s");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => logInfo("bigint", "s", { n: BigInt(123) })).not.toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(readLines()).toHaveLength(1); // only the seed
  });
});

describe("convenience helpers curry the level", () => {
  it("logInfo/logDebug/logWarn/logError each emit the right level", () => {
    setLogFile(file);
    const cases: Array<{ fn: (e: string, s: string) => void; level: Level; event: string }> = [
      { fn: logDebug, level: "debug", event: "dbg" },
      { fn: logInfo, level: "info", event: "inf" },
      { fn: logWarn, level: "warn", event: "wrn" },
      { fn: logError, level: "error", event: "err" },
    ];
    for (const c of cases) c.fn(c.event, "sid");
    expect(readLines().map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("bare log(level, event, sessionId, data?) routes through the same path; Level is the 4-value union", () => {
    setLogFile(file);
    log("error", "manual", "sid", { k: "v" });
    const line = JSON.parse(readFileSync(file, "utf8").trim()) as LogLine;
    expect(line).toMatchObject({ level: "error", event: "manual", sessionId: "sid" });
    expect(line.data).toEqual({ k: "v" });
    expectTypeOf<Level>().toEqualTypeOf<"debug" | "info" | "warn" | "error">();
  });
});
