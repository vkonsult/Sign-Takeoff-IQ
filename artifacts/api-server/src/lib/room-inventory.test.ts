import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RoomRecord } from "./room-inventory";

// ── Module mocks (hoisted by Vitest before any imports) ───────────────────────

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: { models: { generateContent: vi.fn() } },
}));

vi.mock("./pdf-render", () => ({
  renderFloorPlanPages: vi.fn(),
}));

vi.mock("./storage", () => ({
  getFilePageImagesDir: vi.fn().mockReturnValue("/tmp/test-images"),
}));

vi.mock("@napi-rs/canvas", () => ({
  loadImage: vi.fn(),
  createCanvas: vi.fn(),
}));

vi.mock("./pdf-words", () => ({
  extractPagePhrases: vi.fn(),
  extractRawPageItems: vi.fn(),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── Imports of code under test ────────────────────────────────────────────────

import {
  deriveFlags,
  parseSlashLabel,
  isLikelyRoomName,
  isLikelyRoomNumber,
  cropRoomRegion,
  enrichAmbiguousRoomsWithAI,
  assignZoneQualifiersToRooms,
  detectGeometricStaffOnlyRestrooms,
} from "./room-inventory";
import type { ZoneAnchor } from "./room-inventory";

import { ai } from "@workspace/integrations-gemini-ai";
import { renderFloorPlanPages } from "./pdf-render";
import * as napiCanvas from "@napi-rs/canvas";

// ── Typed mock references ─────────────────────────────────────────────────────

const mockGenerateContent = vi.mocked(
  (ai as { models: { generateContent: (...args: unknown[]) => unknown } }).models
    .generateContent as (...args: unknown[]) => Promise<{ text: string }>,
);
const mockRenderFloorPlanPages = vi.mocked(renderFloorPlanPages);
const mockLoadImage = vi.mocked(napiCanvas.loadImage);
const mockCreateCanvas = vi.mocked(napiCanvas.createCanvas);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    roomNumber: null,
    roomName: "HOLDING",
    level: "1",
    pdfPage: 1,
    occupantLoad: null,
    occupancyGroup: null,
    isRestroom: false,
    isStair: false,
    isElevator: false,
    isVestibule: false,
    isCorridorOrHall: false,
    isVehicleBay: false,
    isMepUnoccupied: false,
    isVariableUse: false,
    isPublicFacing: false,
    isStaffOnly: false,
    isAssembly: false,
    isOffice: false,
    isSuite: false,
    boundingBox: null,
    extractionConfidence: 0.3,
    ...overrides,
  };
}

const DUMMY_AI_RESPONSE = (index: number) =>
  `[{"index":${index},"roomName":"OFFICE","roomType":"OFFICE","confidence":0.9}]`;

// ── deriveFlags ───────────────────────────────────────────────────────────────

describe("deriveFlags — stair detection", () => {
  it('sets isStair=true for "STAIR 1"', () => {
    const flags = deriveFlags("STAIR 1", null, null);
    expect(flags.isStair).toBe(true);
  });

  it('sets isStair=true for lowercase "stair a"', () => {
    const flags = deriveFlags("stair a", null, null);
    expect(flags.isStair).toBe(true);
  });

  it('sets isStair=false for a name that contains "stair" mid-word (e.g. "UPSTAIRS")', () => {
    const flags = deriveFlags("UPSTAIRS STORAGE", null, null);
    expect(flags.isStair).toBe(false);
  });
});

describe("deriveFlags — restroom detection", () => {
  it('sets isRestroom=true for "WOMEN\'S RESTROOM"', () => {
    const flags = deriveFlags("WOMEN'S RESTROOM", null, null);
    expect(flags.isRestroom).toBe(true);
  });

  it('sets isRestroom=true for "MEN\'S TOILET ROOM"', () => {
    const flags = deriveFlags("MEN'S TOILET ROOM", null, null);
    expect(flags.isRestroom).toBe(true);
  });

  it('sets isRestroom=true for "SHOWER ROOM"', () => {
    const flags = deriveFlags("SHOWER ROOM", null, null);
    expect(flags.isRestroom).toBe(true);
  });

  it('sets isRestroom=true for "LAVATORY"', () => {
    const flags = deriveFlags("LAVATORY", null, null);
    expect(flags.isRestroom).toBe(true);
  });

  it('sets isRestroom=false for "CONFERENCE"', () => {
    const flags = deriveFlags("CONFERENCE", null, null);
    expect(flags.isRestroom).toBe(false);
  });
});

describe("deriveFlags — elevator detection", () => {
  it('sets isElevator=true for "ELEVATOR LOBBY"', () => {
    const flags = deriveFlags("ELEVATOR LOBBY", null, null);
    expect(flags.isElevator).toBe(true);
  });

  it('sets isElevator=true for "ELEV MACHINE ROOM"', () => {
    const flags = deriveFlags("ELEV MACHINE ROOM", null, null);
    expect(flags.isElevator).toBe(true);
  });
});

describe("deriveFlags — HOLDING produces all flags false", () => {
  it("returns all flags false for a generic holding room with no occupant load", () => {
    const flags = deriveFlags("HOLDING", null, null);
    expect(flags.isRestroom).toBe(false);
    expect(flags.isStair).toBe(false);
    expect(flags.isElevator).toBe(false);
    expect(flags.isVestibule).toBe(false);
    expect(flags.isCorridorOrHall).toBe(false);
    expect(flags.isVehicleBay).toBe(false);
    expect(flags.isMepUnoccupied).toBe(false);
    expect(flags.isVariableUse).toBe(false);
    expect(flags.isPublicFacing).toBe(false);
    expect(flags.isStaffOnly).toBe(false);
    expect(flags.isAssembly).toBe(false);
  });
});

describe("deriveFlags — assembly flag", () => {
  it("sets isAssembly=true when occupantLoad >= 50", () => {
    const flags = deriveFlags("HOLDING", 50, null);
    expect(flags.isAssembly).toBe(true);
  });

  it("sets isAssembly=true when occupantLoad is well above 50", () => {
    const flags = deriveFlags("MULTIPURPOSE ROOM", 200, null);
    expect(flags.isAssembly).toBe(true);
  });

  it("sets isAssembly=false when occupantLoad is below 50", () => {
    const flags = deriveFlags("HOLDING", 49, null);
    expect(flags.isAssembly).toBe(false);
  });

  it("sets isAssembly=true when occupancyGroup matches A-2 pattern", () => {
    const flags = deriveFlags("HOLDING", null, "A-2");
    expect(flags.isAssembly).toBe(true);
  });

  it("sets isAssembly=true when occupancyGroup is 'A 3'", () => {
    const flags = deriveFlags("HOLDING", null, "A 3");
    expect(flags.isAssembly).toBe(true);
  });

  it("sets isAssembly=false when occupancyGroup is non-assembly (e.g. 'B')", () => {
    const flags = deriveFlags("HOLDING", null, "B");
    expect(flags.isAssembly).toBe(false);
  });

  it("sets isAssembly=false when occupantLoad is null and occupancyGroup is null", () => {
    const flags = deriveFlags("CONFERENCE ROOM", null, null);
    expect(flags.isAssembly).toBe(false);
  });
});

describe("deriveFlags — isMepUnoccupied", () => {
  it("sets isMepUnoccupied=true for MECHANICAL room with no occupant load", () => {
    const flags = deriveFlags("MECHANICAL", null, null);
    expect(flags.isMepUnoccupied).toBe(true);
  });

  it("sets isMepUnoccupied=false for MECHANICAL room with occupants", () => {
    const flags = deriveFlags("MECHANICAL", 10, null);
    expect(flags.isMepUnoccupied).toBe(false);
  });

  it("STORAGE CLOSET → isMepUnoccupied=false (storage rooms are occupied use, not MEP)", () => {
    const flags = deriveFlags("STORAGE CLOSET", 0, null);
    expect(flags.isMepUnoccupied).toBe(false);
  });

  it("plain STORAGE room → isMepUnoccupied=false (R15 hardening: storage ≠ MEP)", () => {
    const flags = deriveFlags("STORAGE", null, null);
    expect(flags.isMepUnoccupied).toBe(false);
  });

  it("MEZZANINE STORAGE → isMepUnoccupied=false (storage on mezzanine is still occupied use)", () => {
    const flags = deriveFlags("MEZZANINE STORAGE", null, null);
    expect(flags.isMepUnoccupied).toBe(false);
  });

  it("ELECTRICAL CLOSET → isMepUnoccupied=true (ELECTRICAL is a true MEP token)", () => {
    const flags = deriveFlags("ELECTRICAL CLOSET", null, null);
    expect(flags.isMepUnoccupied).toBe(true);
  });
});

describe("deriveFlags — collaboration/breakout room detection (Task 457)", () => {
  it("WORKSHOP STORAGE → isVariableUse=false (storage qualifier suppresses variable-use), isMepUnoccupied=false", () => {
    const flags = deriveFlags("WORKSHOP STORAGE", null, null);
    expect(flags.isVariableUse).toBe(false);
    expect(flags.isMepUnoccupied).toBe(false);
  });

  it("COLLABORATION ROOM → isVariableUse=true, isMepUnoccupied=false", () => {
    const flags = deriveFlags("COLLABORATION ROOM", null, null);
    expect(flags.isVariableUse).toBe(true);
    expect(flags.isMepUnoccupied).toBe(false);
  });

  it("WORKSHOP → isVariableUse=true (no storage qualifier)", () => {
    const flags = deriveFlags("WORKSHOP", null, null);
    expect(flags.isVariableUse).toBe(true);
  });

  it("BREAKOUT CLOSET → isVariableUse=false (storage qualifier overrides collaboration), isMepUnoccupied=false", () => {
    const flags = deriveFlags("BREAKOUT CLOSET", null, null);
    expect(flags.isVariableUse).toBe(false);
    expect(flags.isMepUnoccupied).toBe(false);
  });

  it("COLLAB STORAGE → isVariableUse=false", () => {
    const flags = deriveFlags("COLLAB STORAGE", null, null);
    expect(flags.isVariableUse).toBe(false);
  });

  it("HUDDLE ROOM → isVariableUse=true", () => {
    const flags = deriveFlags("HUDDLE ROOM", null, null);
    expect(flags.isVariableUse).toBe(true);
  });

  it("WORKSHOPPING → isVariableUse=false (partial word, whole-word matching required)", () => {
    const flags = deriveFlags("WORKSHOPPING", null, null);
    expect(flags.isVariableUse).toBe(false);
  });

  it("COLLABORATIVE SPACE → isVariableUse=true", () => {
    const flags = deriveFlags("COLLABORATIVE SPACE", null, null);
    expect(flags.isVariableUse).toBe(true);
  });
});

// ── parseSlashLabel ───────────────────────────────────────────────────────────

describe("parseSlashLabel — room label parsing", () => {
  it('parses "CONFERENCE / 201" into name=CONFERENCE and number=201', () => {
    const result = parseSlashLabel("CONFERENCE / 201");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("CONFERENCE");
    expect(result!.number).toBe("201");
  });

  it('parses "SERVER ROOM/B-105" without spaces around slash', () => {
    const result = parseSlashLabel("SERVER ROOM/B-105");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("SERVER ROOM");
    expect(result!.number).toBe("B-105");
  });

  it("upcases both name and number", () => {
    const result = parseSlashLabel("lobby / 101a");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("LOBBY");
    expect(result!.number).toBe("101A");
  });

  it("returns null when there is no slash", () => {
    expect(parseSlashLabel("CONFERENCE ROOM")).toBeNull();
  });

  it("returns null when the name portion is too short (< 2 chars)", () => {
    expect(parseSlashLabel("X / 201")).toBeNull();
  });
});

// ── isLikelyRoomName — dimension filtering ────────────────────────────────────

describe("isLikelyRoomName — dimension text is rejected", () => {
  const TYPICAL_HEIGHT = 10;

  it('rejects "10\'-0\\"" (feet-inches dimension)', () => {
    expect(isLikelyRoomName("10'-0\"", TYPICAL_HEIGHT)).toBe(false);
  });

  it('rejects "8\'" (feet-only dimension)', () => {
    expect(isLikelyRoomName("8'", TYPICAL_HEIGHT)).toBe(false);
  });

  it('rejects "1/4" = (scale notation)', () => {
    expect(isLikelyRoomName('1/4 =', TYPICAL_HEIGHT)).toBe(false);
  });

  it("rejects a pure integer string", () => {
    expect(isLikelyRoomName("201", TYPICAL_HEIGHT)).toBe(false);
  });

  it("rejects a drawing-reference like A-101", () => {
    expect(isLikelyRoomName("A-101", TYPICAL_HEIGHT)).toBe(false);
  });

  it("accepts a normal room name like CONFERENCE", () => {
    expect(isLikelyRoomName("CONFERENCE", TYPICAL_HEIGHT)).toBe(true);
  });

  it("accepts a multi-word room name like WOMEN'S RESTROOM", () => {
    expect(isLikelyRoomName("WOMEN'S RESTROOM", TYPICAL_HEIGHT)).toBe(true);
  });

  it("rejects text with font height outside 4–20 pts", () => {
    expect(isLikelyRoomName("LOBBY", 2)).toBe(false);
    expect(isLikelyRoomName("LOBBY", 25)).toBe(false);
  });

  it("rejects a room-number-formatted string (reserved for number candidates)", () => {
    expect(isLikelyRoomName("B-201", TYPICAL_HEIGHT)).toBe(false);
  });
});

// ── isLikelyRoomNumber ────────────────────────────────────────────────────────

describe("isLikelyRoomNumber", () => {
  it('accepts "120"', () => {
    expect(isLikelyRoomNumber("120")).toBe(true);
  });

  it('accepts "B-201"', () => {
    expect(isLikelyRoomNumber("B-201")).toBe(true);
  });

  it('accepts "A103"', () => {
    expect(isLikelyRoomNumber("A103")).toBe(true);
  });

  it('accepts "101A"', () => {
    expect(isLikelyRoomNumber("101A")).toBe(true);
  });

  it('rejects a plain word like "LOBBY"', () => {
    expect(isLikelyRoomNumber("LOBBY")).toBe(false);
  });

  it('rejects a single digit "5"', () => {
    expect(isLikelyRoomNumber("5")).toBe(false);
  });
});

// ── cropRoomRegion ────────────────────────────────────────────────────────────

describe("cropRoomRegion — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the image file does not exist (loadImage throws)", async () => {
    mockLoadImage.mockRejectedValueOnce(new Error("ENOENT: no such file"));

    const result = await cropRoomRegion("/nonexistent/path.png", {
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.2,
    });

    expect(result).toBeNull();
  });

  it("returns null when the calculated crop dimensions are too small (< 4 px)", async () => {
    mockLoadImage.mockResolvedValueOnce({ width: 2, height: 2 });

    const result = await cropRoomRegion("/some/page.png", {
      x: 0,
      y: 0,
      w: 0.5,
      h: 0.5,
    });

    expect(result).toBeNull();
  });

  it("returns null when bbox has out-of-range values (negative width/height)", async () => {
    mockLoadImage.mockResolvedValueOnce({ width: 1000, height: 800 });

    const result = await cropRoomRegion("/some/page.png", {
      x: 0.5,
      y: 0.5,
      w: -0.2,
      h: -0.2,
    });

    expect(result).toBeNull();
  });

  it("returns a non-empty base64 string for a valid image and bbox", async () => {
    mockLoadImage.mockResolvedValueOnce({ width: 1000, height: 800 });

    const fakeBuffer = Buffer.from("fake-png-data");
    const mockCtx = { drawImage: vi.fn() };
    const mockCanvas = {
      getContext: vi.fn().mockReturnValue(mockCtx),
      encode: vi.fn().mockResolvedValue(fakeBuffer),
    };
    mockCreateCanvas.mockReturnValueOnce(mockCanvas as unknown as ReturnType<typeof mockCreateCanvas>);

    const result = await cropRoomRegion("/some/valid-page.png", {
      x: 0.1,
      y: 0.1,
      w: 0.1,
      h: 0.1,
    });

    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
    expect(result).toBe(fakeBuffer.toString("base64"));
  });
});

// ── enrichAmbiguousRoomsWithAI — prompt branch selection ─────────────────────

describe("enrichAmbiguousRoomsWithAI — text-only prompt when pdfPath is absent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Gemini with a single text part and no inlineData when pdfPath is not provided", async () => {
    const room = makeRoom({ roomName: "HQ", extractionConfidence: 0.3 });

    mockGenerateContent.mockResolvedValueOnce({ text: DUMMY_AI_RESPONSE(0) });

    await enrichAmbiguousRoomsWithAI([room], "file-1", "job-1");

    expect(mockGenerateContent).toHaveBeenCalledOnce();
    const call = mockGenerateContent.mock.calls[0]![0] as {
      contents: { role: string; parts: unknown[] }[];
    };
    const parts = call.contents[0]!.parts as unknown[];

    const hasInlineData = parts.some(
      (p) => typeof p === "object" && p !== null && "inlineData" in p,
    );
    expect(hasInlineData).toBe(false);
    expect(parts.length).toBe(1);
    expect((parts[0] as { text: string }).text).toContain("Rooms to classify");
  });
});

describe("enrichAmbiguousRoomsWithAI — multimodal prompt when pdfPath is provided and crop succeeds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a multimodal prompt with inlineData when a room has a bbox and crop returns base64", async () => {
    const room = makeRoom({
      roomName: "EQ",
      extractionConfidence: 0.3,
      pdfPage: 2,
      boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });

    mockRenderFloorPlanPages.mockResolvedValueOnce(
      new Map([[2, "/tmp/test-images/page-2.png"]]),
    );

    mockLoadImage.mockResolvedValueOnce({ width: 1000, height: 800 });
    const fakeBuffer = Buffer.from("png-bytes");
    const mockCtx = { drawImage: vi.fn() };
    const mockCanvas = {
      getContext: vi.fn().mockReturnValue(mockCtx),
      encode: vi.fn().mockResolvedValue(fakeBuffer),
    };
    mockCreateCanvas.mockReturnValueOnce(
      mockCanvas as unknown as ReturnType<typeof mockCreateCanvas>,
    );

    mockGenerateContent.mockResolvedValueOnce({ text: DUMMY_AI_RESPONSE(0) });

    await enrichAmbiguousRoomsWithAI([room], "file-2", "job-2", "/path/to/plan.pdf");

    expect(mockGenerateContent).toHaveBeenCalledOnce();
    const call = mockGenerateContent.mock.calls[0]![0] as {
      contents: { role: string; parts: unknown[] }[];
    };
    const parts = call.contents[0]!.parts as unknown[];

    const inlineDataParts = parts.filter(
      (p) => typeof p === "object" && p !== null && "inlineData" in p,
    );
    expect(inlineDataParts.length).toBeGreaterThan(0);
    expect(
      (inlineDataParts[0] as { inlineData: { mimeType: string; data: string } }).inlineData
        .mimeType,
    ).toBe("image/png");
    expect(
      (inlineDataParts[0] as { inlineData: { mimeType: string; data: string } }).inlineData.data,
    ).toBe(fakeBuffer.toString("base64"));
  });
});

describe("enrichAmbiguousRoomsWithAI — text-only fallback when pdfPath is given but crop returns null", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses text-only prompt when crop returns null even though pdfPath and bbox are provided", async () => {
    const room = makeRoom({
      roomName: "XZ",
      extractionConfidence: 0.3,
      pdfPage: 3,
      boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    });

    mockRenderFloorPlanPages.mockResolvedValueOnce(
      new Map([[3, "/tmp/test-images/page-3.png"]]),
    );

    mockLoadImage.mockResolvedValueOnce({ width: 2, height: 2 });

    mockGenerateContent.mockResolvedValueOnce({ text: DUMMY_AI_RESPONSE(0) });

    await enrichAmbiguousRoomsWithAI([room], "file-4", "job-4", "/path/to/plan.pdf");

    expect(mockGenerateContent).toHaveBeenCalledOnce();
    const call = mockGenerateContent.mock.calls[0]![0] as {
      contents: { role: string; parts: unknown[] }[];
    };
    const parts = call.contents[0]!.parts as unknown[];

    const hasInlineData = parts.some(
      (p) => typeof p === "object" && p !== null && "inlineData" in p,
    );
    expect(hasInlineData).toBe(false);
  });
});

describe("enrichAmbiguousRoomsWithAI — text-only fallback when pdfPath is given but no bbox available", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses text-only prompt when pdfPath is set but the room has no boundingBox", async () => {
    const room = makeRoom({
      roomName: "XY",
      extractionConfidence: 0.3,
      boundingBox: null,
    });

    mockGenerateContent.mockResolvedValueOnce({ text: DUMMY_AI_RESPONSE(0) });

    await enrichAmbiguousRoomsWithAI([room], "file-3", "job-3", "/path/to/plan.pdf");

    expect(mockRenderFloorPlanPages).not.toHaveBeenCalled();

    expect(mockGenerateContent).toHaveBeenCalledOnce();
    const call = mockGenerateContent.mock.calls[0]![0] as {
      contents: { role: string; parts: unknown[] }[];
    };
    const parts = call.contents[0]!.parts as unknown[];

    const hasInlineData = parts.some(
      (p) => typeof p === "object" && p !== null && "inlineData" in p,
    );
    expect(hasInlineData).toBe(false);
  });
});

// ── assignZoneQualifiersToRooms ───────────────────────────────────────────────

describe("assignZoneQualifiersToRooms — centroid-based zone label assignment", () => {
  const bbox = (x: number, y: number, w = 50, h = 20) => ({ x, y, w, h });
  const anchor = (text: string, x: number, y: number, w = 200, h = 30): ZoneAnchor => ({
    text,
    pdfPage: 1,
    x,
    y,
    w,
    h,
  });

  it("assigns nearest anchor when room centroid is within 2× anchor dimension", () => {
    const room = makeRoom({ boundingBox: bbox(100, 100), pdfPage: 1 });
    const zone = anchor("AREA A", 80, 80);
    assignZoneQualifiersToRooms([room], [zone]);
    expect(room.zoneQualifier).toBe("AREA A");
  });

  it("does not assign when room centroid is too far from anchor", () => {
    const room = makeRoom({ boundingBox: bbox(900, 900), pdfPage: 1 });
    const zone = anchor("AREA A", 0, 0, 10, 10);
    assignZoneQualifiersToRooms([room], [zone]);
    expect(room.zoneQualifier).toBeUndefined();
  });

  it("does not assign anchor from a different page", () => {
    const room = makeRoom({ boundingBox: bbox(100, 100), pdfPage: 1 });
    const zone: ZoneAnchor = { text: "AREA B", pdfPage: 2, x: 100, y: 100, w: 200, h: 30 };
    assignZoneQualifiersToRooms([room], [zone]);
    expect(room.zoneQualifier).toBeUndefined();
  });

  it("assigns closest anchor when multiple anchors are present", () => {
    const room = makeRoom({ boundingBox: bbox(100, 100), pdfPage: 1 });
    const close = anchor("CLOSE ZONE", 90, 90, 200, 30);
    const far = anchor("FAR ZONE", 500, 500, 200, 30);
    assignZoneQualifiersToRooms([room], [close, far]);
    expect(room.zoneQualifier).toBe("CLOSE ZONE");
  });

  it("skips rooms without a boundingBox", () => {
    const room = makeRoom({ boundingBox: null, pdfPage: 1 });
    const zone = anchor("AREA A", 0, 0);
    assignZoneQualifiersToRooms([room], [zone]);
    expect(room.zoneQualifier).toBeUndefined();
  });

  it("multi-room multi-zone fixture: each room gets the nearest in-radius anchor, out-of-radius rooms get none", () => {
    // Layout (page 1):
    //   AREA A anchor centred at (200, 150), 200×30 → radius = 2×200 = 400
    //   AREA B anchor centred at (700, 150), 180×30 → radius = 2×180 = 360
    //
    //   Room A (centroid 200,150) → distance 0 to AREA A → assigned AREA A
    //   Room B (centroid 680,150) → distance 20 to AREA B → assigned AREA B
    //   Room C (centroid 2000,2000) → outside both radii → no assignment
    //   Room D (pdfPage 2)        → different page → no assignment

    const areaA = anchor("AREA A", 100, 135, 200, 30); // centroid (200,150)
    const areaB = anchor("AREA B", 610, 135, 180, 30); // centroid (700,150)

    const roomA = makeRoom({ boundingBox: bbox(175, 140), pdfPage: 1 }); // centroid (200,150)
    const roomB = makeRoom({ boundingBox: bbox(655, 140), pdfPage: 1 }); // centroid (680,150)
    const roomC = makeRoom({ boundingBox: bbox(1975, 1990), pdfPage: 1 }); // too far
    const roomD = makeRoom({ boundingBox: bbox(200, 150), pdfPage: 2 });  // wrong page

    assignZoneQualifiersToRooms([roomA, roomB, roomC, roomD], [areaA, areaB]);

    expect(roomA.zoneQualifier).toBe("AREA A");
    expect(roomB.zoneQualifier).toBe("AREA B");
    expect(roomC.zoneQualifier).toBeUndefined();
    expect(roomD.zoneQualifier).toBeUndefined();
  });
});

// ── detectGeometricStaffOnlyRestrooms ────────────────────────────────────────

describe("detectGeometricStaffOnlyRestrooms — K-nearest spatial detection", () => {
  const bbox = (x: number, y: number) => ({ x, y, w: 50, h: 20 });

  it("classifies restroom as staff-only when all nearest rooms are offices", () => {
    const restroom = makeRoom({ roomName: "RESTROOM", isRestroom: true, isPublicFacing: true, boundingBox: bbox(100, 100), pdfPage: 1 });
    const office1 = makeRoom({ roomName: "OFFICE 1", isOffice: true, boundingBox: bbox(120, 100), pdfPage: 1 });
    const office2 = makeRoom({ roomName: "OFFICE 2", isOffice: true, boundingBox: bbox(80, 100), pdfPage: 1 });
    const rooms = [restroom, office1, office2];
    detectGeometricStaffOnlyRestrooms(rooms);
    expect(restroom.isStaffOnly).toBe(true);
    expect(restroom.isPublicFacing).toBe(false);
  });

  it("does NOT classify restroom as staff-only when a public lobby is nearby", () => {
    const restroom = makeRoom({ roomName: "RESTROOM", isRestroom: true, isPublicFacing: true, boundingBox: bbox(100, 100), pdfPage: 1 });
    const lobby = makeRoom({ roomName: "LOBBY", isPublicFacing: true, boundingBox: bbox(110, 100), pdfPage: 1 });
    const office = makeRoom({ roomName: "OFFICE", isOffice: true, boundingBox: bbox(90, 100), pdfPage: 1 });
    const rooms = [restroom, lobby, office];
    detectGeometricStaffOnlyRestrooms(rooms);
    expect(restroom.isStaffOnly).toBe(false);
    expect(restroom.isPublicFacing).toBe(true);
  });

  it("skips already-classified staff-only restrooms", () => {
    const restroom = makeRoom({ roomName: "EMPLOYEE RESTROOM", isRestroom: true, isStaffOnly: true, boundingBox: bbox(100, 100), pdfPage: 1 });
    const lobby = makeRoom({ roomName: "LOBBY", isPublicFacing: true, boundingBox: bbox(105, 100), pdfPage: 1 });
    detectGeometricStaffOnlyRestrooms([restroom, lobby]);
    expect(restroom.isStaffOnly).toBe(true);
  });

  it("skips rooms without bounding box", () => {
    const restroom = makeRoom({ roomName: "RESTROOM", isRestroom: true, boundingBox: null, pdfPage: 1 });
    const office = makeRoom({ roomName: "OFFICE", isOffice: true, boundingBox: bbox(100, 100), pdfPage: 1 });
    detectGeometricStaffOnlyRestrooms([restroom, office]);
    expect(restroom.isStaffOnly).toBe(false);
  });
});
