/**
 * Unit tests for the signOccurrenceMap computation logic used in
 * UnifiedPlanViewer.tsx.
 *
 * The core invariant: when a sign record carries non-null occurrenceIndex /
 * occurrenceTotal (set server-side at extraction time), those values are used
 * directly and repositioning the marker (changing xPos / yPos) must never
 * alter them.
 *
 * Tests import the real production helper so any divergence in the
 * implementation is caught here, not silently hidden by a copied function.
 */
import { describe, it, expect } from "vitest";
import { buildSignOccurrenceMap, type OccurrenceSignInput } from "../lib/build-sign-occurrence-map";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSign(overrides: Partial<OccurrenceSignInput> & { id: string }): OccurrenceSignInput {
  return {
    signIdentifier: "E-1",
    location: "Corridor 1",
    xPos: 0.25,
    yPos: 0.40,
    occurrenceIndex: null,
    occurrenceTotal: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("signOccurrenceMap — stored occurrence values", () => {
  it("uses occurrenceIndex and occurrenceTotal directly for a sign with non-null values", () => {
    const sign = makeSign({ id: "s1", occurrenceIndex: 2, occurrenceTotal: 3 });
    const map = buildSignOccurrenceMap([sign]);
    expect(map.get("s1")).toEqual({ index: 2, total: 3 });
  });

  it("preserves occurrenceIndex after xPos changes (reposition simulation)", () => {
    const original = makeSign({ id: "s1", xPos: 0.25, yPos: 0.40, occurrenceIndex: 2, occurrenceTotal: 3 });
    const mapBefore = buildSignOccurrenceMap([original]);

    const repositioned = { ...original, xPos: 0.80, yPos: 0.15 };
    const mapAfter = buildSignOccurrenceMap([repositioned]);

    expect(mapAfter.get("s1")?.index).toBe(mapBefore.get("s1")?.index);
  });

  it("preserves occurrenceTotal after yPos changes (reposition simulation)", () => {
    const original = makeSign({ id: "s1", xPos: 0.25, yPos: 0.40, occurrenceIndex: 1, occurrenceTotal: 4 });
    const repositioned = { ...original, xPos: 0.60, yPos: 0.90 };
    const mapAfter = buildSignOccurrenceMap([repositioned]);
    expect(mapAfter.get("s1")?.total).toBe(4);
  });

  it("is stable across multiple repositions", () => {
    const sign = makeSign({ id: "s1", occurrenceIndex: 3, occurrenceTotal: 5 });
    const positions = [
      { xPos: 0.10, yPos: 0.10 },
      { xPos: 0.50, yPos: 0.50 },
      { xPos: 0.99, yPos: 0.01 },
    ];
    for (const pos of positions) {
      const moved = { ...sign, ...pos };
      const map = buildSignOccurrenceMap([moved]);
      expect(map.get("s1")).toEqual({ index: 3, total: 5 });
    }
  });
});

describe("signOccurrenceMap — mixed stored and legacy signs", () => {
  it("handles a group where some signs have stored indices and others use the legacy fallback", () => {
    const storedSign  = makeSign({ id: "stored", occurrenceIndex: 2, occurrenceTotal: 2 });
    // Legacy signs: top sign (lower yPos) gets index 1, bottom gets index 2
    const legacyTop    = makeSign({ id: "leg1", signIdentifier: "X-1", location: "Room A", xPos: 0.50, yPos: 0.10 });
    const legacyBottom = makeSign({ id: "leg2", signIdentifier: "X-1", location: "Room A", xPos: 0.50, yPos: 0.80 });

    const map = buildSignOccurrenceMap([storedSign, legacyTop, legacyBottom]);

    expect(map.get("stored")).toEqual({ index: 2, total: 2 });
    expect(map.get("leg1")).toEqual({ index: 1, total: 2 });
    expect(map.get("leg2")).toEqual({ index: 2, total: 2 });
  });

  it("repositioning a stored sign does not affect legacy sign clustering", () => {
    const storedSign   = makeSign({ id: "stored", occurrenceIndex: 1, occurrenceTotal: 3 });
    // Legacy signs ordered by spatial position (top-to-bottom)
    const legacyTop    = makeSign({ id: "leg1", signIdentifier: "Y-2", location: "Wing B", xPos: 0.50, yPos: 0.20 });
    const legacyBottom = makeSign({ id: "leg2", signIdentifier: "Y-2", location: "Wing B", xPos: 0.50, yPos: 0.80 });

    const movedStored = { ...storedSign, xPos: 0.99, yPos: 0.99 };
    const map = buildSignOccurrenceMap([movedStored, legacyTop, legacyBottom]);

    expect(map.get("stored")).toEqual({ index: 1, total: 3 });
    expect(map.get("leg1")).toEqual({ index: 1, total: 2 });
    expect(map.get("leg2")).toEqual({ index: 2, total: 2 });
  });

  it("orders legacy signs by yPos (top-to-bottom) within the same signIdentifier group", () => {
    const top    = makeSign({ id: "top",    signIdentifier: "Z-1", location: "Hall", xPos: 0.5, yPos: 0.10 });
    const middle = makeSign({ id: "mid",    signIdentifier: "Z-1", location: "Hall", xPos: 0.5, yPos: 0.50 });
    const bottom = makeSign({ id: "bottom", signIdentifier: "Z-1", location: "Hall", xPos: 0.5, yPos: 0.90 });

    const map = buildSignOccurrenceMap([bottom, top, middle]);

    expect(map.get("top")).toEqual({ index: 1, total: 3 });
    expect(map.get("mid")).toEqual({ index: 2, total: 3 });
    expect(map.get("bottom")).toEqual({ index: 3, total: 3 });
  });
});

describe("signOccurrenceMap — edge cases", () => {
  it("does not include a sign in the map when occurrenceTotal is 1 (sole occurrence)", () => {
    const sign = makeSign({ id: "s1", occurrenceIndex: 1, occurrenceTotal: 1 });
    const map = buildSignOccurrenceMap([sign]);
    expect(map.has("s1")).toBe(false);
  });

  it("does not include a sign in the map when both occurrence columns are null", () => {
    const sign = makeSign({ id: "s1", occurrenceIndex: null, occurrenceTotal: null });
    const map = buildSignOccurrenceMap([sign]);
    expect(map.has("s1")).toBe(false);
  });

  it("returns an empty map for an empty sign list", () => {
    const map = buildSignOccurrenceMap([]);
    expect(map.size).toBe(0);
  });

  it("places unplaced signs (null xPos/yPos) after spatially-placed ones", () => {
    const placed   = makeSign({ id: "placed",   signIdentifier: "U-1", location: "Room X", xPos: 0.5, yPos: 0.5 });
    const unplaced = makeSign({ id: "unplaced", signIdentifier: "U-1", location: "Room X", xPos: null, yPos: null });

    const map = buildSignOccurrenceMap([unplaced, placed]);

    expect(map.get("placed")).toEqual({ index: 1, total: 2 });
    expect(map.get("unplaced")).toEqual({ index: 2, total: 2 });
  });
});
