/**
 * Computes a map from sign ID → { index, total } for disambiguating
 * multiple signs of the same type in the same room.
 *
 * Priority:
 *  1. If the sign record already carries occurrenceIndex / occurrenceTotal
 *     (set server-side at extraction time), those values are used directly
 *     and are stable across marker repositions.
 *  2. Legacy fallback: cluster by xPos / yPos for older records that were
 *     extracted before the occurrence columns existed.  Clusters are ordered
 *     top-to-bottom then left-to-right so the label (1/N, 2/N, …) matches
 *     the PDF room-extractor order used in the sign table.
 */

export interface OccurrenceSignInput {
  id: string;
  signIdentifier: string | null;
  location: string | null;
  xPos: number | null;
  yPos: number | null;
  occurrenceIndex: number | null;
  occurrenceTotal: number | null;
}

export function buildSignOccurrenceMap(
  signs: OccurrenceSignInput[],
): Map<string, { index: number; total: number }> {
  const map = new Map<string, { index: number; total: number }>();

  const legacySigns: OccurrenceSignInput[] = [];
  for (const s of signs) {
    if (s.occurrenceIndex != null && s.occurrenceTotal != null && s.occurrenceTotal > 1) {
      map.set(s.id, { index: s.occurrenceIndex, total: s.occurrenceTotal });
    } else {
      legacySigns.push(s);
    }
  }

  const groups = new Map<string, OccurrenceSignInput[]>();
  for (const s of legacySigns) {
    const key = `${(s.signIdentifier ?? "").toLowerCase().trim()}||${(s.location ?? "").toLowerCase().trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  for (const [, groupSigns] of groups) {
    const posGroups = new Map<string, string[]>();
    for (const s of groupSigns) {
      const posKey =
        s.xPos != null && s.yPos != null
          ? `${s.xPos.toFixed(4)},${s.yPos.toFixed(4)}`
          : "unplaced";
      if (!posGroups.has(posKey)) posGroups.set(posKey, []);
      posGroups.get(posKey)!.push(s.id);
    }

    const total = posGroups.size;
    if (total <= 1) continue;

    // Sort position groups by spatial coordinates so the occurrence index
    // (1/N, 2/N, …) matches the top-to-bottom / left-to-right order that
    // the PDF room extractor uses when building ri.rooms — keeping the table
    // sub-row numbering consistent with the canvas marker numbering.
    const orderedPosGroups = [...posGroups.entries()].sort((a, b) => {
      const parseCoords = (posKey: string): { x: number; y: number } | null => {
        if (posKey === "unplaced") return null;
        const parts = posKey.split(",");
        if (parts.length !== 2) return null;
        const x = parseFloat(parts[0]);
        const y = parseFloat(parts[1]);
        return isNaN(x) || isNaN(y) ? null : { x, y };
      };
      const aC = parseCoords(a[0]);
      const bC = parseCoords(b[0]);
      if (aC === null && bC === null) return 0;
      if (aC === null) return 1;
      if (bC === null) return -1;
      if (aC.y !== bC.y) return aC.y - bC.y;
      return aC.x - bC.x;
    });

    orderedPosGroups.forEach(([, signIds], idx) => {
      for (const signId of signIds) {
        map.set(signId, { index: idx + 1, total });
      }
    });
  }

  return map;
}
