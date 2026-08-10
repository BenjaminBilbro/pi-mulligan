/**
 * nudges.test.ts — unit suite for src/nudges.ts PURE helpers (shouldNudge, suppressCheck, injectNudge,
 *   NUDGE_TURN_WINDOW_MS). No Pi, no fake ctx — only pure-function assertions.
 */

import { describe, it, expect } from "vitest";
import {
  shouldNudge,
  suppressCheck,
  injectNudge,
  NUDGE_TURN_WINDOW_MS,
} from "../src/nudges.js";
import type { MessageLike } from "../src/transforms.js";
import { renderDriftNudge } from "../src/notes.js";

// ── NUDGE_TURN_WINDOW_MS ────────────────────────────────────────────────────

describe("NUDGE_TURN_WINDOW_MS", () => {
  it("equals 10 * 60 * 1000 (10 minutes)", () => {
    expect(NUDGE_TURN_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});

// ── shouldNudge ───────────────────────────────────────────────────────────────

describe("shouldNudge — pure boolean: grewOverThreshold || bloatHit", () => {
  it("grewOverThreshold-only → true", () => {
    expect(
      shouldNudge({ grewOverThreshold: true, bloatHit: false }, {}),
    ).toBe(true);
  });

  it("bloatHit-only (=== true) → true", () => {
    expect(
      shouldNudge({ grewOverThreshold: false, bloatHit: true }, {}),
    ).toBe(true);
  });

  it("both true → true", () => {
    expect(
      shouldNudge({ grewOverThreshold: true, bloatHit: true }, {}),
    ).toBe(true);
  });

  it("both false → false", () => {
    expect(
      shouldNudge({ grewOverThreshold: false, bloatHit: false }, {}),
    ).toBe(false);
  });

  it("malformed metric (undefined fields) → false (fail-safe)", () => {
    expect(shouldNudge({}, {})).toBe(false);
    expect(shouldNudge({ grewOverThreshold: undefined, bloatHit: undefined }, {})).toBe(false);
  });

  it("bloatHit is truthy but not === true → false (fail-safe)", () => {
    // bloatHit uses === true so non-boolean truthy values don't fire
    expect(shouldNudge({ grewOverThreshold: false, bloatHit: 1 }, {})).toBe(false);
    expect(shouldNudge({ grewOverThreshold: false, bloatHit: "yes" }, {})).toBe(false);
  });

  it("grewOverThreshold is truthy non-boolean → true (Boolean() cast)", () => {
    expect(shouldNudge({ grewOverThreshold: 1, bloatHit: false }, {})).toBe(true);
  });

  it("null metric → false (fail-safe, never throws)", () => {
    expect(() => shouldNudge(null, {})).not.toThrow();
    expect(shouldNudge(null, {})).toBe(false);
  });

  it("never throws on any input", () => {
    expect(() => shouldNudge(undefined, undefined)).not.toThrow();
    expect(() => shouldNudge("string", {})).not.toThrow();
    expect(() => shouldNudge(42, {})).not.toThrow();
  });
});

// ── suppressCheck ───────────────────────────────────────────────────────────

describe("suppressCheck — pure: marker.ts in (metric.ts − WINDOW, metric.ts]", () => {
  const metricTs = 1000_000; // some fixed timestamp

  it("marker.ts in-window → true", () => {
    const markerTs = metricTs - NUDGE_TURN_WINDOW_MS / 2; // 5 minutes before
    expect(
      suppressCheck(
        { ts: metricTs },
        { rewinds: [{ ts: markerTs }], shrinks: [] },
      ),
    ).toBe(true);
  });

  it("marker.ts == metric.ts (upper bound inclusive) → true", () => {
    expect(
      suppressCheck(
        { ts: metricTs },
        { rewinds: [{ ts: metricTs }], shrinks: [] },
      ),
    ).toBe(true);
  });

  it("marker.ts just below lo (window − 1ms) → false", () => {
    const markerTs = metricTs - NUDGE_TURN_WINDOW_MS - 1;
    expect(
      suppressCheck(
        { ts: metricTs },
        { rewinds: [{ ts: markerTs }], shrinks: [] },
      ),
    ).toBe(false);
  });

  it("marker.ts in future (> metric.ts) → false", () => {
    expect(
      suppressCheck(
        { ts: metricTs },
        { rewinds: [{ ts: metricTs + 1000 }], shrinks: [] },
      ),
    ).toBe(false);
  });

  it("no markers → false", () => {
    expect(
      suppressCheck({ ts: metricTs }, { rewinds: [], shrinks: [] }),
    ).toBe(false);
  });

  it("non-finite marker.ts (NaN) → ignored (no suppress)", () => {
    expect(
      suppressCheck(
        { ts: metricTs },
        { rewinds: [{ ts: NaN }], shrinks: [] },
      ),
    ).toBe(false);
    expect(
      suppressCheck(
        { ts: metricTs },
        { rewinds: [{ ts: Infinity }], shrinks: [] },
      ),
    ).toBe(false);
  });

  it("rewinds AND shrinks both checked", () => {
    // Rewind outside window, shrink inside → true (shrink triggers)
    expect(
      suppressCheck(
        { ts: metricTs },
        {
          rewinds: [{ ts: metricTs - NUDGE_TURN_WINDOW_MS - 1000 }],
          shrinks: [{ ts: metricTs - 1000 }],
        },
      ),
    ).toBe(true);
  });

  it("both rewinds and shrinks outside window → false", () => {
    expect(
      suppressCheck(
        { ts: metricTs },
        {
          rewinds: [{ ts: metricTs - NUDGE_TURN_WINDOW_MS - 1000 }],
          shrinks: [{ ts: metricTs - NUDGE_TURN_WINDOW_MS - 2000 }],
        },
      ),
    ).toBe(false);
  });

  it("never throws on any input", () => {
    expect(() => suppressCheck(null, { rewinds: [], shrinks: [] })).not.toThrow();
    expect(() =>
      suppressCheck(undefined, { rewinds: [{ ts: 1 }], shrinks: [] }),
    ).not.toThrow();
  });
});

// ── injectNudge ──────────────────────────────────────────────────────────────

describe("injectNudge — pure: [...messages, ephemeral mulligan:nudge]", () => {
  const baseMessages: MessageLike[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ];

  const metric = {
    deltaTokens: 4200,
    bloatHit: false,
    bloatHits: [],
    grewOverThreshold: true,
    turnIndex: 3,
    ts: Date.now(),
  };

  it("returns a NEW array with length = input + 1", () => {
    const result = injectNudge(baseMessages, metric);
    expect(result).toHaveLength(baseMessages.length + 1);
    expect(result).not.toBe(baseMessages); // new array
  });

  it("last element has customType 'mulligan:nudge', role 'custom', display false", () => {
    const result = injectNudge(baseMessages, metric);
    const last = result[result.length - 1];
    expect(last.role).toBe("custom");
    expect(last.customType).toBe("mulligan:nudge");
    expect(last.display).toBe(false);
  });

  it("details.ephemeral is true and details.turnIndex matches metric.turnIndex", () => {
    const result = injectNudge(baseMessages, metric);
    const last = result[result.length - 1];
    expect(last.details).toEqual({
      ephemeral: true,
      turnIndex: metric.turnIndex,
    });
  });

  it("content === renderDriftNudge(metric)", () => {
    const result = injectNudge(baseMessages, metric);
    const last = result[result.length - 1];
    expect(last.content).toBe(renderDriftNudge(metric));
  });

  it("input array is UNMUTATED", () => {
    const original = [...baseMessages];
    injectNudge(baseMessages, metric);
    expect(baseMessages).toEqual(original);
  });

  it("no side effects (no Pi calls, no global state mutation)", () => {
    // Pure function — just verify it returns consistently
    const r1 = injectNudge(baseMessages, metric);
    const r2 = injectNudge(baseMessages, metric);
    expect(r1).toEqual(r2);
  });

  it("preserves original messages in order", () => {
    const result = injectNudge(baseMessages, metric);
    expect(result[0]).toBe(baseMessages[0]);
    expect(result[1]).toBe(baseMessages[1]);
  });
});
