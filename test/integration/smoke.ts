/**
 * smoke.ts — Mulligan integration smoke harness (Pi HELPER extension, loaded SECOND).
 *
 * Loaded via `pi -e ./src/index.ts -e ./test/integration/smoke.ts …`. Because context/tool_result/turn_end
 * handlers CHAIN in `-e` flag order (Pi runner.js emitContext), the smoke helper runs AFTER Mulligan's filter
 * → it observes the POST-filter messages. It is an OBSERVER ONLY: its `context` handler returns VOID so it
 * never overrides Mulligan's real filter (GOTCHA #1).
 *
 * Responsibilities (spec/10 §2; the PRP "What → Artifact 1"):
 *   (1) Truncate the smoke JSONL log once at factory time; provide a never-throwing smokeLog() helper.
 *   (2) session_start → log sessionFile (so the orchestrator can find the session JSONL) + inject a msg-canary.
 *   (3) context handler (OBSERVER → void) → log {count, msgCanaryPresent, resultCanaryPresent, notePresent,
 *       hasRewindMarker, shrunkInContext, hasNudge} every fire (the spec/10 §2.2 observable set).
 *   (4) registerTool mulligan_smoke_big → returns a large canary result. NOTE: bloatReminderHandler SKIPS
 *       mulligan_* tools (src/nudges.ts GOTCHA #3), so this tool never triggers the bloat reminder regardless
 *       of size; its role is as a shrink target (RESULT_CANARY). New defaults: global bloatThresholdBytes=16384,
 *       bloatThresholdBytesByTool={read:24576}.
 *   (5) registerCommand /mulligan_smoke <scenario> → the DETERMINISTIC driver. Dispatches per scenario using
 *       the REAL tool factories (makeRewindTool/makeShrinkTool/makeCheckpointTool — shared module, same
 *       process) and triggers an observing inference via pi.sendUserMessage("ok",{deliverAs:"followUp"}) so
 *       the filter's effect is observable (GOTCHA #2).
 *   (6) OPTIONAL: enable Mulligan's OWN corroborating filter.fire log (wrapped in try/catch; OFF-by-default).
 *
 * Anti-patterns avoided (PRP "Anti-Patterns to Avoid"):
 *   - context handler returns VOID (never {messages}) — would override Mulligan's filter.
 *   - imports the REAL tools/wrappers (never reimplements them) — tests Mulligan, not a copy.
 *   - never throws out of the factory/handlers (mirror the spike's try/catch discipline).
 */
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, writeFileSync } from "node:fs";
// REAL mulligan tools — shared module, same process (research §6). .js extensions (ESM Bundler — GOTCHA #6).
// NOTE: Pi loads extensions via jiti, which gives EACH extension its OWN module cache. So config.ts/log.ts
// imported here are SEPARATE instances from the ones Mulligan uses → setConfig/setLogFile here do NOT affect
// Mulligan's behavior. The smoke helper therefore does NOT attempt to configure Mulligan; it observes via its
// OWN context handler + drives scenarios via the REAL tool factories (makeRewindTool etc. are stateless
// factory closures that capture `pi`, so they work correctly regardless of module cache identity).
import { makeRewindTool } from "../../src/tools/rewind.js";
import { makeShrinkTool } from "../../src/tools/shrink.js";
import { makeCheckpointTool } from "../../src/tools/checkpoint.js";

// ── Log destination (per-scenario isolation via env; orchestrator sets MULLIGAN_SMOKE_LOG) ───────────
const SMOKE_LOG = process.env.MULLIGAN_SMOKE_LOG ?? "/tmp/mulligan-smoke.log";

// Canary marker strings (GOTCHA #3 — scenario-specific observables; never one fixed canary).
const MSG_CANARY = "MULLIGAN-SMOKE-MSG-CANARY"; // injected at session_start; target of last_turn rewind
const RESULT_CANARY = "MULLIGAN-SMOKE-RESULT-CANARY"; // in mulligan_smoke_big; target of shrink
const SHRUNK_MARKER = "MULLIGAN-SMOKE-SHRUNK"; // the shrink replacement string
const BLOAT_CANARY = "MULLIGAN-SMOKE-BLOAT-CANARY"; // canary for smoke_read_big (non-mulligan tool — bloatReminderHandler does NOT skip it)

// SEED canaries for the deterministic HIDING assertions (P1.M3.T2.S1). The session-start MSG_CANARY precedes the first
// user message, so a last_turn rewind (which hides content AFTER the last user message) can NEVER hide it. Instead, a
// SEED model turn (a prepended `-p "Reply with exactly: <SEED>"`) commits a real assistant message AFTER the first user
// message — which the rewind CAN pin + hide. SEED_HIDDEN is the content asserted ABSENT on the observing inference;
// SEED_ANCHOR is the F-checkpoint anchor asserted PRESENT (the checkpoint must keep its anchor, not over-hide).
const SEED_ANCHOR = "MULLIGAN-SMOKE-SEED-ANCHOR";
const SEED_HIDDEN = "MULLIGAN-SMOKE-SEED-HIDDEN";

// Which logical scenario is running (set+normalized in driveScenario; read by the context handler so its scenario-scoped
// hiding assertions fire on the right post-rewind fire). Module-local mutable — never exported.
let currentScenario = "";

// A canonical 4-field note for the REAL rewind tool (validated by validateNote — all fields non-empty).
const SMOKE_NOTE = {
  what_happened: "smoke test rewind setup",
  avoid: "n/a — deterministic harness",
  true_current_state: "smoke scenario in progress",
  next: "continue the smoke scenario",
};

/**
 * smokeLog — append one JSONL line {ts, test, status, detail} to SMOKE_LOG AND a short line to stderr (so
 * `pi -p` captures it on stderr). NEVER throws (logging must not crash the harness — mirrors the spike's log()).
 * Exported (module-local use only; not part of the public surface).
 */
function smokeLog(test: string, status: "pass" | "fail" | "info", detail: unknown): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), test, status, detail });
  try {
    appendFileSync(SMOKE_LOG, line + "\n");
  } catch {
    /* never crash on a bad log path */
  }
  try {
    process.stderr.write(`[mulligan-smoke] ${status.toUpperCase()} ${test}: ${line}\n`);
  } catch {
    /* never crash */
  }
}

/**
 * Helper: pull the first text block out of an AgentToolResult's content (content is (TextContent | ImageContent)[]).
 */
function resultText(content: { type: string; text?: string }[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const first = content[0];
  return first && typeof first.text === "string" ? first.text : "";
}

/**
 * rewindNow — call the REAL makeRewindTool(pi).execute() with a synthetic toolCallId (research §6). The
 * toolCallId becomes excludeToolCallId on the marker. Returns the result text (success vs refusal is read
 * from the text — the rewind tool encodes refusals as "Mulligan: refused — …"). NEVER throws.
 */
async function rewindNow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolCallId: string,
  granularity: "last_tool_call_group" | "last_turn" | "checkpoint",
  opts?: { to_previous_prompt?: boolean; checkpoint?: string },
): Promise<{ text: string }> {
  try {
    const tool = makeRewindTool(pi); // shared module → REAL tool bound to the same pi
    const result = await tool.execute(
      toolCallId,
      {
        note: SMOKE_NOTE,
        granularity,
        to_previous_prompt: opts?.to_previous_prompt,
        checkpoint: opts?.checkpoint,
      },
      undefined,
      undefined,
      ctx,
    );
    const text = resultText(result.content as unknown as { type: string; text?: string }[]);
    smokeLog("tool.rewind", "info", { toolCallId, granularity, text: text.slice(0, 120) });
    return { text };
  } catch (e) {
    smokeLog("tool.rewind", "fail", { toolCallId, granularity, error: String(e) });
    return { text: String(e) };
  }
}

// ── driveScenario: the per-scenario deterministic driver (spec/10 §2.1) ───────────────────────

/**
 * bigResult — the canary string (RESULT_CANARY + padding) used by mulligan_smoke_big + the F-shrink-preventive
 * deterministic path. NOTE: mulligan_smoke_big is a mulligan_* tool → bloatReminderHandler SKIPS it
 * (src/nudges.ts GOTCHA #3), so size never triggers the reminder. Defaults now: global 16384; per-tool
 * read 24576 (bash uses the 16 KB global). The canary's job is being a shrink target, not crossing a bloat threshold.
 */
function bigResult(): string {
  // Size is moot for bloat (mulligan_* skip); the value is intentionally unchanged — a shrink-target canary.
  return RESULT_CANARY + " " + "x".repeat(9000);
}

/**
 * driveScenario — dispatch on the scenario name. Each recipe uses the REAL tools/wrappers to set up the
 * scenario's persisted state (markers, checkpoints, config). The OBSERVING INFERENCE (the model turn that
 * fires `context` so the filter's effect is observable) is triggered by the ORCHESTRATOR, which passes a
 * second `-p "continue"` prompt after the `/mulligan_smoke` command. (Print mode does NOT drain a followUp
 * queued from inside a `/cmd` dispatch — verified: the command path returns before the agent drain loop, and
 * `pi.sendUserMessage` is fire-and-forget. A second `-p` prompt reliably triggers the turn + persists the
 * session JSONL.) Each recipe is wrapped in try/catch so a scenario failure logs a fail line and never
 * crashes the command.
 *
 * CANARY STRATEGY (GOTCHA #3): a tool RESULT canary only exists if the model called the tool (we cannot
 * synthesize a toolResult — ReadonlySessionManager has no mutator). So F-rewind-core's deterministic path
 * uses granularity:"last_turn" against the session_start MSG-canary (which IS in the last turn). The context
 * handler logs BOTH canaries so each scenario asserts on the right one.
 */
async function driveScenario(pi: ExtensionAPI, ctx: ExtensionCommandContext, scenario: string): Promise<void> {
  smokeLog("scenario.start", "info", { scenario });
  try {
    // Normalize so the context-handler assertion fires during BOTH F-checkpoint phases (set + rewind).
    currentScenario = scenario.startsWith("F-checkpoint") ? "F-checkpoint" : scenario;
    switch (scenario) {
      case "F-rewind-core": {
        // Deterministic path: create a last_turn rewind marker + note. The CANARY-DROP observation (context.fire
        // count decreasing) is inherently model-driven: a last_turn rewind's target is relative to the CURRENT
        // last user message, which moves with each new prompt, so a canary injected before the observing prompt
        // is no longer "after the last user" by the time the next inference fires. The deterministic assertions
        // here are: (a) the rewind marker + note PERSIST (JSONL invariants), (b) context.fire shows
        // hasRewindMarker:true + notePresent:true (the filter sees the persisted state). The authoritative
        // canary-drop proof is the MODEL-DRIVEN path (documented in scenarios.md): the agent calls
        // mulligan_rewind mid-turn after a bloated tool call, and the next inference's filtered view drops it.
        await rewindNow(pi, ctx, "smoke-rewind-1", "last_turn");
        break;
      }
      case "F-shrink-persist": {
        // Deterministic path: shrink by_content_includes against the session_start MSG-canary (a custom_message
        // in context). The shrink marker PERSISTS (JSONL invariant); the substitution appears in the filtered
        // view (shrunkInContext) on the observing inference. Asserts the original stays on disk (shrink is a
        // view-substitution, NOT a JSONL rewrite). The model-driven path (mulligan_smoke_big result canary) is
        // documented in scenarios.md (GOTCHA #3).
        try {
          const tool = makeShrinkTool(pi);
          const result = await tool.execute(
            "smoke-shrink-1",
            { target: { by_content_includes: MSG_CANARY }, replacement: SHRUNK_MARKER, reason: "smoke test" },
            undefined,
            undefined,
            ctx,
          );
          const text = resultText(result.content as unknown as { type: string; text?: string }[]);
          smokeLog("tool.shrink", "info", { text: text.slice(0, 120) });
        } catch (e) {
          smokeLog("tool.shrink", "fail", { error: String(e) });
        }
        break;
      }
      case "F-shrink-preventive": {
        // The bloat reminder fires on the tool_result EVENT when a NON-mulligan_* result exceeds its resolved
        // threshold (global bloatThresholdBytes=8192). smoke_read_big (registered below) is a NON-mulligan_*
        // tool whose result exceeds the threshold → bloatReminderHandler WILL fire on it when the model calls it.
        // The orchestrator drives a second prompt that makes the model call smoke_read_big, producing a real
        // tool_result event → bloatReminderHandler records the bloat hit → turnEndMetricHandler persists
        // bloatHit:true in the turn-metric. The assertion in run-smoke.mjs HARD-checks this from the session JSONL.
        try {
          smokeLog("tool.smoke_big", "info", { note: "smoke_read_big registered; orchestrator prompt drives the model call to real tool_result to bloatHit:true" });
        } catch (e) {
          smokeLog("tool.smoke_big", "fail", { error: String(e) });
        }
        break;
      }
      case "F-nudge-drift": {
        // Deterministic two-turn drift: the orchestrator runs in a scoped tmp cwd whose .pi/settings.json sets
        // driftThresholdTokens=1 (honored by Mulligan session_start — M1); prompts drive baseline (turn 1) ->
        // growth > 1 token (turn 2) -> observing fire hasNudge:true (turn 3); nudge is ephemeral (ZERO on disk).
        smokeLog("drift.harness", "info", { note: "deterministic two-turn drift: orchestrator runs in a scoped tmp cwd whose .pi/settings.json sets driftThresholdTokens=1 (honored by Mulligan session_start — M1); prompts drive baseline (turn 1) -> growth > 1 token (turn 2) -> observing fire hasNudge:true (turn 3); nudge is ephemeral (ZERO on disk)" });
        break;
      }
      case "F-protected": {
        // Rewind last_turn + to_previous_prompt when only the /mulligan_smoke prompt exists → the BUG-006
        // protected-refusal check (rewind.ts:step-5b) refuses BEFORE persisting (crossing the first:user
        // boundary). The tool's refusal TEXT + ZERO persisted mulligan:rewind markers are the assertions.
        await rewindNow(pi, ctx, "smoke-prot-1", "last_turn", { to_previous_prompt: true });
        // No followUp: pure pre-persist refusal; the assertions are the refusal text + zero markers in assertProtected.
        break;
      }
      case "F-maxdepth": {
        // Create 5 rewinds (each a distinct toolCallId), then a 6th → the 6th hits maxDepth(5) and refuses.
        for (let i = 1; i <= 5; i++) {
          await rewindNow(pi, ctx, `smoke-max-${i}`, "last_tool_call_group");
        }
        const sixth = await rewindNow(pi, ctx, "smoke-max-6", "last_tool_call_group");
        smokeLog("maxdepth.sixth", "info", { text: sixth.text.slice(0, 120) });
        break;
      }
      case "F-checkpoint": {
        // Set a checkpoint, then rewind to it. The checkpoint is a label entry; the rewind hides back to it.
        // The orchestrator's second `-p` triggers the observing inference.
        try {
          const cpTool = makeCheckpointTool(pi);
          const cpRes = await cpTool.execute("smoke-cp-1", { name: "alpha" }, undefined, undefined, ctx);
          const cpText = resultText(cpRes.content as unknown as { type: string; text?: string }[]);
          smokeLog("tool.checkpoint", "info", { text: cpText.slice(0, 120) });
        } catch (e) {
          smokeLog("tool.checkpoint", "fail", { error: String(e) });
        }
        await rewindNow(pi, ctx, "smoke-cp-rw-1", "checkpoint", { checkpoint: "alpha" });
        break;
      }
      case "F-checkpoint-set": {
        // Phase 1 of the F-checkpoint HIDING flow (run-smoke.mjs drives a SEED_ANCHOR model turn BEFORE this command):
        // set the checkpoint ONLY. The SEED_ANCHOR assistant (committed by the preceding prompt) is the stable entry
        // setCheckpoint labels — so it SUCCEEDS (fixes the baseline breakage where a fresh 2-prompt session has no
        // stable entry). A SEED_HIDDEN model turn runs AFTER this, then F-checkpoint-rewind hides it (K>0).
        try {
          const cpTool = makeCheckpointTool(pi);
          const cpRes = await cpTool.execute("smoke-cp-1", { name: "alpha" }, undefined, undefined, ctx);
          const cpText = resultText(cpRes.content as unknown as { type: string; text?: string }[]);
          smokeLog("tool.checkpoint", "info", { phase: "set", text: cpText.slice(0, 120) });
        } catch (e) {
          smokeLog("tool.checkpoint", "fail", { phase: "set", error: String(e) });
        }
        break;
      }
      case "F-checkpoint-rewind": {
        // Phase 2 of the F-checkpoint HIDING flow (a SEED_HIDDEN model turn has run BETWEEN set and this): rewind to
        // 'alpha' → hides the post-checkpoint SEED_HIDDEN turn (K>0). The orchestrator's final `-p "Reply OK"` is the
        // observing inference on which F-checkpoint.hiding is asserted.
        await rewindNow(pi, ctx, "smoke-cp-rw-1", "checkpoint", { checkpoint: "alpha" });
        break;
      }
      case "F-failopen": {
        // Append a MALFORMED mulligan:rewind marker (missing note/ledger/etc) so the filter's transform
        // path is exercised with bad data. Mulligan's filter is fail-open by construction (filter.ts wraps
        // the whole body in try/catch → pass-through). Assert: the turn SURVIVES (the orchestrator's second
        // `-p` still fires context + exits 0). If no clean throw surfaces, this still verifies pass-through
        // (GOTCHA #9 — the handler-never-throws unit test in filter.test.ts is the authoritative proof).
        try {
          pi.appendEntry("mulligan:rewind", {
            schema: "pi-mulligan",
            v: 1,
            kind: "rewind",
            granularity: "last_tool_call_group",
            // intentionally missing: id, seq, ts, note, ledger, options, excludeToolCallId
          });
          smokeLog("failopen.marker", "info", { appended: "malformed" });
        } catch (e) {
          smokeLog("failopen.marker", "fail", { error: String(e) });
        }
        break;
      }
      case "F-reload": {
        // Run 1 (this process): create a rewind marker. Run 2 (a SECOND pi process with the SAME
        // --session-id) reopens the session and the orchestrator's second `-p` triggers a turn → the
        // orchestrator asserts the marker survived reload (hasRewindMarker:true + canary hidden). The
        // orchestrator runs both; this body only does run 1.
        await rewindNow(pi, ctx, "smoke-reload-1", "last_turn");
        break;
      }
      default: {
        smokeLog("scenario.unknown", "fail", { scenario, reason: "unknown scenario name" });
      }
    }
    smokeLog("scenario.done", "info", { scenario });
  } catch (e) {
    smokeLog("scenario.crash", "fail", { scenario, error: String(e) });
  }
}

// ── The factory (Pi helper extension — observer + /mulligan_smoke driver) ─────────────────────

/**
 * Default-export factory. Loaded as the SECOND `-e`. Sync (no async work at load time). Never throws at the
 * top level (the spike's discipline): each handler is independently try/catch-guarded.
 */
export default function (pi: ExtensionAPI): void {
  // (0) Truncate the smoke log ONCE at factory time (try/catch — never crash on a bad path).
  try {
    writeFileSync(SMOKE_LOG, "# mulligan smoke " + new Date().toISOString() + "\n");
  } catch {
    /* never crash */
  }

  // NOTE: Mulligan's OWN corroborating log (GOTCHA #7) CANNOT be enabled from here — Pi's jiti loader gives
  // each extension a separate module cache, so setLogFile() here would mutate a DIFFERENT log.ts instance
  // than the one Mulligan uses. The smoke helper's OWN log (SMOKE_LOG) is the sole assertion source.

  // (2) session_start → log the sessionFile (so the orchestrator can find the JSONL for §2.3 assertions) +
  //     inject the msg-canary CustomMessage (the target for last_turn rewind / content-include shrink).
  pi.on("session_start", (_event, ctx) => {
    try {
      smokeLog("session.start", "info", {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        leafId: ctx.sessionManager.getLeafId(),
      });
    } catch (e) {
      smokeLog("session.start", "fail", { error: String(e) });
    }
    // inject the message canary (in LLM context; a rewind target for observing-context scenarios)
    try {
      pi.sendMessage({ customType: "mulligan_smoke_canary", content: MSG_CANARY, display: false });
      smokeLog("setup.canary", "info", { ok: true });
    } catch (e) {
      smokeLog("setup.canary", "fail", { error: String(e) });
    }
  });

  // (3) context handler — THE OBSERVER (MUST return void; GOTCHA #1). Logs the spec/10 §2.2 observable set
  //     on every fire. Because smoke loads SECOND, event.messages is the POST-filter set (Mulligan already
  //     ran). Returning void = pass-through (do NOT override Mulligan's filtered set).
  pi.on("context", (event, ctx) => {
    try {
      const msgs = event.messages as unknown as Array<Record<string, unknown>>;
      const has = (s: string) => msgs.some((m) => JSON.stringify(m).includes(s));
      let entries: unknown[] = [];
      try {
        entries = ctx.sessionManager.getEntries() as unknown[];
      } catch {
        entries = [];
      }
      const hasRewindMarker = entries.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as Record<string, unknown>).type === "custom" &&
          (e as Record<string, unknown>).customType === "mulligan:rewind",
      );
      // ── SEED-canary hiding detection (P1.M3.T2.S1). Role-gated: the user PROMPT also contains the canary text, so
      //    gate on role:"assistant" to detect the seed REPLY specifically (GOTCHA #5). smoke loads SECOND → these read
      //    the POST-filter view, so seed-absence = seed-hidden-by-the-filter.
      const seedAnchorInAssistant = msgs.some(
        (m) => m?.role === "assistant" && JSON.stringify(m).includes(SEED_ANCHOR),
      );
      const seedHiddenInAssistant = msgs.some(
        (m) => m?.role === "assistant" && JSON.stringify(m).includes(SEED_HIDDEN),
      );
      smokeLog("context.fire", "info", {
        count: msgs.length,
        msgCanaryPresent: has(MSG_CANARY),
        resultCanaryPresent: has(RESULT_CANARY),
        notePresent: msgs.some((m) => m?.customType === "mulligan:note"),
        hasRewindMarker,
        shrunkInContext: has(SHRUNK_MARKER),
        hasNudge: msgs.some((m) => m?.customType === "mulligan:nudge"),
        seedAnchorInAssistant,
        seedHiddenInAssistant,
      });
      // ── Scenario-scoped HARD hiding assertions (emitted on the post-rewind fire only). These are READ BACK by
      //    run-smoke.mjs assertRewindCore/assertCheckpoint and converted to assert() — logging alone does not fail a
      //    scenario (GOTCHA #7). Two-signal guard: the tool.rewind K-text (read by the asserter) proves the seed
      //    existed+was pinned; seed-absence here proves it is hidden. If pinning regressed (BUG-001/002) the seed
      //    reply LEAKS BACK → seedHiddenInAssistant===true → FAIL.
      if (currentScenario === "F-rewind-core" && hasRewindMarker) {
        smokeLog("F-rewind-core.hiding", seedHiddenInAssistant ? "fail" : "pass", {
          seedHiddenInAssistant,
          note: seedHiddenInAssistant ? "LEAKED BACK (BUG-001/002 regression: pinned hide lost)" : "seed reply hidden on observing inference",
        });
      }
      if (currentScenario === "F-checkpoint" && hasRewindMarker) {
        // The checkpoint must HIDE the post-checkpoint SEED_HIDDEN turn AND KEEP its SEED_ANCHOR (not over-hide).
        const cpPass = !seedHiddenInAssistant && seedAnchorInAssistant;
        smokeLog("F-checkpoint.hiding", cpPass ? "pass" : "fail", {
          seedHiddenInAssistant,
          seedAnchorInAssistant,
          note: cpPass
            ? "post-checkpoint seed hidden; anchor survives"
            : seedHiddenInAssistant
              ? "post-checkpoint seed LEAKED BACK (BUG-003/001 regression)"
              : "checkpoint anchor MISSING (over-hid / checkpoint not set)",
        });
      }
    } catch (e) {
      smokeLog("context.fire", "fail", { error: String(e) });
    }
    // return void → pass-through; do NOT override Mulligan's filter (GOTCHA #1).
  });

  // (4) registerTool mulligan_smoke_big — returns a large canary result. NOTE: bloatReminderHandler SKIPS
  //     mulligan_* tools (src/nudges.ts GOTCHA #3), so this tool NEVER triggers the bloat reminder regardless
  //     of size; its role is as a shrink target (RESULT_CANARY observable). New defaults: global 16384,
  //     per-tool read 24576 (bash uses the global).
  pi.registerTool({
    name: "mulligan_smoke_big",
    label: "Big Result",
    description: "SMOKE TEST TOOL. Returns a large canary result (bloat reminder is skipped for mulligan_* tools). Call when asked.",
    parameters: Type.Object({}),
    async execute() {
      const big = bigResult();
      return { content: [{ type: "text" as const, text: big }], details: { len: big.length } };
    },
  });

  // (4b) registerTool smoke_read_big — a NON-mulligan_* tool whose result exceeds the resolved bloat threshold
  //      (config.ts default bloatThresholdBytes=8192). Because its name does NOT start with mulligan_,
  //      bloatReminderHandler does NOT skip it — a real tool_result event fires the reminder + records the
  //      bloat hit. The orchestrator's second prompt makes the model call this tool (the only path to a real
  //      tool_result event — see scenarios.md). This closes BUG-007: bloatHit:true is now HARD-asserted.
  pi.registerTool({
    name: "smoke_read_big",
    label: "Smoke Read Big",
    description: "SMOKE TEST TOOL. Returns a large result (>8KB) to exercise the bloat reminder. Call when asked.",
    parameters: Type.Object({}),
    async execute() {
      const big = BLOAT_CANARY + " " + "x".repeat(10000);
      return { content: [{ type: "text" as const, text: big }], details: { len: big.length } };
    },
  });

  // (5) registerCommand /mulligan_smoke <scenario> — THE DETERMINISTIC DRIVER (spec/10 §2.2). Dispatches
  //     on the scenario name; each recipe uses the REAL tools + followUp (GOTCHA #2). The command handler's
  //     ctx is ExtensionCommandContext (has sessionManager) — passed to the REAL tool's execute().
  pi.registerCommand("mulligan_smoke", {
    description: "drive a mulligan smoke scenario deterministically",
    handler: async (args, ctx) => {
      const scenario = (args ?? "").trim();
      await driveScenario(pi, ctx, scenario);
    },
  });
}