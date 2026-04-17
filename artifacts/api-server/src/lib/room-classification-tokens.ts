/**
 * room-classification-tokens.ts — Canonical token sets for R5/R6 classification
 *
 * Single source of truth for OFFICE_TOKENS and SUITE_TOKENS, consumed by:
 *   - room-inventory.ts  (Phase 4, deriveFlags)  — uppercases tokens for substring match
 *   - rule-engine.ts     (Phase 5, classifyRoom) — uses tokens lowercase via hasToken()
 *
 * Tokens are stored lowercase. Trailing spaces (e.g. "exec ", "ste ") are intentional:
 * they prevent substring false-positives in the Phase 4 uppercase includes() check
 * (e.g. "EXEC " matches "EXEC DIRECTOR" but not standalone "EXECUTIVE" which has its
 * own entry) while also working correctly via the Phase 5 hasToken() substring path
 * (which checks `lower.includes(entry)` for multi-word/space-containing entries).
 */

export const OFFICE_TOKENS = new Set([
  "office",
  "offices",
  "exec ",         // trailing space: matches "EXEC DIRECTOR" not mid-word in "EXECUTIVE"
  "executive",
  "director",
  "principal",
  "manager",
  "partner",
  "admin",
  "administration",
  "administrative",
  "admin office",
  "private office",
  "workroom",
  "workspace",
]);

export const SUITE_TOKENS = new Set([
  "suite",
  "suites",
  "ste ",          // trailing space: matches "STE 100" etc., not mid-word fragments
  "tenant",
  "tenant suite",
  "office suite",
  "tenant space",
]);
