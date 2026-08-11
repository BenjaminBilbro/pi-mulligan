import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadMulliganSettings } from "../src/settingsLoader.js";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock node:os.homedir so it points at a tmp dir (avoids reading the real home).
// vitest hoists vi.mock; the module-under-test picks up the redirected homedir.
// We use importOriginal to keep tmpdir (and other exports) intact.
// ─────────────────────────────────────────────────────────────────────────────
const originalHomedir = homedir;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome,
  };
});

let mockHome: string = "/nonexistent-initial";

/** Point the mocked homedir at a new path. */
function setHome(dir: string): void {
  mockHome = dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — mirror test/log.test.ts (mkdtempSync / rmSync pattern)
// ─────────────────────────────────────────────────────────────────────────────
let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mulligan-sl-home-"));
  cwd = mkdtempSync(join(tmpdir(), "mulligan-sl-cwd-"));
  setHome(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * Write a JSON file inside a tmp dir, creating parent directories as needed.
 * relPath is relative to dir, e.g. ".pi/agent/settings.json".
 */
function writeSettings(dir: string, relPath: string, data: unknown): void {
  const filePath = join(dir, relPath);
  const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (parentDir) {
    mkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(filePath, typeof data === "string" ? data : JSON.stringify(data), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test cases
// ─────────────────────────────────────────────────────────────────────────────

describe("loadMulliganSettings", () => {
  it("returns undefined when no settings files exist anywhere", () => {
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
  });

  it("reads global-only mulligan value", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { enabled: false } });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ enabled: false });
  });

  it("reads local-only mulligan value when trusted", () => {
    writeSettings(cwd, ".pi/settings.json", { mulligan: { maxDepth: 9 } });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ maxDepth: 9 });
  });

  it("LOCAL REPLACES GLOBAL — top-level replace, NOT deep-merge", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { a: 1 } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { b: 2 } });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ b: 2 });
  });

  it("local mulligan:null wins over global (null is a present key)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { x: 1 } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: null });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeNull();
  });

  it("isTrusted:false — local file is never read, global returned", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { enabled: true } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { enabled: false } });
    expect(loadMulliganSettings({ cwd, isTrusted: false })).toEqual({ enabled: true });
  });

  it("isTrusted:undefined — local file is never read, global returned", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { enabled: true } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { enabled: false } });
    expect(loadMulliganSettings({ cwd })).toEqual({ enabled: true });
  });

  it("opts omitted entirely — reads global-only, no throw", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { rewind: { maxDepth: 3 } } });
    expect(loadMulliganSettings()).toEqual({ rewind: { maxDepth: 3 } });
  });

  it("missing global file → undefined, no throw, no warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("malformed JSON in global → console.warn fires once, returns local-or-undefined", () => {
    writeSettings(home, ".pi/agent/settings.json", "{ not json");
    writeSettings(cwd, ".pi/settings.json", { mulligan: { local: true } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const globalPath = join(home, ".pi", "agent", "settings.json");
      expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ local: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("[mulligan] settings:");
      expect(warn.mock.calls[0][0]).toContain(globalPath);
      expect(warn.mock.calls[0][0]).toContain("unreadable:");
    } finally {
      warn.mockRestore();
    }
  });

  it("malformed JSON in local (trusted, global valid) → returns global, warn fires once for local path", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { global: true } });
    writeSettings(cwd, ".pi/settings.json", "{ bad json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const localPath = join(cwd, ".pi", "settings.json");
      expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ global: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("[mulligan] settings:");
      expect(warn.mock.calls[0][0]).toContain(localPath);
    } finally {
      warn.mockRestore();
    }
  });

  it("non-object top-level (array or primitive) → no mulligan key → undefined", () => {
    writeSettings(home, ".pi/agent/settings.json", [1, 2, 3]);
    writeSettings(cwd, ".pi/settings.json", "42");
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
  });

  it("non-object .mulligan returned as-is (not validated, not coerced)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: 42 });
    expect(loadMulliganSettings()).toBe(42);

    // Fresh home dir for second assertion
    rmSync(join(home, ".pi", "agent", "settings.json"), { force: true });
    writeSettings(home, ".pi/agent/settings.json", { mulligan: "off" });
    expect(loadMulliganSettings()).toBe("off");
  });

  it("unrelated top-level keys are NOT leaked — only the mulligan value is returned", () => {
    writeSettings(home, ".pi/agent/settings.json", {
      packages: [{ name: "mulligan" }],
      defaultModel: "gpt-4",
      mulligan: { enabled: true },
    });
    expect(loadMulliganSettings()).toEqual({ enabled: true });
  });

  it("undefined result → validateConfig(undefined) deepEquals DEFAULT_CONFIG (consumer contract)", () => {
    // No files exist, so loadMulliganSettings returns undefined
    const result = loadMulliganSettings();
    expect(result).toBeUndefined();
    expect(validateConfig(result)).toEqual(DEFAULT_CONFIG);
  });

  it("null mulligan → validateConfig(null) === DEFAULT_CONFIG (null is non-record → defaults)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: null });
    const result = loadMulliganSettings();
    expect(result).toBeNull();
    expect(validateConfig(result)).toEqual(DEFAULT_CONFIG);
  });

  it("NEVER throws on adversarial inputs", () => {
    // Bad cwd dir — local read fails silently
    expect(() => loadMulliganSettings({ cwd: "/definitely/does/not/exist", isTrusted: true })).not.toThrow();
    // No opts at all
    expect(() => loadMulliganSettings()).not.toThrow();
    // opts with isTrusted:true but no cwd
    expect(() => loadMulliganSettings({ isTrusted: true })).not.toThrow();
    // opts with cwd but no isTrusted
    expect(() => loadMulliganSettings({ cwd: "/tmp" })).not.toThrow();
  });
});
