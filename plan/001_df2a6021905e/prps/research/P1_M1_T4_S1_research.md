# Research — P1.M1.T4.S1 (SessionRuntime map + seq counter + baseline + lastFiltered cache)

## Authoritative contract (from work item, NOT the sibling oracle)
- `runtime(ctx|sessionId): SessionRuntime` — get-or-create; accepts EITHER a ctx-shaped object
  (exposing getSessionId()) OR a plain string sessionId (for unit tests). FUNCTION NAMED `runtime`.
- `nextSeq(rt): number` — takes the SessionRuntime OBJECT (not sessionId). Pre-increment; first marker → seq 1.
- `SessionRuntime = { sessionId, seq, tokenBaseline:number|null, lastTurnIndex:number|null,
  lastFiltered:AgentMessage[]|null, lastFilterTs:number|null }`. **NO `pendingBloatHits`.**
- Held in `Map<string, SessionRuntime>` keyed by sessionId. Reset/created on session_start (E11).
- NEVER cache a sessionManager handle across turns (spec/02 C12) — only primitive values + the lastFiltered snapshot.
- IMPLICIT TDD: test/runtime.test.ts — get-or-create idempotent per session; seq strictly increasing;
  distinct sessions independent.

## Consumers (downstream tasks — this task only PROVIDES the API, does not wire it)
- markers.ts (P1.M3.T1): `const seq = nextSeq(runtime(ctx))` — stamps seq INTO each persisted marker
  (spec/04 §3) so the filter orders markers deterministically across reload.
- filter.ts (P1.M3.T2): writes `rt.lastFiltered = messages; rt.lastFilterTs = Date.now();` each context.fire.
- nudges.ts (P1.M3.T3): reads/writes `rt.tokenBaseline` (rolls forward at turn_end), `rt.lastTurnIndex`.
- tools/audit.ts (P1.M4.T4): reads `rt.lastFiltered` (the filtered view; D5 — never getContextUsage()).
- index.ts (P1.M7.T1, LATER): calls reset on session_start; clearAll on session_shutdown.

## ⚠️ CRITICAL DIVERGENCE — sibling oracle EVOLVED; CONTRACT wins
`/home/dustin/projects/pi-mulligan/src/runtime.ts` is a proven STRUCTURAL reference BUT has evolved:
- names the function `getRuntime(sessionId)` → THIS TASK names it `runtime(ctx|sessionId)`.
- `nextSeq(sessionId)` → THIS TASK uses `nextSeq(rt)` (takes the runtime object).
- has `pendingBloatHits: BloatHit[]` field + `BloatHit` type → THIS TASK OMITS both (nudges.ts scope, P1.M3.T3).
- spec/04 §8 minimal shape = `{sessionId, seq, tokenBaseline, lastTurnIndex}` → THIS TASK adds
  `lastFiltered` + `lastFilterTs` per the CONTRACT (spec/06 §7 audit cache).
=> Mine the sibling for the Map+freshRuntime+pre-increment+reset/clearAll PATTERN, NOT its evolved names/fields.

## Pi-free discipline (matches config.ts / log.ts)
- runtime.ts uses `import type { AgentMessage } from "@earendil-works/pi-coding-agent"` (type-only, erased
  by jiti/esbuild at runtime) so the module is unit-testable without Pi installed. Re-export the type so
  tests can reference it. NO log.ts import, NO config.ts import (foundational, like T2/T3).

## Verified toolchain
- vitest 1.6.1 (vitest.config.ts globals:true); tsc 5.9.3 (strict, noImplicitAny, types:[node,vitest/globals]).
- src/config.ts (T2) + src/log.ts (T3) already shipped; src/runtime.ts is currently `export {}` stub.
- index.ts still no-op (wiring is P1.M7.T1).

## Test design (test/runtime.test.ts) — per CONTRACT §5/§6
- beforeEach/afterEach: clearAll() (module Map is not auto-reset between tests — sibling GOTCHA #7).
- get-or-create idempotent: `runtime("s1") === runtime("s1")` (reference equality; mutable live object).
- fresh defaults: {sessionId, seq:0, tokenBaseline:null, lastTurnIndex:null, lastFiltered:null, lastFilterTs:null}.
- nextSeq strictly increasing: nextSeq(rt) → 1,2,3; persists on rt.seq.
- distinct sessions independent: nextSeq(runtime("A")) and nextSeq(runtime("B")) don't interfere.
- ctx-vs-string input parity: runtime({getSessionId:()=>"s1"}) === runtime("s1").
- in-place mutation contract: rt.lastFiltered = msgs; runtime("s1").lastFiltered === msgs (no defensive copy).
- resetRuntime(sessionId): next get is fresh (seq 0); stale references abandoned; no-op for unknown id.
- clearAll(): wipes all; no-op on empty.
- types: expectTypeOf<SessionRuntime>() field types; SessionRuntime has NO pendingBloatHits key.
