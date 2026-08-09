import { describe, it, expectTypeOf, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  getConfig,
  setConfig,
  validateConfig,
  type MulliganConfig,
  type Granularity,
  type EstimateConfidence,
} from "../src/config.js";

describe("DEFAULT_CONFIG", () => {
  it("matches the spec/09 §2 defaults exactly", () => {
    expect(DEFAULT_CONFIG).toEqual({
      enabled: true,
      rewind: {
        enabled: true,
        protectedRoles: ["first:user", "latest:user"],
        maxDepth: 5,
        requireMutationWarning: true,
      },
      shrink: { enabled: true },
      nudges: {
        bloatReminder: true,
        perTurnDrift: true,
        bloatThresholdBytes: 8192,
        driftThresholdTokens: 3000,
      },
      audit: { estimateConfidence: "medium" },
      log: { file: null },
    });
  });

  it("nudges has no extra keys (no bloatThresholdBytesByTool)", () => {
    expect(Object.keys(DEFAULT_CONFIG.nudges).sort()).toEqual([
      "bloatReminder",
      "bloatThresholdBytes",
      "driftThresholdTokens",
      "perTurnDrift",
    ]);
  });

  it("is assignable to MulliganConfig (type-level)", () => {
    expectTypeOf(DEFAULT_CONFIG).toMatchTypeOf<MulliganConfig>();
  });

  it("exports the 3-value Granularity and 3-value EstimateConfidence (type-level)", () => {
    expectTypeOf<Granularity>().toEqualTypeOf<"last_tool_call_group" | "last_turn" | "checkpoint">();
    expectTypeOf<EstimateConfidence>().toEqualTypeOf<"low" | "medium" | "high">();
  });
});

describe("validateConfig", () => {
  it("returns deep-equal DEFAULT_CONFIG for absent/empty/non-record input", () => {
    expect(validateConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(validateConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(validateConfig({})).toEqual(DEFAULT_CONFIG);
    expect(validateConfig(42)).toEqual(DEFAULT_CONFIG);
    expect(validateConfig("nope")).toEqual(DEFAULT_CONFIG);
    expect(validateConfig([1, 2, 3])).toEqual(DEFAULT_CONFIG);
    expect(validateConfig(Object.create(null))).toEqual(DEFAULT_CONFIG);
  });

  it("deep-merges partial valid overrides over defaults", () => {
    const cfg = validateConfig({ nudges: { bloatThresholdBytes: 100 } });
    expect(cfg.nudges.bloatThresholdBytes).toBe(100);
    expect(cfg.nudges.driftThresholdTokens).toBe(3000);
    expect(cfg.enabled).toBe(true);
  });

  it("applies a full valid override", () => {
    const cfg = validateConfig({
      enabled: false,
      rewind: { enabled: false, protectedRoles: ["first:user"], maxDepth: 2, requireMutationWarning: false },
      shrink: { enabled: false },
      nudges: { bloatReminder: false, perTurnDrift: false, bloatThresholdBytes: 1, driftThresholdTokens: 1 },
      audit: { estimateConfidence: "low" },
      log: { file: "/tmp/mulligan.jsonl" },
    });
    expect(cfg).toEqual({
      enabled: false,
      rewind: { enabled: false, protectedRoles: ["first:user"], maxDepth: 2, requireMutationWarning: false },
      shrink: { enabled: false },
      nudges: { bloatReminder: false, perTurnDrift: false, bloatThresholdBytes: 1, driftThresholdTokens: 1 },
      audit: { estimateConfidence: "low" },
      log: { file: "/tmp/mulligan.jsonl" },
    });
  });

  it("coerces booleans with !! — non-empty strings are truthy", () => {
    expect(validateConfig({ enabled: 1 }).enabled).toBe(true);
    expect(validateConfig({ enabled: 0 }).enabled).toBe(false);
    expect(validateConfig({ enabled: "" }).enabled).toBe(false);
    // "false" is a non-empty string → truthy → true (intentional per spec)
    expect(validateConfig({ enabled: "false" }).enabled).toBe(true);
    // null is present → !!null → false
    expect(validateConfig({ enabled: null }).enabled).toBe(false);
  });

  it("validates numbers: finite, thresholds >0; rejects strings/NaN/Infinity", () => {
    expect(validateConfig({ nudges: { bloatThresholdBytes: -1 } }).nudges.bloatThresholdBytes).toBe(8192);
    expect(validateConfig({ nudges: { bloatThresholdBytes: 0 } }).nudges.bloatThresholdBytes).toBe(8192);
    expect(validateConfig({ nudges: { bloatThresholdBytes: NaN } }).nudges.bloatThresholdBytes).toBe(8192);
    expect(validateConfig({ nudges: { bloatThresholdBytes: Infinity } }).nudges.bloatThresholdBytes).toBe(8192);
    expect(validateConfig({ nudges: { bloatThresholdBytes: "8192" } }).nudges.bloatThresholdBytes).toBe(8192);
    expect(validateConfig({ rewind: { maxDepth: 0 } }).rewind.maxDepth).toBe(0);
    expect(validateConfig({ rewind: { maxDepth: -1 } }).rewind.maxDepth).toBe(5);
  });

  it("filters protectedRoles to known selectors; drops unknown entries; non-array → default", () => {
    expect(validateConfig({ rewind: { protectedRoles: ["first:user", "bogus"] } }).rewind.protectedRoles).toEqual(["first:user"]);
    expect(validateConfig({ rewind: { protectedRoles: ["bogus", "nope"] } }).rewind.protectedRoles).toEqual([]);
    expect(validateConfig({ rewind: { protectedRoles: [] } }).rewind.protectedRoles).toEqual([]);
    // non-array → default
    expect(validateConfig({ rewind: { protectedRoles: "first:user" } }).rewind.protectedRoles).toEqual(["first:user", "latest:user"]);
  });

  it("protectedRoles: per-entry warn for each dropped entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = validateConfig({ rewind: { protectedRoles: ["first:user", "bogus", "nope"] } });
      expect(cfg.rewind.protectedRoles).toEqual(["first:user"]);
      expect(warn).toHaveBeenCalledTimes(2); // one per unknown entry
      expect(warn.mock.calls[0][0]).toContain("rewind.protectedRoles entry");
      expect(warn.mock.calls[1][0]).toContain("rewind.protectedRoles entry");
    } finally {
      warn.mockRestore();
    }
  });

  it("validates estimateConfidence enum; else default 'medium'", () => {
    expect(validateConfig({ audit: { estimateConfidence: "low" } }).audit.estimateConfidence).toBe("low");
    expect(validateConfig({ audit: { estimateConfidence: "high" } }).audit.estimateConfidence).toBe("high");
    expect(validateConfig({ audit: { estimateConfidence: "bogus" } }).audit.estimateConfidence).toBe("medium");
    expect(validateConfig({ audit: { estimateConfidence: 123 } }).audit.estimateConfidence).toBe("medium");
  });

  it("validates log.file: null is valid 'off'; any string accepted; non-string → null", () => {
    expect(validateConfig({ log: { file: "/x.jsonl" } }).log.file).toBe("/x.jsonl");
    expect(validateConfig({ log: { file: null } }).log.file).toBe(null);
    expect(validateConfig({ log: { file: "" } }).log.file).toBe(""); // empty string is valid
    expect(validateConfig({ log: { file: 123 } }).log.file).toBe(null);
  });

  it("ignores unknown keys (forward-compat), incl. shrink.autoOnBloat", () => {
    const cfg = validateConfig({ foo: "bar", rewind: { baz: 1, enabled: false }, shrink: { autoOnBloat: true } });
    expect(cfg.rewind.enabled).toBe(false);
    expect(cfg.shrink).toEqual({ enabled: true }); // autoOnBloat ignored
    expect(cfg).toEqual(validateConfig({ rewind: { enabled: false } }));
  });

  it("NEVER throws on adversarial input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const throwingProxy = new Proxy({}, { get() { throw new Error("boom"); } });
    expect(() => validateConfig(circular)).not.toThrow();
    expect(() => validateConfig(throwingProxy)).not.toThrow();
    expect(() => validateConfig({ rewind: { maxDepth: "not-a-number" } })).not.toThrow();
    expect(validateConfig({ rewind: { maxDepth: "not-a-number" } }).rewind.maxDepth).toBe(5);
  });

  it("does not mutate DEFAULT_CONFIG", () => {
    const snapshot = structuredClone(DEFAULT_CONFIG);
    validateConfig({ nudges: { bloatThresholdBytes: 1 }, rewind: { maxDepth: 99 } });
    expect(DEFAULT_CONFIG).toEqual(snapshot);
  });

  it("does NOT warn for ABSENT fields (warns only on present-but-invalid)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = validateConfig({ nudges: { bloatThresholdBytes: 100 } });
      expect(cfg.nudges.bloatThresholdBytes).toBe(100);
      expect(cfg.nudges.driftThresholdTokens).toBe(3000);
      expect(warn).not.toHaveBeenCalled();
      // but present-but-invalid DOES warn exactly once:
      warn.mockClear();
      validateConfig({ nudges: { bloatThresholdBytes: -1 } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("nudges.bloatThresholdBytes");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("getConfig / setConfig cache", () => {
  beforeEach(() => {
    setConfig(undefined);
  });

  it("getConfig returns validated defaults after a reset", () => {
    expect(getConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("setConfig then getConfig round-trips validated overrides", () => {
    setConfig({ nudges: { bloatThresholdBytes: 100 } });
    expect(getConfig().nudges.bloatThresholdBytes).toBe(100);
  });

  it("setConfig validates/coerces through the cache (invalid → default)", () => {
    setConfig({ nudges: { bloatThresholdBytes: -5 } });
    expect(getConfig().nudges.bloatThresholdBytes).toBe(8192);
  });

  it("getConfig hands out independent copies — cache cannot be poisoned", () => {
    setConfig({ enabled: false });
    const a = getConfig();
    a.enabled = true;
    const b = getConfig();
    expect(b.enabled).toBe(false);
  });

  it("getConfig never exposes DEFAULT_CONFIG by reference", () => {
    expect(getConfig()).not.toBe(DEFAULT_CONFIG);
    setConfig(DEFAULT_CONFIG);
    expect(getConfig()).not.toBe(DEFAULT_CONFIG);
  });

  it("setConfig never throws on garbage input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => setConfig(circular)).not.toThrow();
    expect(() => setConfig(123)).not.toThrow();
    expect(getConfig()).toEqual(DEFAULT_CONFIG);
  });
});

describe("getConfig lazy init (cache starts null)", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("first getConfig() on a fresh module validates defaults lazily", async () => {
    const mod = await import("../src/config.js");
    expect(mod.getConfig()).toEqual(DEFAULT_CONFIG);
    const again = mod.getConfig();
    expect(again).toEqual(DEFAULT_CONFIG);
    expect(again).not.toBe(mod.getConfig()); // still defensive copies
  });
});
