import { describe, it, expect } from "vitest";
import { parseRoomHeading, type RawTextItem } from "./signage-schedule-parser";

/**
 * Minimal RawTextItem helper — only `text` matters for parseRoomHeading;
 * positional fields are irrelevant to the logic under test.
 */
function item(text: string): RawTextItem {
  return { text, x: 0, y: 0, w: 100, h: 12 };
}

/** Build a single-line TextLine (RawTextItem[]) from a sequence of strings. */
function line(...words: string[]): RawTextItem[] {
  return words.map(item);
}

// ── Case 3: pure-text room headings (no digit tokens, abbreviations/keywords) ─

describe("parseRoomHeading — Case 3: pure-text room headings", () => {
  it("recognises 'WRR' as a room heading (known abbreviation)", () => {
    const result = parseRoomHeading(line("WRR"));
    expect(result).not.toBeNull();
    expect(result!.roomNumber).toBe("WRR");
    expect(result!.roomName).toBe("WRR");
  });

  it("recognises 'MRR' as a room heading (known abbreviation)", () => {
    const result = parseRoomHeading(line("MRR"));
    expect(result).not.toBeNull();
    expect(result!.roomNumber).toBe("MRR");
    expect(result!.roomName).toBe("MRR");
  });

  it("recognises 'COLLABORATION ROOM' as a room heading (keyword prefix)", () => {
    const result = parseRoomHeading(line("COLLABORATION", "ROOM"));
    expect(result).not.toBeNull();
    expect(result!.roomNumber).toBe("COLLABORATION ROOM");
    expect(result!.roomName).toBe("COLLABORATION ROOM");
  });

  it("recognises 'COLLAB' as a room heading (keyword prefix abbreviation)", () => {
    const result = parseRoomHeading(line("COLLAB"));
    expect(result).not.toBeNull();
    expect(result!.roomName).toBe("COLLAB");
  });

  it("recognises 'CONFERENCE ROOM' as a room heading (keyword prefix)", () => {
    const result = parseRoomHeading(line("CONFERENCE", "ROOM"));
    expect(result).not.toBeNull();
    expect(result!.roomNumber).toBe("CONFERENCE ROOM");
    expect(result!.roomName).toBe("CONFERENCE ROOM");
  });

  it("recognises 'WOMEN\\'S RESTROOM' as a room heading (keyword prefix with apostrophe)", () => {
    const result = parseRoomHeading(line("WOMEN'S", "RESTROOM"));
    expect(result).not.toBeNull();
    expect(result!.roomName).toBe("WOMEN'S RESTROOM");
  });

  it("recognises 'RESTROOM' alone as a room heading", () => {
    const result = parseRoomHeading(line("RESTROOM"));
    expect(result).not.toBeNull();
    expect(result!.roomName).toBe("RESTROOM");
  });

  it("recognises lower-case 'wrr' as a room heading (case-insensitive known abbreviation)", () => {
    const result = parseRoomHeading(line("wrr"));
    expect(result).not.toBeNull();
  });

  // ── Rejection guards ────────────────────────────────────────────────────────

  it("returns null for an empty line", () => {
    expect(parseRoomHeading([])).toBeNull();
  });

  it("returns null for a line whose only token is whitespace", () => {
    expect(parseRoomHeading([item("   ")])).toBeNull();
  });

  it("returns null when the line has more than 4 tokens (too long to be a pure-text heading)", () => {
    const result = parseRoomHeading(
      line("CONFERENCE", "ROOM", "LEVEL", "TWO", "NORTH"),
    );
    expect(result).toBeNull();
  });

  it("returns null for an unknown single alpha word not in the abbreviation or keyword sets", () => {
    const result = parseRoomHeading(line("XYZZY"));
    expect(result).toBeNull();
  });

  it("returns null for a sign-row pattern: sign-type code followed immediately by a digit token (Guard A in Case 3-fallthrough)", () => {
    // "RESTROOM 2" — first is alphabetic and in PURE_TEXT_ROOM_TYPE_KEYWORDS,
    // but "2" breaks allAlphaOnly, so Case 3 is never entered.
    // Falls to Case 2 where "RESTROOM" doesn't match ROOM_NUMBER_RE → null.
    const result = parseRoomHeading(line("RESTROOM", "2"));
    expect(result).toBeNull();
  });
});

// ── Case 1: location-keyword prefix (UNIT, SUITE, ROOM …) ────────────────────

describe("parseRoomHeading — Case 1: location keyword prefix", () => {
  it("recognises 'UNIT 1C' as a room heading", () => {
    const result = parseRoomHeading(line("UNIT", "1C"));
    expect(result).not.toBeNull();
    expect(result!.roomNumber).toBe("1C");
    expect(result!.roomName).toBe("UNIT 1C");
  });

  it("recognises 'SUITE 2B' as a room heading", () => {
    const result = parseRoomHeading(line("SUITE", "2B"));
    expect(result).not.toBeNull();
    expect(result!.roomNumber).toBe("2B");
  });

  it("returns null when second token is a plain word (not a room code)", () => {
    // "ROOM LOBBY" — second token has no digit, so not room-code-like
    const result = parseRoomHeading(line("ROOM", "LOBBY"));
    expect(result).toBeNull();
  });
});

// ── Case 2: numeric room-number prefix ───────────────────────────────────────

describe("parseRoomHeading — Case 2: numeric room-number prefix", () => {
  it("recognises '101' alone as a room heading", () => {
    const result = parseRoomHeading(line("101"));
    expect(result).not.toBeNull();
    expect(result!.roomNumber).toBe("101");
  });

  it("recognises '101 LOBBY' as a room heading", () => {
    const result = parseRoomHeading(line("101", "LOBBY"));
    expect(result).not.toBeNull();
    expect(result!.roomNumber).toBe("101");
    expect(result!.roomName).toBe("101 LOBBY");
  });

  it("returns null for a sign row: room-number, sign-code, quantity pattern", () => {
    // "101 1A 2" — Guard B rejects: first=room_number, second=sign_code, third=quantity
    const result = parseRoomHeading(line("101", "1A", "2"));
    expect(result).toBeNull();
  });
});
