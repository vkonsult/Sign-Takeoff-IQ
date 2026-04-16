import { describe, it, expect } from "vitest";
import { isCodeOnlyLocation, getRoomLabelMap } from "./sign-vocabulary";

// Stage 6 in extraction-heuristic.ts emits non-vocabulary phrases as exception markers
// unless `isCodeOnlyLocation` returns true (silently suppressed).
// Vocabulary-matched phrases bypass Stage 6 entirely via Stage A.
describe("isCodeOnlyLocation — Stage 6 callout-code guard", () => {
  // Must return true: architectural cross-reference codes suppressed at Stage 6
  it.each([
    ["A302"], ["A303"], ["A304"], ["A306"],
    ["A413"], ["A414"], ["A503"], ["A502"], ["A511"],
    ["B205"], ["G12"], ["AE-4"], ["C10"], ["W04"],
    ["1"], ["107"], ["D-X"], [""],
  ])("isCodeOnlyLocation('%s') === true", (input) => {
    expect(isCodeOnlyLocation(input)).toBe(true);
  });

  // Must return false: real room-name words preserved (emitted as markers if not in vocab)
  it.each([
    ["WORSHIP"], ["WORSHIP 101"], ["STAGE"],
    ["COLLABORATION ROOM"], ["COLLABORATION ROOM 111"],
    ["CORRIDOR"], ["CORRIDOR W02"], ["STAIRS"],
    ["CONSOLE"], ["LOBBY"], ["SANCTUARY"],
    ["OFFICE"], ["RESTROOM"], ["KITCHEN"],
    ["STORAGE"], ["HALLWAY"], ["CONFERENCE"],
    ["CLASSROOM"], ["AUDITORIUM"], ["NORTH"],
    ["A103 — LOBBY"], ["UTIL/JAN/RISER"],
  ])("isCodeOnlyLocation('%s') === false", (input) => {
    expect(isCodeOnlyLocation(input)).toBe(false);
  });
});

// Regression: church plan vocabulary coverage for PATH A (Stage A bypass).
// These phrases are IN vocabulary → matched by Stage A → bypass Stage 6 entirely.
describe("church vocabulary — page-20 room labels reach Stage A (not Stage 6)", () => {
  const map = getRoomLabelMap("church");

  it.each([
    ["worship",       "SANCTUARY SIGN"],
    ["stage",         "AUDITORIUM SIGN"],
    ["collaboration", "CONFERENCE ROOM SIGN"],
    ["collab",        "CONFERENCE ROOM SIGN"],
    ["corridor",      "CORRIDOR SIGN"],
    ["stairs",        "STAIRWELL SIGN"],
    ["stairwell",     "STAIRWELL SIGN"],
    ["console",       "CONSOLE SIGN"],
    ["jan",           "JANITOR ROOM SIGN"],
    ["janitor",       "JANITOR ROOM SIGN"],
    ["riser",         "MECHANICAL ROOM SIGN"],
  ] as const)("map['%s'] === '%s'", (phrase, expectedSign) => {
    expect(map[phrase]).toBe(expectedSign);
  });

  // These callout codes are NOT in vocabulary → fall through to Stage 6 → suppressed
  it.each([
    ["a302"], ["a303"], ["a304"], ["a306"], ["a413"],
    ["a503"], ["a502"], ["a511"], ["c10"], ["w04"],
  ])("map['%s'] is undefined (not in vocabulary)", (code) => {
    expect(map[code]).toBeUndefined();
  });
});
