import { describe, it, expect } from "vitest";
import {
  phraseMatchScore,
  parseLocationParts,
  isResidentialUnitLocation,
  findPairedClusterMatch,
  findSignLocationFromPhrases,
  type PdfPhrase,
} from "./signMatcher";
import type { ExtractedSign } from "@/types/sign";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makePhrase(text: string, x0: number, y0: number, x1: number, y1: number): PdfPhrase {
  return { text, x0, y0, x1, y1 };
}

function makeSign(overrides: Partial<ExtractedSign> = {}): ExtractedSign {
  return {
    id: "test-sign",
    confidenceScore: 0.9,
    reviewFlag: false,
    ...overrides,
  };
}

// ─── phraseMatchScore ─────────────────────────────────────────────────────────

describe("phraseMatchScore", () => {
  it("returns 1 for identical strings", () => {
    expect(phraseMatchScore("Conference Room", "Conference Room")).toBeCloseTo(1);
  });

  it("returns 0 for empty phrase", () => {
    expect(phraseMatchScore("", "Conference Room")).toBe(0);
  });

  it("returns 0 for empty query", () => {
    expect(phraseMatchScore("Conference Room", "")).toBe(0);
  });

  it("returns 0 for both empty", () => {
    expect(phraseMatchScore("", "")).toBe(0);
  });

  it("is case-insensitive", () => {
    const mixed = phraseMatchScore("CONFERENCE ROOM", "conference room");
    expect(mixed).toBeCloseTo(1, 1);
  });

  it("scores high for partial overlap (one token matching)", () => {
    const score = phraseMatchScore("Conference", "Conference Room");
    expect(score).toBeGreaterThan(0.4);
  });

  it("scores 0 for completely different strings", () => {
    const score = phraseMatchScore("lobby", "stairwell 101");
    expect(score).toBeLessThan(0.3);
  });

  it("canonicalises abbreviation STR → STAIRWELL for a high score", () => {
    const withAbbrev = phraseMatchScore("STR 101", "STAIRWELL 101");
    const withFull   = phraseMatchScore("STAIRWELL 101", "STAIRWELL 101");
    expect(withAbbrev).toBeGreaterThan(0.8);
    expect(withFull).toBeGreaterThan(0.9);
  });

  it("canonicalises abbreviation RR → RESTROOM for a high score", () => {
    const score = phraseMatchScore("RR", "RESTROOM");
    expect(score).toBeGreaterThan(0.8);
  });

  it("canonicalises ELEV → ELEVATOR", () => {
    const score = phraseMatchScore("ELEV", "ELEVATOR");
    expect(score).toBeGreaterThan(0.8);
  });

  it("handles numeric tokens correctly", () => {
    const score = phraseMatchScore("101", "101");
    expect(score).toBeCloseTo(1, 1);
  });

  it("strips punctuation before scoring", () => {
    const score = phraseMatchScore("Room #101", "Room 101");
    expect(score).toBeGreaterThan(0.8);
  });
});

// ─── parseLocationParts ───────────────────────────────────────────────────────

describe("parseLocationParts", () => {
  it("extracts a letter-prefixed room number", () => {
    const { typeToken, numberToken } = parseLocationParts("Conference A101");
    expect(numberToken).toBe("A101");
    expect(typeToken).toMatch(/conference/i);
  });

  it("extracts a digit+letter room number (e.g. 20B)", () => {
    const { numberToken } = parseLocationParts("Office 20B");
    expect(numberToken).toBe("20B");
  });

  it("returns null typeToken when only a letter+digit token is present", () => {
    const { typeToken, numberToken } = parseLocationParts("A101");
    expect(numberToken).toBe("A101");
    expect(typeToken).toBeNull();
  });

  it("returns null numberToken when only text is present", () => {
    const { numberToken } = parseLocationParts("Conference Room");
    expect(numberToken).toBeNull();
  });

  it("returns both null for an empty string", () => {
    const { typeToken, numberToken } = parseLocationParts("");
    expect(typeToken).toBeNull();
    expect(numberToken).toBeNull();
  });

  it("handles multiple room numbers — picks the first", () => {
    const { numberToken } = parseLocationParts("Corridor B201 B202");
    expect(numberToken).toBe("B201");
  });

  it("strips the room number out of the type token", () => {
    const { typeToken } = parseLocationParts("STAIRWELL B301");
    expect(typeToken).not.toContain("B301");
    expect(typeToken?.trim().toLowerCase()).toBe("stairwell");
  });
});

// ─── isResidentialUnitLocation ────────────────────────────────────────────────

describe("isResidentialUnitLocation", () => {
  it("returns true for UNIT with letter+digit number", () => {
    expect(isResidentialUnitLocation("UNIT A201")).toBe(true);
  });

  it("returns true for SUITE with digit+letter number", () => {
    expect(isResidentialUnitLocation("SUITE 10A")).toBe(true);
  });

  it("returns true for APT with digit+letter number", () => {
    expect(isResidentialUnitLocation("APT 10B")).toBe(true);
  });

  it("returns true for APARTMENT with digit+letter number", () => {
    expect(isResidentialUnitLocation("APARTMENT 30A")).toBe(true);
  });

  it("returns true for PENTHOUSE with letter+digit number", () => {
    expect(isResidentialUnitLocation("PENTHOUSE PH01")).toBe(true);
  });

  it("returns true for PH with digit+letter number", () => {
    expect(isResidentialUnitLocation("PH 20B")).toBe(true);
  });

  it("returns false for a commercial room type", () => {
    expect(isResidentialUnitLocation("Conference A101")).toBe(false);
  });

  it("returns false when location has no number token", () => {
    expect(isResidentialUnitLocation("UNIT")).toBe(false);
  });

  it("returns false when location has no type token", () => {
    expect(isResidentialUnitLocation("101")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isResidentialUnitLocation("")).toBe(false);
  });
});

// ─── findPairedClusterMatch ───────────────────────────────────────────────────

describe("findPairedClusterMatch", () => {
  it("returns null when there are no phrases", () => {
    const result = findPairedClusterMatch([], "CONFERENCE", "A101", "S-1");
    expect(result).toBeNull();
  });

  it("finds a match when type and number phrases are within cluster radius", () => {
    const cx = 0.5;
    const cy = 0.5;
    const phrases: PdfPhrase[] = [
      makePhrase("CONFERENCE", cx - 0.01, cy - 0.01, cx + 0.01, cy + 0.01),
      makePhrase("A101",       cx + 0.02, cy - 0.01, cx + 0.04, cy + 0.01),
    ];
    const result = findPairedClusterMatch(phrases, "CONFERENCE", "A101", "S-1");
    expect(result).not.toBeNull();
    expect(result).not.toBe("ambiguous");
    if (result && result !== "ambiguous") {
      expect(result.score).toBeGreaterThan(0.5);
      expect(result.matched).toContain("A101");
    }
  });

  it("returns null when type and number are too far apart", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("CONFERENCE", 0.1, 0.1, 0.2, 0.15),
      makePhrase("A101",       0.8, 0.8, 0.9, 0.85),
    ];
    const result = findPairedClusterMatch(phrases, "CONFERENCE", "A101", "S-1");
    expect(result).toBeNull();
  });

  it("returns 'ambiguous' when two equally-close pairs exist", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("CONFERENCE", 0.2, 0.2, 0.25, 0.25),
      makePhrase("A101",       0.22, 0.22, 0.27, 0.27),
      makePhrase("CONFERENCE", 0.5, 0.5, 0.55, 0.55),
      makePhrase("A101",       0.52, 0.52, 0.57, 0.57),
    ];
    const result = findPairedClusterMatch(phrases, "CONFERENCE", "A101", "S-1");
    expect(result).toBe("ambiguous");
  });

  it("returns null when number token has no matches", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("CONFERENCE", 0.5, 0.5, 0.55, 0.55),
    ];
    const result = findPairedClusterMatch(phrases, "CONFERENCE", "B999", "S-1");
    expect(result).toBeNull();
  });
});

// ─── findSignLocationFromPhrases ──────────────────────────────────────────────

describe("findSignLocationFromPhrases", () => {
  it("returns null when phrases list is empty", () => {
    const sign = makeSign({ signIdentifier: "W-1", location: "Lobby" });
    expect(findSignLocationFromPhrases([], sign)).toBeNull();
  });

  it("Pre-Pass A — matches by verbatim signIdentifier substring", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("W-1 LOBBY EXIT", 0.4, 0.3, 0.6, 0.35),
      makePhrase("CORRIDOR 202",   0.1, 0.5, 0.3, 0.55),
    ];
    const sign = makeSign({ signIdentifier: "W-1", location: "Lobby" });
    const result = findSignLocationFromPhrases(phrases, sign);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
    expect(result!.matched).toBe("W-1 LOBBY EXIT");
  });

  it("Pre-Pass B — matches by token overlap when no identifier is present", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("LOBBY",         0.5, 0.5, 0.6, 0.55),
      makePhrase("STAIRWELL 101", 0.2, 0.8, 0.4, 0.85),
    ];
    const sign = makeSign({ location: "LOBBY" });
    const result = findSignLocationFromPhrases(phrases, sign);
    expect(result).not.toBeNull();
    expect(result!.matched.toLowerCase()).toContain("lobby");
  });

  it("Pre-Pass C — matches by room number extracted from location", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("A101",        0.5, 0.5, 0.6, 0.55),
      makePhrase("BREAKROOM",   0.5, 0.52, 0.6, 0.57),
      makePhrase("OFFICE B999", 0.1, 0.1,  0.2, 0.15),
    ];
    const sign = makeSign({ location: "CONFERENCE A101" });
    const result = findSignLocationFromPhrases(phrases, sign);
    expect(result).not.toBeNull();
  });

  it("returns null when no pass can find a match", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("ZZZZNOTHING", 0.5, 0.5, 0.6, 0.55),
    ];
    const sign = makeSign({ location: "COMPLETELY DIFFERENT ROOM XXXXXXX" });
    const result = findSignLocationFromPhrases(phrases, sign);
    expect(result).toBeNull();
  });

  it("filters out margin phrases (y < 0.04) for phrase-based passes", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("LOBBY", 0.5, 0.01, 0.6, 0.02),
    ];
    const sign = makeSign({ location: "LOBBY" });
    const result = findSignLocationFromPhrases(phrases, sign);
    expect(result).toBeNull();
  });

  it("result coordinates are within [0, 1] range", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("BREAKROOM 202", 0.3, 0.4, 0.5, 0.45),
    ];
    const sign = makeSign({ location: "BREAKROOM 202" });
    const result = findSignLocationFromPhrases(phrases, sign);
    expect(result).not.toBeNull();
    expect(result!.x).toBeGreaterThanOrEqual(0);
    expect(result!.x).toBeLessThanOrEqual(1);
    expect(result!.y).toBeGreaterThanOrEqual(0);
    expect(result!.y).toBeLessThanOrEqual(1);
  });

  it("returns a result even when location has only a type word (no room number — goes via phrase matching)", () => {
    const phrases: PdfPhrase[] = [
      makePhrase("LOBBY",      0.5, 0.5, 0.6, 0.55),
      makePhrase("STAIRWELL",  0.2, 0.8, 0.3, 0.85),
    ];
    const sign = makeSign({ location: "LOBBY" });
    const result = findSignLocationFromPhrases(phrases, sign);
    expect(result).not.toBeNull();
    expect(result!.x).toBeGreaterThan(0.4);
  });
});
