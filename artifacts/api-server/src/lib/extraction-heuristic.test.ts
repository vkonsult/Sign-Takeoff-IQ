import { describe, it, expect } from "vitest";
import { isNoisyPhrase } from "./extraction-heuristic";

describe("isNoisyPhrase — length cap at 17 chars", () => {
  it.each([
    ["OFFICE"],
    ["CONF"],
    ["ART ROOM"],
    ["STAIR A"],
    ["DIRECTOR'S OFFICE"],
    ["MECHANICAL ROOM"],
    ["WOMEN'S RESTROOM"],
    ["PHYSICAL THERAPY"],
  ])("passes legitimate room label '%s'", (label) => {
    expect(isNoisyPhrase(label)).toBe(false);
  });

  it.each([
    ["COLLABORATION ROOM"],
    ["NATIONAL FIRE PROTECTION (NFPA) STANDARDS"],
    ["SHEARWALL TYPE SCHEDULE"],
    ["BOTTOM PLATE ATTACHMENT ATTACHMENT ATTACHMENT"],
  ])("rejects over-length string '%s'", (label) => {
    expect(isNoisyPhrase(label)).toBe(true);
  });

  it("passes exactly 17-char label (boundary)", () => {
    expect("DIRECTOR'S OFFICE".length).toBe(17);
    expect(isNoisyPhrase("DIRECTOR'S OFFICE")).toBe(false);
  });

  it("rejects 18-char label (one over boundary)", () => {
    expect("COLLABORATION ROOM".length).toBe(18);
    expect(isNoisyPhrase("COLLABORATION ROOM")).toBe(true);
  });
});

describe("isNoisyPhrase — parenthesis filters", () => {
  it.each([
    ["(A-3) ASSEMBLY / LIBRARY (STACKS)"],
    ["(INCHES)"],
    ["(ABOVE CEILING)"],
    ["(EXISTING GWB PARTITION)"],
    ["(3 PER BENCH) OF"],
    ["(B)"],
    ["(S-1)"],
  ])("rejects string starting with '(': '%s'", (phrase) => {
    expect(isNoisyPhrase(phrase)).toBe(true);
  });

  it.each([
    ["CMU)"],
    ["OF STAIRS)"],
    ["THICK CMU)"],
  ])("rejects fragment with mismatched ')': '%s'", (phrase) => {
    expect(isNoisyPhrase(phrase)).toBe(true);
  });

  it.each([
    ["(EXISTING GWB)"],
    ["WALL (EXISTING)"],
  ])("rejects string containing '(EXISTING)': '%s'", (phrase) => {
    expect(isNoisyPhrase(phrase)).toBe(true);
  });
});

describe("isNoisyPhrase — slash compound labels preserved", () => {
  it.each([
    ["OFFICE/CONF"],
    ["UTL/JAN"],
    ["UTL/JAN/RISER"],
    ["STOR/MECH"],
  ])("passes slash-compound label '%s'", (label) => {
    expect(isNoisyPhrase(label)).toBe(false);
  });

  it.each([
    ["1/4"],
    ["3/8"],
    ["1/2"],
  ])("still rejects digit/digit fraction '%s'", (label) => {
    expect(isNoisyPhrase(label)).toBe(true);
  });
});
