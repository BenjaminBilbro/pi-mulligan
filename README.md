# pi-mulligan

> Autonomous, token-cheap context self-rewind for a [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent. The agent sheds context it produced by mistake and redoes a turn with a self-authored note — no human in the loop.

**Pi:** `0.84.x` · **License:** MIT · **Status:** v1

---

## 1. Overview

**pi-mulligan** is a Pi extension that gives a coding agent autonomous, token-cheap control over its own context window — the ability to shed context it produced by mistake (a giant un-suppressed command output, a too-large file read, a wrong-direction exploration) and to *redo* a turn with a self-authored note, without a human in the loop.

The name comes from golf: a *mulligan* is a courtesy do-over — a second shot after a bad one, without penalty. That is exactly what this extension gives the agent.

**Why agents need this:**

- **Unbounded output capture.** A `grep -r foo .` over a monorepo or a `cat` on a log produces thousands of tokens of output that then persist in *every* subsequent turn.
- **Wrong-direction work.** The agent pursues an approach across turns, accumulates a footprint, then reaches an insight that invalidates it — but the sunk context keeps taxing every future inference.
- **Silent accumulation.** No single result is catastrophic, but the turn grew the context sharply and the agent has no built-in signal that it is drifting toward an auto-compaction it would rather avoid.

**Why Pi's existing tools don't solve it:** compaction summarizes the *head* and *keeps the tail* (it sheds *old* context — the wrong direction for this use case), and `/tree`, `/compact`, and `/fork` are all human-driven — an agent tool has no route to invoke them (proven in `spec/02-proven-constraints.md`). There is no agent-callable primitive for "forget what I just did and try again." Mulligan provides it.

See `spec/SPEC.md` §1–§2 for the full executive summary and problem statement.

---

## 2. Installation

> **Works with zero configuration.** No `mulligan` settings are needed — the extension loads with all defaults (see [Configuration](#3-configuration) below).

### Three ways to load the extension

1. **Quick test — the `-e` / `--extension` flag:**

   ```bash
   pi -e ./src/index.ts
   ```

2. **Auto-discovery (recommended for daily use; supports `/reload`):** place the extension in one of Pi's extension directories:

   - `.pi/extensions/*.ts` — project-local (loads after project trust), or
   - `~/.pi/agent/extensions/*.ts` — global.

   This repo ships as `src/index.ts`; symlink or copy it into the auto-discovery directory so it is discoverable, or keep using `pi -e` for development.

3. **As a distributed Pi package:** `pi install` (npm or git), per Pi's `docs/packages.md`:

   ```bash
   pi install npm:<scope>/<pkg>@<ver>
   pi install git:github.com/user/repo@<ref>
   pi install ./relative/path
   ```

   `pi -e npm:<pkg>` tries without installing.

### npm for editor types (optional)

The repo declares its runtime deps in `package.json`. Running `npm install` resolves `node_modules/` so editors get IntelliSense/type-resolution. **It is not required to run** — at runtime, Pi resolves these deps from its own install (extensions are jiti-loaded in Pi's process).

### Zero-config smoke (the acceptance check)

```bash
pi -e ./src/index.ts        # loads with NO mulligan config → all defaults → works out of the box
```

This is the `spec/11-build-order.md` §2 Step 9 acceptance check: the extension must load without error with an absent or empty `mulligan` config block.

### Requirements

- **Pi** `0.84.x`.
- **Node ESM** (the project's `package.json` has `"type": "module"`).

---

## 3. Configuration

Mulligan reads a `mulligan` object from Pi `settings.json` — the global `~/.pi/agent/settings.json` and/or the project-local `.pi/settings.json` (project-local overrides global). The project-local file is read only when the project is trusted (`ctx.isProjectTrusted()`); in an untrusted project only the global settings apply. It is loaded lazily on first use, cached for the session, and re-read on `/reload`. See `spec/09-configuration.md` §1.

> **Zero configuration.** Every option has a safe default. Unknown keys are ignored; type-mismatched values fall back to the default with a `warn`; **validation never throws.** The extension works with an empty or absent `mulligan` block.

### Defaults table

All 12 knobs (source of truth: `src/config.ts` `DEFAULT_CONFIG`; rationale: `spec/09-configuration.md` §2–§3).

| Knob | Default | What it does |
|------|---------|--------------|
| **master** | | |
| `enabled` | `true` | Master switch. `false` → the entire extension is a no-op (see [Disabling](#disabling)). |
| **rewind** | | |
| `rewind.enabled` | `true` | Enable the `mulligan_rewind` tool. |
| `rewind.protectedRoles` | `["first:user", "latest:user"]` | Message selectors that can never be rewound past (the original task / the current ask). v1 supports these two selectors; unknown entries are dropped. |
| `rewind.maxDepth` | `5` | Max simultaneous *active* `mulligan:rewind` markers on a branch. Bounds accumulation (markers are permanent). |
| `rewind.requireMutationWarning` | `true` | Append a ⚠ warning when the hidden span wrote files / ran side-effecting bash (those effects persist on disk). |
| **shrink** | | |
| `shrink.enabled` | `true` | Enable the `mulligan_shrink` tool. |
| **nudges** | | |
| `nudges.bloatReminder` | `true` | Annotate a `tool_result` exceeding the byte threshold with a rewind reminder. |
| `nudges.perTurnDrift` | `true` | Inject a one-line drift nudge when a turn grew past the token threshold. |
| `nudges.bloatThresholdBytes` | `8192` | In-context byte size of a single tool result above which the bloat reminder fires. |
| `nudges.driftThresholdTokens` | `3000` | Per-turn token delta that triggers the drift nudge. |
| **audit** | | |
| `audit.estimateConfidence` | `"medium"` | Honesty label reported with token estimates (`low` \| `medium` \| `high`). |
| **log** | | |
| `log.file` | `null` | Off by default. An absolute path to an append-only JSONL debug log. |

### Minimal example `settings.json`

The `mulligan` block is **optional** — omit it entirely for all defaults. Here is its shape, commented out so you can see the keys:

```jsonc
{
  // "mulligan": {
  //   "enabled": true,
  //   "rewind": { "enabled": true, "maxDepth": 5, "requireMutationWarning": true },
  //   "shrink": { "enabled": true },
  //   "nudges": { "bloatReminder": true, "perTurnDrift": true, "bloatThresholdBytes": 8192, "driftThresholdTokens": 3000 },
  //   "audit": { "estimateConfidence": "medium" },
  //   "log": { "file": null }
  // }
}
```

#### Disabling

`enabled: false` makes the **entire extension a no-op**: no context transform (the filter passes messages through untouched), the nudges are inert, and **all four tools** refuse cleanly with `Mulligan: refused — Mulligan is disabled.` (`rewind`, `shrink`, `audit`, and `checkpoint` all gate on the master switch — each refuses before doing any work; `audit` refuses while staying read-only in its normal operation). The human can disable Mulligan without uninstalling it.

---

## 4. Tools

Mulligan registers four agent-callable tools. The descriptions below are **verbatim copies** of the LLM-facing description strings the agent sees at runtime (from `src/tools/*.ts`) — they are the agent's documentation, reproduced here so a human knows exactly what the agent can now do. When-to-use guidance follows each one (from `spec/05-tools.md`).

### `mulligan_rewind`

> Shed recent context you produced by mistake (a bloated tool result, or a whole wrong-direction turn) and leave yourself a note so you can try again with a clean view. The hidden content disappears from your view permanently (it stays on disk for the human). Costs only a short note. Use granularity 'last_tool_call_group' to undo just the last tool interaction, or 'last_turn' to redo the whole turn from the user's last message.

**When to use it:**

- After a bloated tool result you cannot undo (e.g. an un-redirected `grep -r`) — shed it and re-approach.
- After a whole turn pursued the wrong direction — drop the work since the last user message and re-attempt.
- To jump back to a named checkpoint before a speculative sub-task you want to discard wholesale.

**Granularities:**

| `granularity` | What it hides |
|---------------|---------------|
| `last_tool_call_group` | Surgical — the most recent assistant turn that issued tool calls *plus* its tool-result messages. Keeps surrounding reasoning. |
| `last_turn` | Everything after the most recent user message (assistant + tool-result work produced this turn). The model lands back at the current user prompt. |
| `checkpoint` | Back to a named checkpoint set via `mulligan_checkpoint` (requires the `checkpoint` param). |

**The note (confabulation defense).** A rewind requires a `note` with non-empty fields — `what_happened` (what happened and the lesson to avoid repeating), `true_current_state` (task progress, decisions, and conclusions — files/commands are auto-captured in the ledger), `avoid`, and `next` (the immediate next action). Vacuous notes are refused. The resumed model reads this note as the most-recent context.

⚠ **Side effects persist.** If the hidden span wrote files or ran side-effecting commands, those effects remain on disk. The tool appends a mutation warning when this is detected (controlled by `rewind.requireMutationWarning`).

### `mulligan_shrink`

> Replace a specific past tool result with a compact summary you provide, in your view, going forward. Use when the call was fine but its output is too big to keep carrying. Unlike rewind, the call stays in context (just with your summary as its result).

**When to use it (vs `mulligan_rewind`):** rewind = the call was a *mistake* — it is gone, replaced by a fresh attempt; shrink = the call was *fine* but its *output* is bloated — the call stays, and its result is swapped for your summary.

**Target matchers** (resolved live each turn, robust to compaction):

- `by_tool_call_id` — the unique toolCallId of the result to shrink.
- `by_tool_name` + `occurrence` (`"last"` / `"first"`) — semantic match by tool name.
- `by_content_includes` — the first message (any role) whose text contains the substring.

The `replacement` must be non-empty and **faithful** — the model treats it as ground truth from then on.

### `mulligan_checkpoint`

> Name the current position so a later mulligan_rewind can jump straight back to it. Use before a speculative sub-task you might want to undo in one shot.

**When to use it:** before a speculative sub-task you might want to discard wholesale — set a checkpoint, and a later `mulligan_rewind(granularity:"checkpoint", checkpoint:"<name>")` returns to it in one shot.

The `name` must match `/^[a-z0-9_-]{1,40}$/` (lowercase, digits, hyphen, underscore; 1–40 chars). Invalid names are refused.

### `mulligan_audit`

> Show a token breakdown of the context you're currently carrying (what the model actually sees), flag the biggest contributors, and list active Mulligan markers. Use this to decide whether to rewind or shrink.

**When to use it:** when you suspect context is bloated and want to decide between rewind (mistake) and shrink (fine-but-big). The report ranks the top messages by size, flags results above the bloat threshold, and lists active rewind/shrink markers + checkpoints — closing the feedback loop ("that one read is 9.4k → shrink it").

The token total is computed from the **filtered view** (what the model actually sees after Mulligan's transforms) — *not* Pi's `getContextUsage()`, which would count already-hidden tokens. The audit is **read-only** and persists nothing.

---

## 5. How It Works

The core insight (established in `spec/02-proven-constraints.md`): Pi's conversation is an **append-only tree** that an agent *cannot* structurally mutate from a tool, but the agent **can** drop persisted "view instructions" that the `context` event honors on every inference. A rewind is therefore not a deletion — it is a **permanent soft-delete**: a persisted marker that hides a span from every future inference, while the originals remain on disk and are visible in `/tree`.

### Data flow on a rewind

```
agent calls mulligan_rewind(note, granularity)
   │
   ├─ appendEntry("mulligan:rewind", {spec, ...})         ← control state (NOT sent to the model)
   ├─ sendMessage({customType:"mulligan:note", content})   ← the note (IN context)
   └─ tool returns a short confirmation
        │
        ↓  (normal agent loop continues)
next inference → context handler
   ├─ read mulligan:* markers from the session entries
   ├─ rewrite the message copy: hide the span / substitute the shrink
   └─ return { messages: transformed }
        │
        ↓
model sees [kept prefix] + [your note] + [confirmation], resumes — no resume code needed
```

**Shrink** = view substitution: `appendEntry("mulligan:shrink", {target, replacement})`; the context handler substitutes content in place (preserving `role` / `toolCallId` / `toolName` / `isError` so the tool-call/result pairing invariant holds).

### Ride-along nudges (zero extra model requests)

1. **Bloated-result reminder** (`spec/07-preventive-and-nudges.md` §1) — a `tool_result` hook appends a single-line reminder to any result exceeding the byte threshold (`nudges.bloatThresholdBytes`, default 8192). The reminder is appended, not replacing (the agent may still need the data) and costs ~20 tokens, once, only when the threshold is crossed.
2. **Per-turn drift nudge** (`spec/07-preventive-and-nudges.md` §2) — at `turn_end` Mulligan records the token delta; on the *next* inference it injects a single-line annotation when the delta exceeded `nudges.driftThresholdTokens` (default 3000). The `mulligan:nudge` annotation is **never persisted**.

Both nudges ride inferences that were already happening — they add **no model requests**.

### `/tree` is the audit trail

Every rewind, shrink, and checkpoint is a persisted entry — the human can inspect the full un-filtered history (including every hidden span) via Pi's native `/tree`. Mulligan adds no human-facing command of its own (D8 — redundant with `/tree` / `/compact` / `/fork`).

See `spec/SPEC.md` §1, §4 and `spec/06-context-filter.md` for the full architecture.

---

## 6. Guarantees

1. **Soft-delete / audit trail.** Hidden content is **never lost** — it stays in the session JSONL on disk and is visible in Pi's native `/tree`.
2. **Fail-open.** Any internal error degrades to a logged no-op, never a broken agent turn. Every tool and handler is try/catch-wrapped.
3. **Zero-config + zero extra requests.** The extension works out of the box with all defaults. The nudges ride inferences that were already happening — they add no model requests.

---

## 7. Known Limitations

Mulligan is deliberately minimal. These are things it deliberately does **not** do in v1.

- **Compaction leak (`spec/08-edge-cases.md` E7).** Pi's auto-compaction may summarize a span that included a Mulligan-hidden message, producing a transient "leak" via the summary until the next compaction settles. v1 accepts this as bounded and transient — and Mulligan *reducing* context makes compaction fire later and over less-important content.
- **No marker garbage-collection (`spec/08-edge-cases.md` E15).** v1 does no marker GC — markers persist intentionally (they are the audit trail). `rewind.maxDepth=5` bounds simultaneous *active* rewind markers; the only cost is disk growth (markers are control state, not in context).
- **Nudges are advisory (`spec/08-edge-cases.md` E18).** They never force behavior; cost is ~25–40 tokens per nudge when it fires.
- **Per-tool bloat thresholds are FUTURE** (v1 ships a single global `nudges.bloatThresholdBytes=8192`). Per-tool thresholds (e.g. a higher ceiling for `read`) are a documented post-v1 refinement, not in v1.
- **No undo / un-rewind (`spec/SPEC.md` §9 D6).** Agent-initiated rewinds and shrinks persist across reload and `/resume`. A human who wants to explore hidden content uses `/tree`.
- **Soft retry only, no replay (`spec/SPEC.md` §9 D1).** Hidden tool calls' **side effects persist on disk** (files written, commands run); replaying them would compound those effects. The mutation warning and the note's `true_current_state` / auto-appended file ledger are the safeguards.

---

## 8. License

**MIT** (per `spec/SPEC.md`).

---

## Further reading

The `spec/` directory is the deep-detail reference. Start with `spec/SPEC.md` (the master document: PRD + architecture + §9 decision log D1–D8), then the companion sections:

- `spec/05-tools.md` — the four tools' full specification.
- `spec/06-context-filter.md` — the context-event view transform.
- `spec/07-preventive-and-nudges.md` — the two zero-extra-request nudges.
- `spec/08-edge-cases.md` — edge cases (E7 compaction leak, E14 master switch, E15 markers).
- `spec/09-configuration.md` — the configuration surface + coercion rules.

---

## Changelog

- **BUG-001** (critical · inert config) — wired a disk-reading `settingsLoader` and call `setConfig` at factory load and on every `session_start`; every documented knob is now honored.
- **BUG-002** (critical · stacked `last_tool_call_group` rewinds re-exposed hidden content) — each rewind now pins its target entry ids at creation; the filter resolves against the pin, so a later rewind can no longer retarget an earlier one.
- **BUG-003** (major · `checkpoint` rewind could hide the protected latest user message) — `latest:user` is now enforced (`protectedOk` + a tool-layer guard); a checkpoint rewind that would cross it is refused.
- **BUG-004** (minor · marker/label reads scanned every branch) — marker/checkpoint reads now use the current branch (`getBranch()`) instead of all branches (`getEntries()`).
- **BUG-005** (minor · `mulligan_rewind` reported success when the marker failed to persist) — the rewind tool now null-checks the persisted marker id and refuses (with no stray note) when persist failed.
- **BUG-006** (minor · `/reload` did not re-read config) — `session_start` (which fires on `/reload`) now re-reads settings and calls `setConfig`.
- **BUG-007** (minor · smoke harness left core scenarios SOFT) — the smoke harness now makes the bloat-hit, drift-nudge, and seed-hiding assertions GATING, and marks the unimplemented `F-retrycap`/`F-abortfraction` scenarios out-of-scope.
- **BUG-008** (cosmetic · `mulligan_audit` Suggestion was wrong for non-toolResult top messages) — the `mulligan_audit` Suggestion line is now role-aware.
