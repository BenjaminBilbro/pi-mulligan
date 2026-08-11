/**
 * branch-isolation.test.ts — branch-scoping proof for BUG-004 fix.
 *
 * Verifies that after getEntries() → getBranch() swap, sibling-branch markers
 * do NOT leak into the active branch. Uses hand-rolled makeCtx fakes (NO vi.fn()).
 *
 * Covers:
 *   - readMarkers returns ONLY branch-B markers when getEntries() returns A+B
 *   - countRewindMarkers counts ONLY branch-B markers (tested via depth-guard)
 *   - listCheckpoints (audit call site) lists ONLY branch-B checkpoints
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readMarkers } from "../src/filter.js";
import { makeRewindTool } from "../src/tools/rewind.js";
import { auditTool } from "../src/tools/audit.js";
import { clearAll } from "../src/runtime.js";
import { setConfig } from "../src/config.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

beforeEach(() => {
  clearAll();
  setConfig(undefined);
});
afterEach(() => {
  clearAll();
  setConfig(undefined);
});

// ── Entry builders ──────────────────────────────────────────────────────────

function rewindEntry(seq: number) {
  return {
    type: "custom",
    customType: "mulligan:rewind",
    data: {
      schema: "pi-mulligan",
      v: 1,
      kind: "rewind",
      id: `rw-${seq}`,
      seq,
      ts: Date.now(),
      granularity: "last_tool_call_group",
      options: {},
      note: { what_happened: "t", avoid: "t", true_current_state: "t", next: "t" },
      ledger: { readFiles: [], modifiedFiles: [], bashSideEffects: [] },
    },
  };
}

function shrinkEntry(seq: number) {
  return {
    type: "custom",
    customType: "mulligan:shrink",
    data: {
      schema: "pi-mulligan",
      v: 1,
      kind: "shrink",
      id: `sh-${seq}`,
      seq,
      ts: Date.now(),
      target: { by_tool_call_id: "X" },
      replacement: "SUMMARY",
    },
  };
}

function checkpointLabelEntry(name: string, targetId: string) {
  return { type: "label", targetId, label: `mulligan:checkpoint:${name}`, id: `lbl-${name}` };
}

// ── makeCtx (hand-rolled, mirrors house idiom) ────────────────────────────────

function makeCtx(opts: {
  sessionId?: string;
  entries?: unknown[];
  branch?: unknown[];
  labels?: Map<string, string>;
  contextEntries?: unknown[];
  throwOnGetBranch?: boolean;
} = {}): ExtensionContext {
  const sessionId = opts.sessionId ?? "s1";
  const entries = opts.entries ?? [];
  const branch = opts.branch ?? entries; // default: branch mirrors entries
  const labels = opts.labels ?? new Map<string, string>();
  const contextEntries = opts.contextEntries ?? [];

  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getEntries: () => entries,
      getLabel(id: string) { return labels.get(id); },
      getBranch() {
        if (opts.throwOnGetBranch) throw new Error("getBranch boom");
        return branch;
      },
      buildContextEntries() { return contextEntries; },
    },
  } as unknown as ExtensionContext;
}

// ── Minimal fake Pi ──────────────────────────────────────────────────────────

function makePi() {
  const appended: { customType: string; data: unknown }[] = [];
  const sent: { customType: string; content: unknown; display: boolean; details?: unknown }[] = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) { appended.push({ customType, data }); },
    sendMessage(message: { customType: string; content: unknown; display: boolean; details?: unknown }) { sent.push(message); },
  };
  return { appended, sent, pi: pi as any };
}

// ════════════════════════════════════════════════════════════════════════════
// Branch-isolation: readMarkers
// ════════════════════════════════════════════════════════════════════════════

describe("BUG-004 branch isolation — readMarkers", () => {
  it("readMarkers returns ONLY branch-B markers when getBranch returns B and getEntries returns A+B", () => {
    // Branch-A markers (sibling — should be EXCLUDED)
    const branchA = [
      rewindEntry(1),
      rewindEntry(2),
      shrinkEntry(3),
    ];

    // Branch-B markers (current — should be INCLUDED)
    const branchB = [
      rewindEntry(10),
      shrinkEntry(11),
    ];

    const ctx = makeCtx({
      entries: [...branchA, ...branchB], // getEntries returns A+B
      branch: branchB, // getBranch returns only B
    });

    const markers = readMarkers(ctx);

    // Only branch-B markers
    expect(markers.rewinds).toHaveLength(1);
    expect(markers.rewinds[0].seq).toBe(10);
    expect(markers.shrinks).toHaveLength(1);
    expect(markers.shrinks[0].seq).toBe(11);
    expect(markers.metric).toBeNull();
  });

  it("readMarkers returns empty bundle when getBranch returns non-marker entries only", () => {
    const branchA = [rewindEntry(1)];
    const branchB = [
      { type: "message", id: "m1", message: { role: "user", content: "hi" } },
    ];

    const ctx = makeCtx({
      entries: [...branchA, ...branchB],
      branch: branchB,
    });

    const markers = readMarkers(ctx);
    expect(markers.rewinds).toHaveLength(0);
    expect(markers.shrinks).toHaveLength(0);
    expect(markers.metric).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Branch-isolation: countRewindMarkers (via depth guard)
// ════════════════════════════════════════════════════════════════════════════

describe("BUG-004 branch isolation — countRewindMarkers (depth guard)", () => {
  it("depth guard counts ONLY branch-B rewind markers: 2 on A + 1 on B, maxDepth=2 → succeeds", async () => {
    // 2 rewinds on sibling branch A — if counted, would hit maxDepth(2) and refuse
    const branchA = [rewindEntry(1), rewindEntry(2)];
    // 1 rewind on current branch B — under maxDepth(2), should succeed
    const branchB = [rewindEntry(10)];

    const ctx = makeCtx({
      entries: [...branchA, ...branchB],
      branch: branchB,
    });

    setConfig({ rewind: { maxDepth: 2 } });
    const { appended, pi } = makePi();
    const tool = makeRewindTool(pi);

    // Need some branch messages for the tool to resolve
    const contextEntries = [
      { type: "message", id: "e-u1", message: { role: "user", content: "hi" } },
    ];

    // Build a context that has the branch for resolvePreview but uses our custom entries/branch
    const fullCtx = makeCtx({
      entries: [...branchA, ...branchB],
      branch: [...branchB, ...contextEntries],
    });

    const res = await tool.execute("call-1", {
      note: {
        what_happened: "test",
        avoid: "test",
        true_current_state: "test",
        next: "test",
      },
      granularity: "last_tool_call_group",
    }, undefined, undefined, fullCtx);

    // Should SUCCEED — only 1 branch-B rewind counted (under maxDepth=2)
    // If A were counted, we'd have 2+1=3 ≥ 2 → refusal
    expect((res.content[0] as { text: string }).text).toMatch(/^Mulligan: rewound/);
    expect(appended).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Branch-isolation: listCheckpoints (audit call site)
// ════════════════════════════════════════════════════════════════════════════

describe("BUG-004 branch isolation — listCheckpoints (audit call site)", () => {
  it("audit lists ONLY branch-B checkpoints when getBranch returns B and getEntries returns A+B", async () => {
    // Checkpoint on sibling branch A
    const cpA = checkpointLabelEntry("cp-a", "entry-a");
    // Checkpoint on current branch B
    const cpB = checkpointLabelEntry("cp-b", "entry-b");

    const ctx = makeCtx({
      entries: [cpA, cpB], // getEntries returns both
      branch: [cpB], // getBranch returns only B
    });

    // Seed the cached filtered view so audit uses the primary path
    const rt = (ctx.sessionManager as any);
    // We need runtime module for this
    const { runtime } = await import("../src/runtime.js");
    runtime(rt).lastFiltered = [{ role: "user", content: "hi" }];

    const res = await auditTool.execute("call-1", {}, undefined, undefined, ctx);

    // Report should mention only cp-b
    expect((res.content[0] as { text: string }).text).toContain("1 checkpoints [cp-b]");
    expect((res.content[0] as { text: string }).text).not.toContain("cp-a");
    expect(res.details.nCheckpoints).toBe(1);
  });
});
