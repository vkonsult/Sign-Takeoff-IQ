import { describe, it, expect } from "vitest";
import { matchLocationToCoords } from "./pdf-words.js";
import type { PdfPhrase, FloorPlanBbox } from "./pdf-words.js";

const BBOX: FloorPlanBbox = { x0: 0, y0: 0, x1: 1, y1: 1 };

function phrase(text: string, cx = 0.5, cy = 0.5): PdfPhrase {
  const half = 0.05;
  return { text, x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
}

describe("matchLocationToCoords — abbreviation expansion", () => {
  it("matches 'MRR' query to a plan phrase containing 'MRR' exactly", () => {
    const phrases = [phrase("MRR", 0.3, 0.4)];
    const result = matchLocationToCoords(phrases, BBOX, "MRR", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.3);
    expect(result!.yPos).toBeCloseTo(0.4);
  });

  it("matches 'MRR' query to a plan phrase 'Men Restroom' (expansion)", () => {
    const phrases = [phrase("Men Restroom", 0.2, 0.6)];
    const result = matchLocationToCoords(phrases, BBOX, "MRR", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.2);
  });

  it("matches 'WRR' query to a plan phrase containing 'WRR' exactly", () => {
    const phrases = [phrase("WRR", 0.7, 0.3)];
    const result = matchLocationToCoords(phrases, BBOX, "WRR", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.7);
  });

  it("matches 'WRR' query to a plan phrase 'Women Restroom' (expansion)", () => {
    const phrases = [phrase("Women Restroom", 0.6, 0.5)];
    const result = matchLocationToCoords(phrases, BBOX, "WRR", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.6);
  });

  it("matches 'Men Restroom' query to a plan phrase 'MRR' (contraction)", () => {
    const phrases = [phrase("MRR", 0.4, 0.4)];
    const result = matchLocationToCoords(phrases, BBOX, "Men Restroom", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.4);
  });

  it("selects the best matching phrase among multiple candidates", () => {
    const phrases = [
      phrase("SANCTUARY", 0.1, 0.1),
      phrase("MRR", 0.5, 0.5),
      phrase("FELLOWSHIP HALL", 0.9, 0.9),
    ];
    const result = matchLocationToCoords(phrases, BBOX, "MRR", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.5);
    expect(result!.yPos).toBeCloseTo(0.5);
  });
});

describe("matchLocationToCoords — Collaboration Room 130", () => {
  it("matches 'Collaboration Room 130' to an exact plan phrase", () => {
    const phrases = [phrase("COLLABORATION ROOM 130", 0.4, 0.6)];
    const result = matchLocationToCoords(phrases, BBOX, "Collaboration Room 130", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.4);
  });

  it("matches 'Collaboration Room 130' to partial phrase 'COLLAB ROOM 130'", () => {
    const phrases = [phrase("COLLAB ROOM 130", 0.3, 0.3)];
    const result = matchLocationToCoords(phrases, BBOX, "Collaboration Room 130", null);
    expect(result).not.toBeNull();
  });

  it("gives room-number bonus when phrase contains only '130'", () => {
    const phrases = [phrase("130", 0.55, 0.45)];
    const result = matchLocationToCoords(phrases, BBOX, "Collaboration Room 130", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.55);
  });

  it("prefers 'COLLABORATION ROOM 130' over bare '130' when both are present", () => {
    const phrases = [
      phrase("130", 0.1, 0.1),
      phrase("COLLABORATION ROOM 130", 0.8, 0.8),
    ];
    const result = matchLocationToCoords(phrases, BBOX, "Collaboration Room 130", null);
    expect(result).not.toBeNull();
    expect(result!.xPos).toBeCloseTo(0.8);
  });
});

describe("matchLocationToCoords — null / empty guard", () => {
  it("returns null when no query is provided", () => {
    const phrases = [phrase("MRR")];
    expect(matchLocationToCoords(phrases, BBOX, null, null)).toBeNull();
  });

  it("returns null when floorPlanBbox is null", () => {
    const phrases = [phrase("MRR")];
    expect(matchLocationToCoords(phrases, null, "MRR", null)).toBeNull();
  });

  it("returns null when no phrase scores above threshold", () => {
    const phrases = [phrase("ZZZZZ")];
    expect(matchLocationToCoords(phrases, BBOX, "MRR", null)).toBeNull();
  });
});
