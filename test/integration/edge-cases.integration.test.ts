/**
 * edge-cases.integration.test.ts — real-pi integration for load-bearing edges
 * E20 (JSONL entry ordering) and E11 (marker persists across --session-id reopen).
 *
 * Gated: `describe.skipIf(!process.env.RUN_INTEGRATION)` so the default fast suite
 * is unaffected. The `beforeAll` skips gracefully if `pi` is absent or no model is
 * configured.
 *
 * Boundary with P1.M5.T3: this file proves the reliably session-JSONL-provable
 * subset (E20 entry TYPE+ORDER; E11 marker PERSISTENCE). The filter VIEW behavior
 * (the actual hide/re-hide) is proven by T3's F-rewind-core/F-reload harnesses.
 * We assert on STRUCTURAL facts (entry types/order/persistence), not prose.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Gated: only runs when RUN_INTEGRATION=1
describe.skipIf(!process.env.RUN_INTEGRATION)(
  "edge-case integration (real pi -p)",
  () => {
    let extPath: string;
    let tmpDir: string;
    let piAvailable = true;

    beforeAll(() => {
      // Sanity-check: pi must be on PATH
      try {
        const ver = execFileSync("pi", ["--version"], {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        console.log(`[integration] pi --version: ${ver.trim()}`);
      } catch {
        piAvailable = false;
        console.warn("[integration] pi not found on PATH — skipping");
      }

      // Resolve extension path (absolute)
      extPath = join(process.cwd(), "src/index.ts");
      if (!existsSync(extPath)) {
        piAvailable = false;
        console.warn(`[integration] extension not found at ${extPath} — skipping`);
      }

      // Create a temp session dir
      tmpDir = mkdtempSync(join(tmpdir(), "mulligan-integration-"));
    });

    /**
     * Helper: run pi with the mulligan extension and parse the session JSONL.
     * Returns the parsed JSONL entries array.
     */
    function runPi(
      sessionId: string,
      prompt: string,
      timeout = 60000,
    ): unknown[] {
      if (!piAvailable) return [];

      try {
        execFileSync(
          "pi",
          [
            "-ne", // no editor
            "-e", extPath,
            "--session-id", sessionId,
            "--session-dir", tmpDir,
            "-p", prompt,
          ],
          {
            encoding: "utf8",
            timeout,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch (err: any) {
        // pi may exit non-zero for various reasons (model unavailable, etc.)
        console.warn(`[integration] pi exit code: ${err.status}, signal: ${err.signal}`);
      }

      // Find the session JSONL
      const files = readdirSync(tmpDir);
      const jsonlFile = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
      if (!jsonlFile) {
        console.warn(`[integration] no JSONL found for session ${sessionId}`);
        return [];
      }

      const content = readFileSync(join(tmpDir, jsonlFile), "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    // ══════════════════════════════════════════════════════════════════════
    // E20: JSONL entry ordering — mulligan:rewind custom BEFORE mulligan:note
    // custom_message, both AFTER the mulligan_rewind toolResult
    // ══════════════════════════════════════════════════════════════════════

    describe("E20 — appendEntry→sendMessage ordering in session JSONL (spec/08 E20)", () => {
      it("mulligan:rewind custom entry appears BEFORE mulligan:note custom_message entry in the JSONL, and both after the toolResult", () => {
        if (!piAvailable) {
          console.warn("[integration] skipping — pi unavailable");
          return;
        }

        const sessionId = randomUUID();
        // First, have the model do something (run a read command), then rewind it.
        // This gives it a real tool group to target.
        const prompt = [
          "Step 1: Run `bash -c 'echo hello'` to verify the shell works.",
          "Step 2: After the bash command completes, IMMEDIATELY call mulligan_rewind with:",
          '  granularity: "last_tool_call_group"',
          "  note:",
          "    what_happened: 'Integration test for E20 ordering'",
          "    avoid: 'N/A for this test'",
          "    true_current_state: 'Bash command ran successfully'",
          "    next: 'E20 ordering test complete'",
          "Do both steps. Do NOT skip step 1 — the model needs a tool group to rewind.",
        ].join("\n");

        const entries = runPi(sessionId, prompt);

        // Find the mulligan_rewind toolResult, the mulligan:rewind custom entry,
        // and the mulligan:note custom_message entry
        let toolResultIdx = -1;
        let rewindCustomIdx = -1;
        let noteCustomMsgIdx = -1;

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i] as any;
          // Pi JSONL: toolResult entries have type="message" with message.role="toolResult"
          const msg = entry.message || {};
          if (
            entry.type === "message" &&
            msg.role === "toolResult" &&
            msg.toolName === "mulligan_rewind"
          ) {
            toolResultIdx = i;
          }
          // Look for the custom mulligan:rewind entry
          if (
            entry.type === "custom" &&
            entry.customType === "mulligan:rewind"
          ) {
            rewindCustomIdx = i;
          }
          // Look for the custom_message mulligan:note entry
          if (
            entry.type === "custom_message" &&
            entry.customType === "mulligan:note"
          ) {
            noteCustomMsgIdx = i;
          }
        }

        // Assert all three were found
        expect(
          toolResultIdx >= 0,
          "Expected a mulligan_rewind toolResult entry in session JSONL",
        ).toBe(true);
        expect(
          rewindCustomIdx >= 0,
          "Expected a mulligan:rewind custom entry in session JSONL",
        ).toBe(true);
        expect(
          noteCustomMsgIdx >= 0,
          "Expected a mulligan:note custom_message entry in session JSONL",
        ).toBe(true);

        // Assert ordering: rewind custom BEFORE note custom_message
        // (marker is appended during tool execution; note is sent after tool returns)
        expect(
          rewindCustomIdx < noteCustomMsgIdx,
          `Expected mulligan:rewind custom (idx=${rewindCustomIdx}) before mulligan:note custom_message (idx=${noteCustomMsgIdx})`,
        ).toBe(true);

        // Assert toolResult appears between marker and note
        // (tool calls appendEntry synchronously → marker lands before toolResult is recorded;
        //  then toolResult lands; then leaveNote → sendMessage → note lands after)
        expect(
          rewindCustomIdx < toolResultIdx,
          `Expected mulligan:rewind custom (idx=${rewindCustomIdx}) before toolResult (idx=${toolResultIdx})`,
        ).toBe(true);
        expect(
          noteCustomMsgIdx > toolResultIdx,
          `Expected mulligan:note custom_message (idx=${noteCustomMsgIdx}) after toolResult (idx=${toolResultIdx})`,
        ).toBe(true);
      });
    });

    // ══════════════════════════════════════════════════════════════════════
    // E11: Marker persists across --session-id reopen
    // ══════════════════════════════════════════════════════════════════════

    describe("E11 — rewind marker persists across --session-id reopen (spec/08 E11)", () => {
      it("a mulligan:rewind custom entry created in run 1 is STILL present after a run 2 that reopens with the same --session-id", () => {
        if (!piAvailable) {
          console.warn("[integration] skipping — pi unavailable");
          return;
        }

        const sessionId = randomUUID();
        const prompt = [
          "Step 1: Run `bash -c 'echo hello'` to verify the shell works.",
          "Step 2: After the bash command completes, IMMEDIATELY call mulligan_rewind with:",
          '  granularity: "last_tool_call_group"',
          "  note:",
          "    what_happened: 'E11 persistence test run 1'",
          "    avoid: 'N/A'",
          "    true_current_state: 'Bash ran ok'",
          "    next: 'Verify persistence'",
          "Do both steps. Do NOT skip step 1.",
        ].join("\n");

        // Run 1: create the rewind marker
        const entries1 = runPi(sessionId, prompt);

        // Assert run 1 has a mulligan:rewind custom entry
        const hasRewind1 = (entries1 as any[]).some(
          (e) => e.type === "custom" && e.customType === "mulligan:rewind",
        );
        expect(
          hasRewind1,
          "Run 1: expected a mulligan:rewind custom entry in session JSONL",
        ).toBe(true);

        // Run 2: reopen the SAME session with a simple prompt
        const entries2 = runPi(sessionId, "say ok");

        // Assert run 2 JSONL still has the mulligan:rewind custom entry
        // (markers are persisted entries → survive reload)
        const hasRewind2 = (entries2 as any[]).some(
          (e) => e.type === "custom" && e.customType === "mulligan:rewind",
        );
        expect(
          hasRewind2,
          "Run 2: expected the mulligan:rewind custom entry to STILL be present after session reopen",
        ).toBe(true);

        // NOTE: the filter re-hiding on the next inference is unit-definitive via
        // readMarkers + contextHandler (tested in edge-cases.test.ts E11). The
        // re-hide VIEW behavior end-to-end is owned by P1.M5.T3's F-reload harness.
      });
    });
  },
);
