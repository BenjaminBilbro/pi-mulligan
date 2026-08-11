/**
 * Regression guard for src/settingsLoader.ts — loadMulliganSettings
 * contract: project-local REPLACES global (top-level replace, NOT deep-merge),
 * strict isTrusted===true gate, never-throws / warn-and-skip discipline.
 *
 * Module under test is STATELESS — no vi.resetModules().
 * Global path redirected via vi.mock("node:os") with per-test tmp dirs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadMulliganSettings } from "../src/settingsLoader.js";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// vi.mock("node:os") — redirect homedir() at a mutable mockHome
// ─────────────────────────────────────────────────────────────────────────────

let mockHome: string = "/nonexistent-initial";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHome };
});

/** Set the fake home dir for the next loadMulliganSettings call. */
function setHome(dir: string): void {
  mockHome = dir;
}

// Capture for type-reference only (unused at runtime)
const _originalHomedir = homedir;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: two tmp dirs per test (home + cwd), mirrored from test/log.test.ts
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

// ─────────────────────────────────────────────────────────────────────────────
// Helper: write a settings JSON file (creates parent dirs as needed)
// ─────────────────────────────────────────────────────────────────────────────

function writeSettings(dir: string, relPath: string, data: unknown): void {
  const filePath = join(dir, relPath);
  const parentDir = filePath.substring(0, filePath.lastIndexOf("/"));
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(
    filePath,
    typeof data === "string" ? data : JSON.stringify(data),
    "utf8",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test cases (a)–(h) + non-object pin + consumer contracts + never-throws
// ─────────────────────────────────────────────────────────────────────────────

describe("loadMulliganSettings", () => {
  // ─── (a) global-only ──────────────────────────────────────────────────────
  it("(a) global-only: returns the global mulligan value verbatim", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { enabled: false } });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ enabled: false });
  });

  // ─── (b) local-only trusted ────────────────────────────────────────────────
  it("(b) local-only trusted: returns the local mulligan when home has no file", () => {
    writeSettings(cwd, ".pi/settings.json", { mulligan: { maxDepth: 9 } });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ maxDepth: 9 });
  });

  // ─── (c) BOTH → LOCAL WINS (precedence regression guard) ───────────────────
  it("(c) LOCAL REPLACES GLOBAL — top-level replace, NOT deep-merge", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { a: 1 } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { b: 2 } });
    const result = loadMulliganSettings({ cwd, isTrusted: true });
    expect(result).toEqual({ b: 2 });
    // Explicitly NOT deep-merged
    expect(result).not.toEqual({ a: 1, b: 2 });
    expect(result).not.toEqual({ a: 1 });
  });

  it("(c) local mulligan:null wins over global (hasOwnProperty → null is present)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { x: 1 } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: null });
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeNull();
  });

  // ─── (d) isTrusted:false AND isTrusted:undefined ──────────────────────────
  it("(d) isTrusted:false → local file is NEVER read, global returned", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { global: true } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { local: true } });
    expect(loadMulliganSettings({ cwd, isTrusted: false })).toEqual({ global: true });
  });

  it("(d) isTrusted:undefined → local file is NEVER read, global returned", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { global: true } });
    writeSettings(cwd, ".pi/settings.json", { mulligan: { local: true } });
    expect(loadMulliganSettings({ cwd })).toEqual({ global: true });
  });

  // ─── (e) neither file present ────────────────────────────────────────────
  it("(e) neither file present → returns undefined", () => {
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
  });

  // ─── (f) malformed JSON ──────────────────────────────────────────────────
  it("(f1) malformed JSON in global → console.warn once, falls through to local", () => {
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

  it("(f2) malformed JSON in local (trusted) → console.warn once, returns global", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { global: true } });
    writeSettings(cwd, ".pi/settings.json", "{ bad");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const localPath = join(cwd, ".pi", "settings.json");
      expect(loadMulliganSettings({ cwd, isTrusted: true })).toEqual({ global: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("[mulligan] settings:");
      expect(warn.mock.calls[0][0]).toContain(localPath);
      expect(warn.mock.calls[0][0]).toContain("unreadable:");
    } finally {
      warn.mockRestore();
    }
  });

  it("(f3) missing file → NO console.warn (ENOENT is silent)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // ─── (g) no mulligan key / non-object top-level ──────────────────────────
  it("(g) non-object top-level (array) → no mulligan key → undefined", () => {
    writeSettings(home, ".pi/agent/settings.json", [1, 2, 3]);
    writeSettings(cwd, ".pi/settings.json", "42");
    expect(loadMulliganSettings({ cwd, isTrusted: true })).toBeUndefined();
  });

  it("(g) unrelated keys NOT leaked — only the mulligan value is returned", () => {
    writeSettings(home, ".pi/agent/settings.json", {
      packages: [{ name: "mulligan" }],
      defaultModel: "gpt-4",
      mulligan: { enabled: true },
    });
    expect(loadMulliganSettings()).toEqual({ enabled: true });
  });

  it("(g) file present with no mulligan key → undefined", () => {
    writeSettings(home, ".pi/agent/settings.json", { packages: ["x"] });
    expect(loadMulliganSettings()).toBeUndefined();
  });

  // ─── (h) never throws ────────────────────────────────────────────────────
  it("(h) never throws on adversarial inputs", () => {
    expect(() => loadMulliganSettings({ cwd: "/definitely/does/not/exist", isTrusted: true })).not.toThrow();
    expect(() => loadMulliganSettings()).not.toThrow();
    expect(() => loadMulliganSettings({ isTrusted: true })).not.toThrow();
    expect(() => loadMulliganSettings({ cwd: "/tmp" })).not.toThrow();
  });

  // ─── Pinned non-object .mulligan returned AS-IS ──────────────────────────
  it("non-object .mulligan: 42 returned AS-IS (config coerces later)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: 42 });
    expect(loadMulliganSettings()).toBe(42);
  });

  it("non-object .mulligan: 'off' returned AS-IS (config coerces later)", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: "off" });
    expect(loadMulliganSettings()).toBe("off");
  });

  // ─── Consumer contract ────────────────────────────────────────────────────
  it("consumer contract: undefined → validateConfig(undefined) equals DEFAULT_CONFIG", () => {
    const result = loadMulliganSettings();
    expect(result).toBeUndefined();
    expect(validateConfig(result)).toEqual(DEFAULT_CONFIG);
  });

  it("consumer contract: mulligan:null → validateConfig(null) equals DEFAULT_CONFIG", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: null });
    const result = loadMulliganSettings();
    expect(result).toBeNull();
    expect(validateConfig(result)).toEqual(DEFAULT_CONFIG);
  });

  // ─── opts omitted ────────────────────────────────────────────────────────
  it("opts omitted: reads global-only, no throw", () => {
    writeSettings(home, ".pi/agent/settings.json", { mulligan: { rewind: { maxDepth: 3 } } });
    expect(loadMulliganSettings()).toEqual({ rewind: { maxDepth: 3 } });
  });
});
