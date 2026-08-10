import { describe, it, expect, expectTypeOf } from "vitest";
import {
  validateNote,
  renderNote,
  renderBloatReminder,
  renderDriftNudge,
  NOTE_INVALID_REASON,
  type NoteInput,
  type NoteValidation,
  type DriftNudgeInput,
} from "../src/notes.js";
import type { FileLedger } from "../src/ledger.js";
import type { Granularity } from "../src/config.js";

// No beforeEach: notes.ts has NO module-scoped mutable state (pure functions + constants only).

/** A fully-valid note (all four fields non-empty). */
const VALID_NOTE: NoteInput = {
  what_happened:
    "Ran `grep -r auth .` and dumped ~40k tokens of output I didn't need.",
  avoid:
    "Do not run grep without --quiet, -c, or piping to head; prefer the built-in grep tool which truncates.",
  true_current_state: "No files were modified on the abandoned span.",
  next: "Re-run the search as `grep -rl auth src/` and read only the 3 relevant files.",
};

/** A ledger with all three lists empty. */
const EMPTY_LEDGER: FileLedger = {
  readFiles: [],
  modifiedFiles: [],
  bashSideEffects: [],
};

/** The two FIXED tail lines of the drift nudge (spec/07 §2). */
const DRIFT_TAIL = [
  "If that growth was wasteful, consider `mulligan_rewind` (undo the turn) or `mulligan_shrink` (compact a result).",
  "Run `mulligan_audit` for a breakdown.",
];

// ── validateNote tests ────────────────────────────────────────────────────

describe("validateNote — spec/05 §1 step 2 + spec/08 E9 + spec/10 §1.8 contract (pinned)", () => {
  it("all four fields present + non-empty → { valid: true } (no reason)", () => {
    const r = validateNote(VALID_NOTE);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("returns a NoteValidation { valid: boolean; reason?: string }", () => {
    const ok = validateNote(VALID_NOTE);
    expect(ok).toEqual({ valid: true });
    const bad = validateNote({ ...VALID_NOTE, what_happened: "" });
    expect(bad.valid).toBe(false);
    expect(typeof bad.reason).toBe("string");
  });
});

describe("validateNote — every field is independently required (any empty/whitespace → invalid)", () => {
  const FIELDS = ["what_happened", "avoid", "true_current_state", "next"] as const;

  for (const field of FIELDS) {
    it(`empty ${field} → invalid with the pinned reason (E9)`, () => {
      const r = validateNote({ ...VALID_NOTE, [field]: "" });
      expect(r.valid).toBe(false);
      expect(r.reason).toBe("note fields must all be non-empty");
    });

    it(`whitespace-only ${field} → invalid (trim check)`, () => {
      const r = validateNote({ ...VALID_NOTE, [field]: "   \n\t  " });
      expect(r.valid).toBe(false);
      expect(r.reason).toBe("note fields must all be non-empty");
    });
  }
});

describe("validateNote — non-string / missing fields → invalid (typeof check)", () => {
  it("a field set to a number → invalid", () => {
    const r = validateNote({ ...VALID_NOTE, next: 42 as unknown as string });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("note fields must all be non-empty");
  });

  it("a field set to null → invalid", () => {
    const r = validateNote({ ...VALID_NOTE, avoid: null as unknown as string });
    expect(r.valid).toBe(false);
  });

  it("a field set to undefined (missing at runtime) → invalid", () => {
    const r = validateNote({
      ...VALID_NOTE,
      what_happened: undefined as unknown as string,
    });
    expect(r.valid).toBe(false);
  });
});

describe("validateNote — the reason is the SINGLE spec-pinned string", () => {
  it("NOTE_INVALID_REASON is exported and equals the pinned literal (spec/05 step2, E9)", () => {
    expect(NOTE_INVALID_REASON).toBe("note fields must all be non-empty");
    expect(NOTE_INVALID_REASON.endsWith(".")).toBe(false);
  });

  it("every failure returns the SAME reason (no per-field variation)", () => {
    const a = validateNote({ ...VALID_NOTE, what_happened: "" });
    const b = validateNote({ ...VALID_NOTE, next: "  " });
    const c = validateNote({
      ...VALID_NOTE,
      avoid: null as unknown as string,
    });
    expect(a.reason).toBe(NOTE_INVALID_REASON);
    expect(b.reason).toBe(NOTE_INVALID_REASON);
    expect(c.reason).toBe(NOTE_INVALID_REASON);
  });
});

describe("validateNote — trim does not over-reject genuinely-valid content", () => {
  it("fields with leading/trailing whitespace but real content → valid", () => {
    const r = validateNote({
      what_happened: "  went down a rabbit hole  ",
      avoid: " don't grep without filters ",
      true_current_state: " scratch.ts was created ",
      next: " delete scratch.ts and restart ",
    });
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("single-character fields are valid (non-empty after trim)", () => {
    const r = validateNote({
      what_happened: "x",
      avoid: "y",
      true_current_state: "z",
      next: "w",
    });
    expect(r.valid).toBe(true);
  });
});

describe("validateNote — defensive (NEVER throws)", () => {
  it("a null note passed as NoteInput → invalid, not a throw", () => {
    expect(() =>
      validateNote(null as unknown as NoteInput),
    ).not.toThrow();
    expect(validateNote(null as unknown as NoteInput).valid).toBe(false);
  });

  it("an array passed as NoteInput → invalid, not a throw", () => {
    const arr = ["x", "y", "z", "w"] as unknown as NoteInput;
    expect(() => validateNote(arr)).not.toThrow();
    expect(validateNote(arr).valid).toBe(false);
  });

  it("a primitive passed as NoteInput → invalid, not a throw", () => {
    expect(() =>
      validateNote("not a note" as unknown as NoteInput),
    ).not.toThrow();
    expect(validateNote("not a note" as unknown as NoteInput).valid).toBe(
      false,
    );
  });

  it("does not throw on a throwing-Proxy note (readOwn swallows the get-trap)", () => {
    const trap = new Proxy(
      { ...VALID_NOTE } as NoteInput,
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    );
    expect(() => validateNote(trap)).not.toThrow();
    expect(validateNote(trap).valid).toBe(false);
  });
});

describe("validateNote — types", () => {
  it("NoteInput has exactly the four required string fields (spec/04 §2.1)", () => {
    expectTypeOf<NoteInput>().toEqualTypeOf<{
      what_happened: string;
      avoid: string;
      true_current_state: string;
      next: string;
    }>();
  });

  it("validateNote returns NoteValidation", () => {
    expectTypeOf(validateNote(VALID_NOTE)).toEqualTypeOf<NoteValidation>();
  });

  it("NoteValidation is { valid: boolean; reason?: string }", () => {
    expectTypeOf<NoteValidation>().toEqualTypeOf<{
      valid: boolean;
      reason?: string;
    }>();
  });

  it("NOTE_INVALID_REASON is a string", () => {
    expectTypeOf(NOTE_INVALID_REASON).toEqualTypeOf<string>();
  });
});

// ── renderNote tests ───────────────────────────────────────────────────────

describe("renderNote — spec/04 §2.3 pinned format", () => {
  it("all ledger lists empty → no ledger blocks; header interpolates granularity VERBATIM", () => {
    const out = renderNote(VALID_NOTE, EMPTY_LEDGER, "last_turn");
    expect(out).toBe(
      [
        "## 🔄 Mulligan rewind (last_turn)",
        "",
        `**What happened:** ${VALID_NOTE.what_happened}`,
        "",
        `**Avoid:** ${VALID_NOTE.avoid}`,
        "",
        `**Current true state:** ${VALID_NOTE.true_current_state}`,
        "",
        `**Next:** ${VALID_NOTE.next}`,
      ].join("\n"),
    );
    expect(out.endsWith("\n")).toBe(false);
    expect(out).not.toContain("<files-read>");
    expect(out).not.toContain("<files-modified>");
    expect(out).not.toContain("<bash-side-effects>");
  });

  it("all three ledger lists non-empty → all three blocks, in read→modified→bash order", () => {
    const ledger: FileLedger = {
      readFiles: ["path/a.ts", "path/b.ts"],
      modifiedFiles: ["path/c.ts"],
      bashSideEffects: ['git commit -m "wip"'],
    };
    const out = renderNote(VALID_NOTE, ledger, "last_tool_call_group");
    expect(out).toBe(
      [
        "## 🔄 Mulligan rewind (last_tool_call_group)",
        "",
        `**What happened:** ${VALID_NOTE.what_happened}`,
        "",
        `**Avoid:** ${VALID_NOTE.avoid}`,
        "",
        `**Current true state:** ${VALID_NOTE.true_current_state}`,
        "",
        "<files-read>",
        "path/a.ts",
        "path/b.ts",
        "</files-read>",
        "",
        "<files-modified>",
        "path/c.ts",
        "</files-modified>",
        "",
        "<bash-side-effects>",
        'git commit -m "wip"',
        "</bash-side-effects>",
        "",
        `**Next:** ${VALID_NOTE.next}`,
      ].join("\n"),
    );
  });

  it("partial ledger (only readFiles) → only <files-read> block", () => {
    const ledger: FileLedger = {
      readFiles: ["src/x.ts"],
      modifiedFiles: [],
      bashSideEffects: [],
    };
    const out = renderNote(VALID_NOTE, ledger, "checkpoint");
    expect(out).toContain("## 🔄 Mulligan rewind (checkpoint)");
    expect(out).toContain("<files-read>\nsrc/x.ts\n</files-read>");
    expect(out).not.toContain("<files-modified>");
    expect(out).not.toContain("<bash-side-effects>");
  });

  it("only bashSideEffects non-empty → only <bash-side-effects> block", () => {
    const ledger: FileLedger = {
      readFiles: [],
      modifiedFiles: [],
      bashSideEffects: ["rm -rf node_modules", "npm install"],
    };
    const out = renderNote(VALID_NOTE, ledger, "last_turn");
    expect(out).toContain(
      "<bash-side-effects>\nrm -rf node_modules\nnpm install\n</bash-side-effects>",
    );
    expect(out).not.toContain("<files-read>");
    expect(out).not.toContain("<files-modified>");
  });

  it("only modifiedFiles non-empty → only <files-modified> block", () => {
    const ledger: FileLedger = {
      readFiles: [],
      modifiedFiles: ["a.ts", "b.ts"],
      bashSideEffects: [],
    };
    const out = renderNote(VALID_NOTE, ledger, "last_tool_call_group");
    expect(out).toContain(
      "<files-modified>\na.ts\nb.ts\n</files-modified>",
    );
    expect(out).not.toContain("<files-read>");
    expect(out).not.toContain("<bash-side-effects>");
  });
});

describe("renderNote — snapshot-style cases (spec/10 §1.8)", () => {
  it("representative last_turn note with a full ledger", () => {
    const ledger: FileLedger = {
      readFiles: ["src/auth/session.ts"],
      modifiedFiles: ["src/auth/session.ts"],
      bashSideEffects: ["npm run build"],
    };
    expect(
      renderNote(VALID_NOTE, ledger, "last_turn"),
    ).toMatchInlineSnapshot(`
      "## 🔄 Mulligan rewind (last_turn)

      **What happened:** Ran \`grep -r auth .\` and dumped ~40k tokens of output I didn't need.

      **Avoid:** Do not run grep without --quiet, -c, or piping to head; prefer the built-in grep tool which truncates.

      **Current true state:** No files were modified on the abandoned span.

      <files-read>
      src/auth/session.ts
      </files-read>

      <files-modified>
      src/auth/session.ts
      </files-modified>

      <bash-side-effects>
      npm run build
      </bash-side-effects>

      **Next:** Re-run the search as \`grep -rl auth src/\` and read only the 3 relevant files."
    `);
  });

  it("representative last_tool_call_group note with an empty ledger", () => {
    expect(
      renderNote(VALID_NOTE, EMPTY_LEDGER, "last_tool_call_group"),
    ).toMatchInlineSnapshot(`
      "## 🔄 Mulligan rewind (last_tool_call_group)

      **What happened:** Ran \`grep -r auth .\` and dumped ~40k tokens of output I didn't need.

      **Avoid:** Do not run grep without --quiet, -c, or piping to head; prefer the built-in grep tool which truncates.

      **Current true state:** No files were modified on the abandoned span.

      **Next:** Re-run the search as \`grep -rl auth src/\` and read only the 3 relevant files."
    `);
  });
});

describe("renderNote — field values rendered AS-IS (no escaping/transform)", () => {
  it("fields containing markdown / backticks / quotes are interpolated verbatim", () => {
    const note: NoteInput = {
      what_happened: "ran `grep -r auth .` → ~38k tokens",
      avoid: "don't run wide grep; use **-l** or pipe to `head`",
      true_current_state: 'no files changed; "scratch.ts" not created',
      next: "re-run as `grep -rl auth src/`",
    };
    const out = renderNote(note, EMPTY_LEDGER, "last_turn");
    expect(out).toContain(
      "**What happened:** ran `grep -r auth .` → ~38k tokens",
    );
    expect(out).toContain(
      '**Current true state:** no files changed; "scratch.ts" not created',
    );
    expect(out).toContain("**Next:** re-run as `grep -rl auth src/`");
  });
});

describe("renderNote — defensive (NEVER throws)", () => {
  it("a null note passed as NoteInput → renders empty fields, not a throw", () => {
    expect(() =>
      renderNote(null as unknown as NoteInput, EMPTY_LEDGER, "last_turn"),
    ).not.toThrow();
    const out = renderNote(null as unknown as NoteInput, EMPTY_LEDGER, "last_turn");
    expect(out).toContain("## 🔄 Mulligan rewind (last_turn)");
    expect(out).toContain("**What happened:** ");
  });

  it("an array passed as NoteInput → renders empty fields, not a throw", () => {
    expect(() =>
      renderNote(
        ["x", "y", "z", "w"] as unknown as NoteInput,
        EMPTY_LEDGER,
        "last_turn",
      ),
    ).not.toThrow();
  });

  it("a null ledger passed as FileLedger → no blocks, not a throw", () => {
    expect(() =>
      renderNote(VALID_NOTE, null as unknown as FileLedger, "last_turn"),
    ).not.toThrow();
    const out = renderNote(
      VALID_NOTE,
      null as unknown as FileLedger,
      "last_turn",
    );
    expect(out).not.toContain("<files-read>");
  });

  it("a ledger with non-array lists → no blocks, not a throw", () => {
    const bad = {
      readFiles: "src/a.ts",
      modifiedFiles: null,
      bashSideEffects: undefined,
    } as unknown as FileLedger;
    expect(() => renderNote(VALID_NOTE, bad, "last_turn")).not.toThrow();
    expect(renderNote(VALID_NOTE, bad, "last_turn")).not.toContain("<files-read>");
  });

  it("does not throw on a throwing-Proxy note (readOwn swallows the get-trap)", () => {
    const trap = new Proxy(
      { ...VALID_NOTE } as NoteInput,
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    );
    expect(() => renderNote(trap, EMPTY_LEDGER, "last_turn")).not.toThrow();
    const out = renderNote(trap, EMPTY_LEDGER, "last_turn");
    expect(out).toContain("## 🔄 Mulligan rewind (last_turn)");
    expect(out).toContain("**Next:** ");
  });
});

describe("renderNote — types", () => {
  it("renderNote returns a string", () => {
    expectTypeOf(
      renderNote(VALID_NOTE, EMPTY_LEDGER, "last_turn"),
    ).toEqualTypeOf<string>();
  });

  it("Granularity is the three rewind granularities", () => {
    expectTypeOf<Granularity>().toEqualTypeOf<
      "last_tool_call_group" | "last_turn" | "checkpoint"
    >();
  });

  it("FileLedger has the three string[] lists", () => {
    expectTypeOf<FileLedger>().toEqualTypeOf<{
      readFiles: string[];
      modifiedFiles: string[];
      bashSideEffects: string[];
    }>();
  });
});

// ── renderBloatReminder tests ────────────────────────────────────────────────

describe("renderBloatReminder — spec/07 §1 pinned format", () => {
  it("8 KB result at an 8 KB threshold → '~8 KB … (threshold 8 KB)'; leading \\n---\\n; no trailing newline", () => {
    const out = renderBloatReminder("read", 8192, 8192);
    expect(out).toBe(
      "\n---\n" +
        [
          "[mulligan] This result is ~8 KB in your context (threshold 8 KB).",
          "If you don't need the full output going forward, call `mulligan_shrink` with a",
          'summary, or `mulligan_rewind(granularity:"last_tool_call_group")` if the whole',
          "call was a mistake. (The hidden/shrunk content stays on disk for the human.)",
        ].join("\n"),
    );
    expect(out.startsWith("\n---\n")).toBe(true);
    expect(out.endsWith("\n")).toBe(false);
  });

  it("30 KB result at 8 KB threshold → '~30 KB … (threshold 8 KB)'", () => {
    const out = renderBloatReminder("read", 30720, 8192);
    expect(out).toContain(
      "[mulligan] This result is ~30 KB in your context (threshold 8 KB).",
    );
  });

  it("bytes round to the nearest KB (8704 bytes = 8.5 KB → '~9 KB')", () => {
    const out = renderBloatReminder("bash", 8704, 8192);
    expect(out).toContain(
      "This result is ~9 KB in your context (threshold 8 KB).",
    );
  });

  it("body text is VERBATIM (backticks, the granularity literal, the soft line breaks)", () => {
    const out = renderBloatReminder("read", 8192, 8192);
    expect(out).toContain("call `mulligan_shrink` with a\nsummary, or");
    expect(out).toContain(
      '`mulligan_rewind(granularity:"last_tool_call_group")`',
    );
    expect(out).toContain(
      "(The hidden/shrunk content stays on disk for the human.)",
    );
  });

  it("toolName is accepted but NOT interpolated into the v1 text", () => {
    const a = renderBloatReminder("read", 8192, 8192);
    const b = renderBloatReminder("grep", 8192, 8192);
    expect(a).toBe(b);
    expect(a).not.toContain("read");
    expect(a).not.toContain("grep");
  });
});

describe("renderBloatReminder — defensive (NEVER throws / bad numbers → 0 KB)", () => {
  it("NaN bytes → '~0 KB'", () => {
    expect(
      renderBloatReminder("read", NaN, 8192),
    ).toContain("This result is ~0 KB in your context (threshold 8 KB).");
  });
  it("negative bytes → '~0 KB'", () => {
    expect(
      renderBloatReminder("read", -100, 8192),
    ).toContain("This result is ~0 KB in your context (threshold 8 KB).");
  });
  it("Infinity bytes → '~0 KB'", () => {
    expect(
      renderBloatReminder("read", Infinity, 8192),
    ).toContain("This result is ~0 KB in your context (threshold 8 KB).");
  });
  it("non-finite threshold → 'threshold 0 KB'", () => {
    expect(renderBloatReminder("read", 8192, NaN)).toContain(
      "(threshold 0 KB).",
    );
  });
  it("never throws on any number input", () => {
    expect(() => renderBloatReminder("read", NaN, NaN)).not.toThrow();
    expect(() =>
      renderBloatReminder("read", -Infinity, Infinity),
    ).not.toThrow();
  });
});

describe("renderBloatReminder — snapshot-style", () => {
  it("representative 30 KB read at an 8 KB threshold", () => {
    expect(
      renderBloatReminder("read", 30720, 8192),
    ).toMatchInlineSnapshot(`
      "
      ---
      [mulligan] This result is ~30 KB in your context (threshold 8 KB).
      If you don't need the full output going forward, call \`mulligan_shrink\` with a
      summary, or \`mulligan_rewind(granularity:"last_tool_call_group")\` if the whole
      call was a mistake. (The hidden/shrunk content stays on disk for the human.)"
    `);
  });
});

// ── renderDriftNudge tests ──────────────────────────────────────────────────

describe("renderDriftNudge — spec/07 §2 pinned format (first line varies; tails FIXED)", () => {
  it("delta only (4200 tokens) → 'added ~4.2k tokens'; no bloat clause; no trailing newline", () => {
    const out = renderDriftNudge({ deltaTokens: 4200, bloatHits: [] });
    expect(out).toBe(
      [
        "[mulligan] Previous turn added ~4.2k tokens to your context.",
        ...DRIFT_TAIL,
      ].join("\n"),
    );
    expect(out.endsWith("\n")).toBe(false);
    expect(out).not.toContain("bloated");
  });

  it("delta + 1 bloat hit → '… and produced 1 bloated result' (singular)", () => {
    const out = renderDriftNudge({
      deltaTokens: 5000,
      bloatHits: [{ toolName: "read", approxTokens: 7680 }],
    });
    expect(out).toBe(
      [
        "[mulligan] Previous turn added ~5k tokens to your context and produced 1 bloated result.",
        ...DRIFT_TAIL,
      ].join("\n"),
    );
  });

  it("delta + 3 bloat hits → '… and produced 3 bloated results' (plural)", () => {
    const out = renderDriftNudge({
      deltaTokens: 8000,
      bloatHits: [
        { toolName: "read", approxTokens: 2000 },
        { toolName: "bash", approxTokens: 1500 },
        { toolName: "read", approxTokens: 3000 },
      ],
    });
    expect(out).toContain(
      "[mulligan] Previous turn added ~8k tokens to your context and produced 3 bloated results.",
    );
  });

  it("null delta + 2 bloat hits (first turn) → bloat LEADS", () => {
    const out = renderDriftNudge({
      deltaTokens: null,
      bloatHits: [
        { toolName: "read", approxTokens: 2048 },
        { toolName: "bash", approxTokens: 1024 },
      ],
    });
    expect(out).toBe(
      ["[mulligan] Previous turn produced 2 bloated results.", ...DRIFT_TAIL].join(
        "\n",
      ),
    );
    expect(out).not.toContain("added ~");
  });

  it("null delta + empty bloat (defensive fallback) → neutral line", () => {
    const out = renderDriftNudge({ deltaTokens: null, bloatHits: [] });
    expect(out).toBe(
      ["[mulligan] Previous turn changed your context.", ...DRIFT_TAIL].join(
        "\n",
      ),
    );
  });

  it("the two tail lines are FIXED and present in EVERY case", () => {
    const cases: DriftNudgeInput[] = [
      { deltaTokens: 4200, bloatHits: [] },
      {
        deltaTokens: 5000,
        bloatHits: [{ toolName: "read", approxTokens: 7680 }],
      },
      {
        deltaTokens: null,
        bloatHits: [{ toolName: "read", approxTokens: 2048 }],
      },
      { deltaTokens: null, bloatHits: [] },
    ];
    for (const c of cases) {
      const out = renderDriftNudge(c);
      expect(out).toContain(DRIFT_TAIL[0]);
      expect(out).toContain(DRIFT_TAIL[1]);
    }
  });
});

describe("renderDriftNudge — rounding & pluralization", () => {
  it("kTokens: 3000→'3k', 9800→'9.8k', 42000→'42k'", () => {
    expect(
      renderDriftNudge({ deltaTokens: 3000, bloatHits: [] }),
    ).toContain("added ~3k tokens");
    expect(
      renderDriftNudge({ deltaTokens: 9800, bloatHits: [] }),
    ).toContain("added ~9.8k tokens");
    expect(
      renderDriftNudge({ deltaTokens: 42000, bloatHits: [] }),
    ).toContain("added ~42k tokens");
  });

  it("pluralization: 1→'result', 2→'results', 5→'results'", () => {
    const one = renderDriftNudge({
      deltaTokens: null,
      bloatHits: [{ toolName: "x", approxTokens: 1 }],
    });
    expect(one).toContain("produced 1 bloated result.");
    const two = renderDriftNudge({
      deltaTokens: null,
      bloatHits: [
        { toolName: "a", approxTokens: 1 },
        { toolName: "b", approxTokens: 2 },
      ],
    });
    expect(two).toContain("produced 2 bloated results.");
    const five = renderDriftNudge({
      deltaTokens: null,
      bloatHits: [1, 2, 3, 4, 5].map((i) => ({
        toolName: `t${i}`,
        approxTokens: i,
      })),
    });
    expect(five).toContain("produced 5 bloated results.");
  });
});

describe("renderDriftNudge — defensive (NEVER throws)", () => {
  it("a null metric → neutral fallback, not a throw", () => {
    expect(() =>
      renderDriftNudge(null as unknown as DriftNudgeInput),
    ).not.toThrow();
    expect(
      renderDriftNudge(null as unknown as DriftNudgeInput),
    ).toContain("[mulligan] Previous turn changed your context.");
  });

  it("an array metric → neutral fallback, not a throw", () => {
    expect(() =>
      renderDriftNudge([1, 2, 3] as unknown as DriftNudgeInput),
    ).not.toThrow();
  });

  it("a metric with non-array bloatHits → no bloat clause, not a throw", () => {
    const out = renderDriftNudge({
      deltaTokens: 4000,
      bloatHits: "nope" as unknown as DriftNudgeInput["bloatHits"],
    });
    expect(out).toContain("added ~4k tokens to your context.");
    expect(out).not.toContain("bloated");
  });

  it("a metric with malformed bloat-hit entries → they are not counted", () => {
    const out = renderDriftNudge({
      deltaTokens: null,
      bloatHits: [
        { toolName: "read", approxTokens: 100 },
        { foo: "bar" },
        null,
        42,
      ] as unknown as DriftNudgeInput["bloatHits"],
    });
    expect(out).toContain("produced 1 bloated result.");
  });

  it("does not throw on a throwing-Proxy metric (readOwn swallows the get-trap)", () => {
    const trap = new Proxy(
      { deltaTokens: 4200, bloatHits: [] } as DriftNudgeInput,
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    );
    expect(() => renderDriftNudge(trap)).not.toThrow();
    expect(renderDriftNudge(trap)).toContain(
      "[mulligan] Previous turn changed your context.",
    );
  });
});

describe("renderDriftNudge — snapshot-style", () => {
  it("representative drift-only nudge (~4.2k tokens)", () => {
    expect(
      renderDriftNudge({ deltaTokens: 4200, bloatHits: [] }),
    ).toMatchInlineSnapshot(`
      "[mulligan] Previous turn added ~4.2k tokens to your context.
      If that growth was wasteful, consider \`mulligan_rewind\` (undo the turn) or \`mulligan_shrink\` (compact a result).
      Run \`mulligan_audit\` for a breakdown."
    `);
  });

  it("representative first-turn bloat-only nudge (null delta + 2 hits)", () => {
    expect(
      renderDriftNudge({
        deltaTokens: null,
        bloatHits: [
          { toolName: "read", approxTokens: 2048 },
          { toolName: "bash", approxTokens: 1024 },
        ],
      }),
    ).toMatchInlineSnapshot(`
      "[mulligan] Previous turn produced 2 bloated results.
      If that growth was wasteful, consider \`mulligan_rewind\` (undo the turn) or \`mulligan_shrink\` (compact a result).
      Run \`mulligan_audit\` for a breakdown."
    `);
  });
});

// ── Renderer types ──────────────────────────────────────────────────────────

describe("renderers — types", () => {
  it("renderBloatReminder returns a string", () => {
    expectTypeOf(renderBloatReminder("read", 8192, 8192)).toEqualTypeOf<
      string
    >();
  });

  it("renderDriftNudge returns a string", () => {
    expectTypeOf(
      renderDriftNudge({ deltaTokens: 4200, bloatHits: [] }),
    ).toEqualTypeOf<string>();
  });

  it("DriftNudgeInput is the 2-field metric projection (spec/04 §5)", () => {
    expectTypeOf<DriftNudgeInput>().toEqualTypeOf<{
      deltaTokens: number | null;
      bloatHits: ReadonlyArray<{ toolName: string; approxTokens: number }>;
    }>();
  });

  it("a real TurnMetric-shaped object is assignable to DriftNudgeInput with NO cast (structural typing)", () => {
    const turnMetric = {
      tokenBaseline: 10000,
      tokenAfter: 14200,
      deltaTokens: 4200,
      bloatHits: [{ toolName: "read", approxTokens: 7680 }],
    };
    // This should type-check without any cast:
    const input: DriftNudgeInput = turnMetric;
    expectTypeOf(input).toEqualTypeOf<DriftNudgeInput>();
    expect(renderDriftNudge(input)).toContain("added ~4.2k tokens");
  });
});
