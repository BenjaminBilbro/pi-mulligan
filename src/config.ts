/**
 * Granularity — the unit a rewind targets.
 * - "last_tool_call_group": hide just the most recent tool interaction (surgical).
 * - "last_turn":            hide everything after the most recent user message (redo the turn).
 * - "checkpoint":           hide back to a named checkpoint set via mulligan_checkpoint.
 * Source: spec/04-data-model.md §2, spec/05-tools.md §1 (RewindParams).
 */
export type Granularity = "last_tool_call_group" | "last_turn" | "checkpoint";

/**
 * EstimateConfidence — honesty label reported alongside token estimates.
 * Token accounting is approximate; this conveys how approximate. Default "medium".
 * Source: spec/04-data-model.md §7, spec/09-configuration.md §2.
 */
export type EstimateConfidence = "low" | "medium" | "high";

/**
 * MulliganConfig — the shape of the `"mulligan"` configuration object.
 * Every option has a safe default; the extension works with zero configuration.
 * Unknown keys are ignored; type-mismatched values fall back to the default.
 * Source of truth: spec/09-configuration.md.
 */
export interface MulliganConfig {
  /** Master switch. false → the entire extension is a no-op. Default: true. */
  enabled: boolean;

  /** Rewind operation (`mulligan_rewind`) settings. */
  rewind: {
    /** Enable the rewind tool/feature. Default: true. */
    enabled: boolean;
    /** Message selectors that can never be rewound past. v1 known selectors: "first:user"
     *  and "latest:user". Unknown entries ignored. Default: ["first:user", "latest:user"]. */
    protectedRoles: string[];
    /** Max simultaneous active mulligan:rewind markers on a branch. Default: 5. */
    maxDepth: number;
    /** If true, rewind appends a warning when the hidden span contained write /
     *  side-effecting tool calls. Default: true. */
    requireMutationWarning: boolean;
  };

  /** Shrink operation (`mulligan_shrink`) settings. */
  shrink: {
    /** Enable the shrink tool/feature. Default: true. */
    enabled: boolean;
  };

  /** Preventive nudge settings. */
  nudges: {
    /** Annotate a tool_result when a single result exceeds bloatThresholdBytes. Default: true. */
    bloatReminder: boolean;
    /** Inject a one-line context drift nudge when a turn grew past driftThresholdTokens.
     *  Default: true. */
    perTurnDrift: boolean;
    /** Byte size threshold for the bloat reminder. Must be > 0. Default: 8192. */
    bloatThresholdBytes: number;
    /** Turn token-delta threshold for the drift nudge. Must be > 0. Default: 3000. */
    driftThresholdTokens: number;
  };

  /** Audit tool (`mulligan_audit`) settings. */
  audit: {
    /** Confidence label reported with token estimates. Default: "medium". */
    estimateConfidence: EstimateConfidence;
  };

  /** Structured logging settings. */
  log: {
    /** Path to an append-only JSONL debug log, or null to disable. Default: null (off). */
    file: string | null;
  };
}

/**
 * DEFAULT_CONFIG — the zero-configuration defaults for MulliganConfig.
 * CONSTANT: do not mutate. getConfig() returns a fresh clone, never this object itself.
 * Source of truth: spec/09-configuration.md §2.
 */
export const DEFAULT_CONFIG: MulliganConfig = {
  enabled: true,
  rewind: {
    enabled: true,
    protectedRoles: ["first:user", "latest:user"],
    maxDepth: 5,
    requireMutationWarning: true,
  },
  shrink: {
    enabled: true,
  },
  nudges: {
    bloatReminder: true,
    perTurnDrift: true,
    bloatThresholdBytes: 8192,
    driftThresholdTokens: 3000,
  },
  audit: {
    estimateConfidence: "medium",
  },
  log: {
    file: null,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers (module-local; not exported)
// ─────────────────────────────────────────────────────────────────────────────

/** Known protectedRoles selector strings (spec/09 §4). v1 supports exactly these two. */
const KNOWN_PROTECTED_ROLES = new Set<string>(["first:user", "latest:user"]);

/** True for plain records and Object.create(null); false for null, primitives, and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a property without throwing (a Proxy `get` trap may throw). Returns `undefined` if the property
 *  is absent OR the read throws — both are treated as "not provided" (keep default, no warn). */
function safeGet(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Boolean: coerce with `!!` (spec/09 §4). Absent (undefined) → fallback. Present (incl. null) → `!!value`. */
function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : !!value;
}

/** Number: must be a finite number; `mustBePositive` enforces `> 0` (else `>= 0`). Invalid-present → fallback + warn. */
function coerceNumber(field: string, value: unknown, fallback: number, mustBePositive: boolean): number {
  if (typeof value === "number" && Number.isFinite(value) && (mustBePositive ? value > 0 : value >= 0)) {
    return value;
  }
  warnConfig(field, value);
  return fallback;
}

/** protectedRoles: array of known selectors; unknown entries dropped (per-entry warn). Non-array → fallback + warn. */
function coerceProtectedRoles(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    warnConfig("rewind.protectedRoles", value);
    return fallback;
  }
  const known: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && KNOWN_PROTECTED_ROLES.has(entry)) {
      known.push(entry);
    } else {
      warnConfig("rewind.protectedRoles entry", entry);
    }
  }
  return known;
}

/** estimateConfidence: must be one of low|medium|high; else fallback + warn. */
function coerceEstimateConfidence(value: unknown, fallback: EstimateConfidence): EstimateConfidence {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  warnConfig("audit.estimateConfidence", value);
  return fallback;
}

/** log.file: null (off — no warn) or any string (opening deferred); non-string-non-null → fallback + warn. */
function coerceLogFile(value: unknown, fallback: string | null): string | null {
  if (value === null) return fallback; // explicit "off" — valid
  if (typeof value === "string") return value;
  warnConfig("log.file", value);
  return fallback;
}

/** Fail-safe warn (spec/09 §4: "log a warn naming the field and the value"). Uses console.warn
 *  until the structured JSONL logger (log.ts) ships. config.ts does NOT import log.ts. */
function warnConfig(field: string, value: unknown): void {
  try {
    console.warn(`[mulligan] config: invalid "${field}"=${safeStringify(value)}, using default`);
  } catch {
    /* never throw — logging must not crash the extension */
  }
}

/** JSON.stringify that never throws (circular refs / BigInt → String()). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache + public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session cache of the validated config. `null` until the first getConfig()/setConfig().
 * Re-validated and replaced on every setConfig().
 */
let cachedConfig: MulliganConfig | null = null;

/**
 * getConfig() — the public read API (spec/09 §1: "loaded lazily on first use and cached for the session").
 *
 * LAZY: on the first call (cache empty) it validates DEFAULT_CONFIG and caches the result.
 * DEFENSIVE COPY: a fresh structuredClone is returned on EVERY call, so a caller can never mutate the
 * shared session cache (or DEFAULT_CONFIG).
 */
export function getConfig(): MulliganConfig {
  let cfg = cachedConfig;
  if (cfg === null) {
    cfg = validateConfig(undefined);
    cachedConfig = cfg;
  }
  return structuredClone(cfg);
}

/**
 * setConfig() — initialize / replace the session cache from a raw settings object (spec/09 §1).
 * NEVER throws: any error resets the cache to validated defaults.
 */
export function setConfig(raw: unknown): void {
  try {
    cachedConfig = validateConfig(raw);
  } catch {
    cachedConfig = validateConfig(undefined);
  }
}

/**
 * validateConfig() — the pure, fail-safe validation engine (spec/09 §4).
 *
 * Deep-merges `raw` over a clone of DEFAULT_CONFIG, validates + coerces each known field per the §4 rules,
 * ignores unknown keys (forward-compat), and returns a fully-valid MulliganConfig. NEVER throws: the entire
 * body is wrapped in try/catch; on ANY error it returns a fresh clone of DEFAULT_CONFIG.
 */
export function validateConfig(raw: unknown): MulliganConfig {
  try {
    const cfg: MulliganConfig = structuredClone(DEFAULT_CONFIG);
    if (!isRecord(raw)) {
      return cfg;
    }

    let v: unknown;

    // Top-level master switch
    v = safeGet(raw, "enabled");
    if (v !== undefined) cfg.enabled = coerceBoolean(v, cfg.enabled);

    // rewind.*
    const rewindRaw = safeGet(raw, "rewind");
    if (isRecord(rewindRaw)) {
      v = safeGet(rewindRaw, "enabled");
      if (v !== undefined) cfg.rewind.enabled = coerceBoolean(v, cfg.rewind.enabled);
      v = safeGet(rewindRaw, "protectedRoles");
      if (v !== undefined) cfg.rewind.protectedRoles = coerceProtectedRoles(v, cfg.rewind.protectedRoles);
      v = safeGet(rewindRaw, "maxDepth");
      if (v !== undefined) cfg.rewind.maxDepth = coerceNumber("rewind.maxDepth", v, cfg.rewind.maxDepth, false);
      v = safeGet(rewindRaw, "requireMutationWarning");
      if (v !== undefined) cfg.rewind.requireMutationWarning = coerceBoolean(v, cfg.rewind.requireMutationWarning);
    }

    // shrink.* (autoOnBloat intentionally NOT honored — reserved, not v1)
    const shrinkRaw = safeGet(raw, "shrink");
    if (isRecord(shrinkRaw)) {
      v = safeGet(shrinkRaw, "enabled");
      if (v !== undefined) cfg.shrink.enabled = coerceBoolean(v, cfg.shrink.enabled);
    }

    // nudges.*
    const nudgesRaw = safeGet(raw, "nudges");
    if (isRecord(nudgesRaw)) {
      v = safeGet(nudgesRaw, "bloatReminder");
      if (v !== undefined) cfg.nudges.bloatReminder = coerceBoolean(v, cfg.nudges.bloatReminder);
      v = safeGet(nudgesRaw, "perTurnDrift");
      if (v !== undefined) cfg.nudges.perTurnDrift = coerceBoolean(v, cfg.nudges.perTurnDrift);
      v = safeGet(nudgesRaw, "bloatThresholdBytes");
      if (v !== undefined) cfg.nudges.bloatThresholdBytes = coerceNumber("nudges.bloatThresholdBytes", v, cfg.nudges.bloatThresholdBytes, true);
      v = safeGet(nudgesRaw, "driftThresholdTokens");
      if (v !== undefined) cfg.nudges.driftThresholdTokens = coerceNumber("nudges.driftThresholdTokens", v, cfg.nudges.driftThresholdTokens, true);
    }

    // audit.*
    const auditRaw = safeGet(raw, "audit");
    if (isRecord(auditRaw)) {
      v = safeGet(auditRaw, "estimateConfidence");
      if (v !== undefined) cfg.audit.estimateConfidence = coerceEstimateConfidence(v, cfg.audit.estimateConfidence);
    }

    // log.*
    const logRaw = safeGet(raw, "log");
    if (isRecord(logRaw)) {
      v = safeGet(logRaw, "file");
      if (v !== undefined) cfg.log.file = coerceLogFile(v, cfg.log.file);
    }

    return cfg;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
