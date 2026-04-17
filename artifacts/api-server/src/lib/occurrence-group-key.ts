/**
 * Canonical occurrence-grouping key.
 *
 * Signs that share the same key are considered "the same sign in the same
 * spot" and receive a shared "(index/total)" occurrence label.
 *
 * Rule: signType + signIdentifier + location + pageNumber
 *
 * All four fields are normalised (lower-cased and trimmed) before joining so
 * that trivial whitespace/case differences never split a group.  Null/undefined
 * values collapse to an empty string so the function is safe to call with
 * partially-populated rows.
 */
export function occurrenceGroupKey(sign: {
  signType?: string | null;
  signIdentifier?: string | null;
  location?: string | null;
  pageNumber?: number | null;
}): string {
  const type = (sign.signType ?? "").toLowerCase().trim();
  const identifier = (sign.signIdentifier ?? "").toLowerCase().trim();
  const location = (sign.location ?? "").toLowerCase().trim();
  const page = sign.pageNumber ?? "";
  return `${type}||${identifier}||${location}||${page}`;
}
