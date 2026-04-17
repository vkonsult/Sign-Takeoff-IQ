/**
 * Parses the ?tab= query-string parameter used by the JobDetails page.
 *
 * Exported as a standalone module so it can be imported by tests without
 * pulling in the heavy JobDetails component (react-pdf, pdfjs, etc.).
 */

export type TabName =
  | "table"
  | "sheets"
  | "summary"
  | "floorplans"
  | "signpages"
  | "specs"
  | "timeline"
  | "coords"
  | "ai_scans"
  | "rooms"
  | "verification";

export const VALID_TAB_NAMES: readonly TabName[] = [
  "table",
  "sheets",
  "summary",
  "floorplans",
  "signpages",
  "specs",
  "timeline",
  "coords",
  "ai_scans",
  "rooms",
  "verification",
] as const;

/**
 * Returns the tab name encoded in `search` (the raw query string, e.g.
 * "?tab=sheets"), or `null` if the value is absent or unrecognised.
 *
 * The legacy alias "signs" is mapped to "table" for backwards compatibility.
 */
export function parseTabParam(search: string): TabName | null {
  const t = new URLSearchParams(search).get("tab");
  if (t === "signs") return "table";
  return (VALID_TAB_NAMES as readonly string[]).includes(t ?? "")
    ? (t as TabName)
    : null;
}
