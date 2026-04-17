import { describe, it, expect } from "vitest";
import {
  canonToken,
  findPairedClusterMatch,
  findSignLocationFromPhrases,
  type PdfPhrase,
} from "./signMatcher";
import type { ExtractedSign } from "@/types/sign";

function phrase(text: string, cx: number, cy: number, half = 0.04): PdfPhrase {
  return { text, x0: cx - half, x1: cx + half, y0: cy - half, y1: cy + half };
}

function makeSign(overrides: Partial<ExtractedSign> = {}): ExtractedSign {
  return {
    id: "test-sign",
    confidenceScore: 0.9,
    reviewFlag: false,
    ...overrides,
  };
}

// ── canonToken canonicalization ───────────────────────────────────────────────

describe("canonToken — abbreviation canonicalization", () => {
  it("COLLAB → collaboration (COLLABORATION canonical)", () => {
    expect(canonToken("COLLAB")).toBe("collaboration");
  });

  it("COLLABORATION → collaboration (identity)", () => {
    expect(canonToken("COLLABORATION")).toBe("collaboration");
  });

  it("WRR → restroom (Women's Restroom abbreviation)", () => {
    expect(canonToken("WRR")).toBe("restroom");
  });

  it("MRR → restroom (Men's Restroom abbreviation)", () => {
    expect(canonToken("MRR")).toBe("restroom");
  });

  it("RR → restroom (generic Restroom abbreviation)", () => {
    expect(canonToken("RR")).toBe("restroom");
  });

  it("case-insensitive: lower-case input collab → collaboration", () => {
    expect(canonToken("collab")).toBe("collaboration");
  });

  it("case-insensitive: lower-case input wrr → restroom", () => {
    expect(canonToken("wrr")).toBe("restroom");
  });

  it("unknown token is returned as lower-case unchanged", () => {
    expect(canonToken("UNKNOWN_WORD")).toBe("unknown_word");
  });
});

// ── findPairedClusterMatch — null when no valid pairs ────────────────────────

describe("findPairedClusterMatch — fallthrough paths", () => {
  it("returns null when no phrase matches the type token", () => {
    const phrases = [
      phrase("LOBBY", 0.5, 0.5),
      phrase("A101", 0.5, 0.5),
    ];
    const result = findPairedClusterMatch(phrases, "CONFERENCE", "A101", "S-1");
    expect(result).toBeNull();
  });

  it("returns null when no phrase contains the number token as a boundary match", () => {
    const phrases = [
      phrase("CONFERENCE ROOM AREA NORTH WING", 0.5, 0.5),
    ];
    const result = findPairedClusterMatch(phrases, "CONFERENCE", "A101", "S-1");
    expect(result).toBeNull();
  });

  it("returns null when type and number phrases exist but are too far apart (> 0.05)", () => {
    const typePh = phrase("CONFERENCE", 0.10, 0.5);
    const numPh = phrase("A101", 0.90, 0.5);
    const result = findPairedClusterMatch([typePh, numPh], "CONFERENCE", "A101", "S-1");
    expect(result).toBeNull();
  });

  it("returns a result when type and number phrases are within 0.05 radius", () => {
    const typePh = phrase("CONFERENCE", 0.50, 0.50, 0.02);
    const numPh = phrase("A101", 0.52, 0.50, 0.02);
    const result = findPairedClusterMatch([typePh, numPh], "CONFERENCE", "A101", "S-1");
    expect(result).not.toBeNull();
    expect(result).not.toBe("ambiguous");
    if (result && result !== "ambiguous") {
      expect(result.score).toBe(0.95);
    }
  });
});

// ── findSignLocationFromPhrases — Pass 0.5 → Pass 1 fallthrough ──────────────

describe("findSignLocationFromPhrases — cluster-miss falls through to Pass 1", () => {
  /**
   * Location "CONFERENCE 12A" triggers Pass 0.5 because parseLocationParts
   * recognises "12A" as a room number (\d{2,4}[A-Za-z]{1,2} pattern) and
   * "CONFERENCE" as the type token.
   *
   * The phrase is "CONFERENCE 12A EAST WING NORTH CORRIDOR BUILDING", which:
   *   • Pre-Pass A: skipped (no signIdentifier)
   *   • Pre-Pass B: token-overlap score = 2/7 ≈ 0.29, below the 0.4 threshold
   *                  → does NOT return early
   *   • Pre-Pass C: uses /\b(?:[A-Z]{1,2}-\d{2,4}|[A-Z]?\d{3}[A-Z]?)\b/g,
   *                  which requires ≥ 3 digits; "12A" has only 2 → no match
   *                  → does NOT return early
   *   • Pass 0.5:   typeCands = [phrase] (phraseMatchScore for "CONFERENCE"=1.0)
   *                  numCands = [] because normId merges the phrase into one
   *                  token without a stand-alone boundary for "12a"
   *                  → findPairedClusterMatch returns null → FALLS THROUGH
   *   • Pass 1:     phraseMatchScore = (1 + 1)/2 = 1.0 ≥ 0.65 → MATCH
   *
   * This test guards against any future change that makes Pass 0.5 return null
   * and then also propagate null instead of falling through.
   */
  it("returns a match from Pass 1 when the paired-cluster search finds no number candidates", () => {
    const floorPhrase = phrase(
      "CONFERENCE 12A EAST WING NORTH CORRIDOR BUILDING",
      0.50,
      0.50,
      0.10,
    );
    const sign = makeSign({ location: "CONFERENCE 12A", signIdentifier: "S-1" });
    const result = findSignLocationFromPhrases([floorPhrase], sign);

    expect(result).not.toBeNull();
    expect(result!.matched).toBe("CONFERENCE 12A EAST WING NORTH CORRIDOR BUILDING");
  });

  /**
   * Regression guard: when Pass 0.5 cluster is null AND Pass 1-3 all miss,
   * the function must return null (not crash or return a phantom result).
   */
  it("returns null when cluster misses and no later pass can match either", () => {
    const unrelatedPhrase = phrase("LOBBY NORTH", 0.50, 0.50, 0.04);
    // Location has a room-number component to trigger Pass 0.5, but the phrase
    // has no overlap with "MECHANICAL 12A", so all passes miss.
    const sign = makeSign({ location: "MECHANICAL 12A", signIdentifier: "S-X" });
    const result = findSignLocationFromPhrases([unrelatedPhrase], sign);
    expect(result).toBeNull();
  });

  /**
   * Regression guard: findPairedClusterMatch returns "ambiguous" when two
   * equally-close pairs exist (distance difference < 0.02). The caller
   * (findSignLocationFromPhrases) converts "ambiguous" → null to avoid a
   * wrong-room placement.
   */
  it("findPairedClusterMatch returns 'ambiguous' when two equally-close pairs exist", () => {
    const type1 = phrase("CONFERENCE", 0.20, 0.50, 0.02);
    const num1 = phrase("A101", 0.22, 0.50, 0.02);
    const type2 = phrase("CONFERENCE", 0.70, 0.50, 0.02);
    const num2 = phrase("A101", 0.72, 0.50, 0.02);
    const result = findPairedClusterMatch(
      [type1, num1, type2, num2],
      "CONFERENCE",
      "A101",
      "S-2",
    );
    expect(result).toBe("ambiguous");
  });

  it("returns a match even when Pass 0.5 is skipped (no room-number token in location)", () => {
    // "CONFERENCE ROOM" has no alphanumeric room number so parseLocationParts
    // returns numberToken=null → Pass 0.5 is never entered. Pre-Pass B
    // finds the full-overlap match in this case, which is also correct.
    const floorPhrase = phrase("CONFERENCE ROOM", 0.50, 0.50, 0.06);
    const sign = makeSign({ location: "CONFERENCE ROOM", signIdentifier: "S-3" });
    const result = findSignLocationFromPhrases([floorPhrase], sign);
    expect(result).not.toBeNull();
  });
});
