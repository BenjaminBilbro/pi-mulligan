# Research — P1.M3.T3.S1 — Role-aware Suggestion line (BUG-008)

## The bug
`src/tools/audit.ts:renderAuditReport` hard-codes the audit report's trailing
`Suggestion:` line as if the largest contributor (`rows[0]`) is ALWAYS a
`toolResult`:

```ts
// src/tools/audit.ts lines 474–479 (current)
  // Suggestion — names rows[0].label (the largest); omitted when filtered is empty (handled above)
  if (rows.length > 0) {
    lines.push(
      `Suggestion: the \`${rows[0].label}\` result is the largest contributor. Consider mulligan_shrink.`,
    );
  }
```

When the largest carrier is an **assistant** turn or a **user/custom/unknown**
message, the line reads wrongly:
- assistant → "the `(thinking + toolCall x2)` result is the largest contributor.
  Consider mulligan_shrink." — but `mulligan_shrink` substitutes a single tool
  *result*; an assistant turn is better addressed by `mulligan_rewind
  (last_tool_call_group)`.
- user paste → "the `user "…"` result is the largest contributor. Consider
  mulligan_shrink." — no Mulligan op applies to a non-tool message, so this is
  dishonest.

## Contract (from tasks.json context_scope — VERBATIM text to emit)
When `rows.length > 0`, branch on `rows[0].role`:
- (a) `role === "toolResult"` → UNCHANGED:
  ``Suggestion: the `${label}` result is the largest contributor. Consider mulligan_shrink.``
- (b) `role === "assistant"` →
  ``Suggestion: the assistant turn `${label}` is the largest contributor. Consider mulligan_rewind (last_tool_call_group) or mulligan_shrink.``
- (c) otherwise (user/custom/unknown) →
  ``Suggestion: the largest contributor is the `${label}` message (role: `${role}`); no Mulligan operation applies to a non-tool message.``

Trailing-newline behavior identical (`return lines.join("\n") + "\n";` unchanged).
NEVER throws (pure string interpolation — already inside the never-throws
`auditExecute` try/catch, and `renderAuditReport` is a pure exported fn).

## How rows[0].role / rows[0].label are populated (wiring proof)
`auditExecute` (src/tools/audit.ts ~line 545–557):
```ts
const rows: AuditRow[] = ranked.map(({ tokens, msg }) => ({
  tokens,
  role: readStr(msg, "role") ?? "?",          // ← the message's actual role
  label: describeMessage(msg, callLookup),    // ← see describeMessage table below
  bloaty: messageBytes(msg) > threshold,
  thresholdBytes: threshold,
}));
```
So `rows[0].role` reaching `renderAuditReport` is the real message role:
"toolResult" | "assistant" | "user" | "custom" | <unknown-role-string> | "?".

### describeMessage labels per role (src/tools/audit.ts ~line 250–290)
| role        | label shape                                | example                       |
|-------------|--------------------------------------------|-------------------------------|
| toolResult  | `${toolName} ${briefArgs}` (via callLookup)| `read src/foo.ts`             |
| assistant   | `summarizeAssistantContent(content)`       | `(thinking + toolCall x2)`    |
| user        | `` user "${snippet(text)}" ``              | `user "hello world, this is…"`|
| custom      | customType                                 | `mulligan:note`               |
| else        | role string                                | `branchSummary`               |

So e.g. for an assistant-largest carrier the rendered Suggestion reads:
`Suggestion: the assistant turn \`(thinking + toolCall x2)\` is the largest contributor. Consider mulligan_rewind (last_tool_call_group) or mulligan_shrink.`

## Scope / existing-test impact (verified by grep + reading the suite)
Full-repo grep for the Suggestion text found these touch-points:
- `src/tools/audit.ts:477` — the line being changed.
- `spec/05-tools.md:201` — the SPEC example, which shows the line for a
  toolResult ONLY. This is read-only reference (the design spec) and is NOT
  modified by this task; the toolResult branch (a) reproduces it byte-for-byte,
  so the spec example stays accurate. (The contract explicitly notes
  "spec/05 §4's example only shows this line for a toolResult" — i.e. the spec
  is consistent with a role-aware render.)
- `test/tools/audit.test.ts` — 4 assertion sites:
  - (b) cached-path happy path (~line 190–191): seeds `[user("hi"), asst("c1"),
    result("c1","read",bigText)]`; rows[0] is the big toolResult → asserts
    `Suggestion:` + `Consider mulligan_shrink.` → STILL PASSES under the
    toolResult branch (byte-identical text).
  - (e) empty filtered view (~line 277): asserts NOT `Suggestion:` → STILL PASSES.
  - (e) single message (~line 287–288): seeds `[result("c1","read","some output")]`
    → toolResult → asserts `Suggestion:` + `Consider mulligan_shrink.` → STILL PASSES.
  - (l) pure renderer empty filtered (~line 557): asserts NOT `Suggestion:` → STILL PASSES.

**Net: the change is ADDITIVE for the toolResult path (byte-identical) and only
DIVERGES for assistant / non-tool carriers — which no existing test asserts.
No existing test breaks.** Baseline = 692 passed / 2 skipped (verified
`npm test` 2026-08-11).

## README §6 / DOCS impact
Grep of README.md for `suggestion` / `largest contributor` / `Consider mulligan`
returns ONLY config-table rows mentioning the `mulligan_shrink` tool — README §6
does NOT quote the Suggestion format. So the Mode B doc sync (P1.M5.T1) is a
no-op confirmation: nothing to sync. design_decisions.md §BUG-008 says the same:
"a per-file behavior change to an LLM-facing string → Mode A doc note is not
required (the string is the doc)".

## Test plan (TDD: write-failing → implement → pass)
Primary coverage = PURE renderer tests (the bug lives in `renderAuditReport`).
Add a new `describe("renderAuditReport — role-aware Suggestion (BUG-008)")`
block in test/tools/audit.test.ts with cases that call `renderAuditReport`
directly with a hand-built single-row `rows` array:
1. rows[0].role = "toolResult" → report contains `result is the largest
   contributor` AND `Consider mulligan_shrink.` AND does NOT contain
   `the assistant turn` AND does NOT contain `no Mulligan operation applies`.
2. rows[0].role = "assistant" → contains `the assistant turn` AND
   `Consider mulligan_rewind (last_tool_call_group) or mulligan_shrink.` AND
   does NOT contain `result is the largest contributor`.
3. rows[0].role = "user" → contains `the largest contributor is the` AND
   `message (role: \`user\`)` AND `no Mulligan operation applies to a non-tool message.`
4. rows[0].role = "custom" (otherwise branch) → contains
   `no Mulligan operation applies to a non-tool message.` AND `role: \`custom\``.
5. (regression) empty filtered → report does NOT contain `Suggestion:` (mirrors
   existing (e)/(l) cases; colocated here for the role-aware feature).

Optional end-to-end (recommended, proves wiring role→AuditRow.role→Suggestion):
seed `lastFiltered` with an assistant message whose content is large enough to
be ranked rows[0] (estimateTokens is monotonic in content length — give the
assistant a long text block; keep all other messages tiny), then assert the
rendered report contains the assistant Suggestion substring. This is the
"largest carrier's role" proof. The pure renderer tests are sufficient for the
contract; the e2e test is a belt-and-suspenders extra.

## Validation gates (verified commands, one per level)
- L1 types: `npx tsc --noEmit -p tsconfig.json` (strict; no type change —
  `rows[0].role`/`.label` are already `string`).
- L2 unit (audit only): `npx vitest run test/tools/audit.test.ts`
- L3 full suite: `npm test` (vitest run; expect 692 + N new cases passed, 2 skipped).
- L4 manual scope review (null command): confirm ONLY the Suggestion block in
  renderAuditReport changed; the empty-filtered early-return + trailing
  `return lines.join("\n") + "\n";` unchanged; no BUG-004/BUG-005 regions touched.

## Confidence: 9/10
Surgical pure-string change in one exported fn; toolResult path byte-identical
(no existing test breaks); assistant/otherwise paths are net-new with net-new
tests. Only risk: forgetting that the spec example (spec/05 §4) is read-only and
NOT to be edited — called out explicitly.
