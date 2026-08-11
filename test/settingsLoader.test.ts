/**
 * Unit tests for src/settingsLoader.ts — tmp-dir fixtures + vi.mock('node:os').
 *
 * Fixture pattern mirrors test/log.test.ts (mkdtempSync/rmSync/writeFileSync).
 * console.warn spy pattern mirrors test/config.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadMulliganSettings,
  type LoadMulliganSettingsOptions,
} from "../src/settingsLoader.js";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// vi.mock('node:os') — redirect homedir() to a mutable tmp dir per test
// ─────────────────────────────────────────────────────────────────────────────

let mockHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mulligan-sl-home-"));
  cwd = mkdtempSync(join(tmpdir(), "mulligan-sl-cwd-"));
  mockHome = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** Write a JSON file at <dir>/<relPath>, creating parent dirs as needed. */
function writeSettings(dir: string, relPath: string, objOrJson: unknown): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const content = typeof objOrJson === "string" ? objOrJson : JSON.stringify(objOrJson);
  writeFileSync(full, content, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Test cases
// ─────────────────────────────────────────────────────────────────────────────

describe("loadMulliganSettings", () => {
  // 1. No files anywhere → undefined
  it("returns undefined when no settings files exist", () => {
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
  });

  // 2. Global-only
  it("reads global mulligan when only global file exists", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { enabled: false } });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ enabled: false });
  });

  // 3. Local-only (trusted)
  it("reads local mulligan when only local file exists and trusted", () => {
    writeSettings(cwd, ".pi/settings.json", { mulligan: { maxDepth: 9 } });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ maxDepth: 9 });
  });

  // 4. BOTH → LOCAL REPLACES GLOBAL (top-level replace, NOT deep-merge)
  it("local mulligan replaces global mulligan (top-level replace, not deep-merge)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { a: 1 } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { b: 2 } });
    const result = loadMulliganSettings({ cwd, isTrusted: true });
    expect(result).toEqual({ b: 2 }); // NOT { a: 1, b: 2 }
  });

  // 5. Untrusted — isTrusted:false AND undefined → local never read
  it("skips local file when isTrusted is false", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { global: true } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { local: true } });
    expect(loadMulliganSettings({ cwd, isTrusted: false })).toEqual({ global: true });
  });

  it("skips local file when isTrusted is undefined", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { global: true } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { local: true } });
    expect(loadMulliganSettings({ cwd })).toEqual({ global: true });
  });

  // 6. Local mulligan:null wins over global
  it("local mulligan:null replaces global and validateConfig(null) yields DEFAULT_CONFIG", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { x: 1 } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: null });
    const result = loadMulliganSettings({ cwd, isTrusted: true });
    expect(result).toBeNull();
    // Consumer contract: validateConfig(null) → DEFAULT_CONFIG (non-record raw)
    expect(validateConfig(null)).toEqual(DEFAULT_CONFIG);
  });

  // 7. Missing file → no throw, no warn
  it("returns undefined when HOME has no .pi dir, no throw, no warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // home dir exists but has no .pi subdirectory
      expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
      expect(warn).not.toHaveBeenCalled(); // ENOENT is silently skipped (no warn for missing)
    } finally {
      warn.mockRestore();
    }
  });

  // 8. Malformed JSON in global → warn + skip
  it("emits console.warn for malformed global JSON and falls through", () => {
    writeSettings(home, ".pi/agent/settings.json", "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = loadMulliganSettings({ cwd, isTrusted: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("[mulligan] settings:");
      expect(warn.mock.calls[0][0]).toContain("unreadable:");
      expect(result).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  // 9. Malformed JSON in local (trusted, global valid) → returns global, warn for local
  it("emits console.warn for malformed local JSON and returns global", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { enabled: true } });
    writeSettings(cwd, ".pi/settings.json", "{ malformed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = loadMulliganSettings({ cwd, isTrusted: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("[mulligan] settings:");
      expect(warn.mock.calls[0][0]).toContain(join(cwd, ".pi", "settings.json"));
      expect(result).toEqual({ enabled: true });
    } finally {
      warn.mockRestore();
    }
  });

  // 10. Non-object top-level → no mulligan key → undefined
  it("returns undefined for non-object top-level JSON (array)", () => {
    writeSettings(home, ".pi/agent/settings.json", [1, 2, 3]);
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
  });

  it("returns undefined for non-object top-level JSON (primitive)", () => {
    writeSettings(home, ".pi/agent/settings.json", 42);
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
  });

  // 11. Non-object .mulligan returned AS-IS
  it("returns non-object .mulligan as-is (number)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: 42 });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBe(42);
  });

  it("returns non-object .mulligan as-is (string)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: "off" });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBe("off");
  });

  // 12. Unrelated keys ignored
  it("returns only the mulligan value; unrelated keys are not leaked", () => {
    writeSettings(home, ".pi/agent/settings.json", {
      packages: [{ name: "foo" }],
      defaultModel: "gpt-4",
      mulligan: { enabled: true },
    });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ enabled: true });
  });

  // 13. Opts omitted entirely → global-only
  it("reads global-only when opts is omitted (isTrusted undefined → no local read)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { rewind: { maxDepth: 3 } } });
    expect(loadMulliganSettings()).toEqual({ rewind: { maxDepth: 3 } });
  });

  // 14. Consumer contract: undefined → validateConfig(undefined) === DEFAULT_CONFIG
  it("when returning undefined, validateConfig(undefined) deep-equals DEFAULT_CONFIG", () => {
    // No files → undefined
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
    expect(validateConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  // 15. NEVER throws on adversarial input
  it("never throws on a bad cwd path", () => {
    expect(() =>
      loadMulliganSettings({ cwd: "/definitely/does/not/exist", isTrusted: true }),
    ).not.toThrow();
  });

  it("never throws with various adversarial calls", () => {
    expect(() => loadMulliganSettings()).not.toThrow();
    expect(() => loadMulliganSettings({})).not.toThrow();
    expect(() => loadMulliganSettings({ isTrusted: true })).not.toThrow();
    expect(() => loadMulliganSettings({ cwd: "", isTrusted: true })).not.toThrow();
  });

  // Bonus: both malformed → warn twice, return undefined
  it("warns once per malformed file when both are malformed", () => {
    writeSettings(home, ".pi/agent/settings.json", "{ bad global");
    writeSettings(cwd, ".pi/settings.json", "{ bad local");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = loadMulliganSettings({ cwd, isTrusted: true });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(result).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  // Bonus: local file has no mulligan key → global is used (local does not "win" with undefined)
  it("falls back to global when local file has no mulligan key", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { enabled: false } });
    writeSettings(cwd, ".pi/settings.json", { packages: [] });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ enabled: false });
  });
});
