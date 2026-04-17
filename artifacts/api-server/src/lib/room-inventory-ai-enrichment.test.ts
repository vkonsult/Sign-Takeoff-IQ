/**
 * Tests for enrichAmbiguousRoomsWithAI — verifying that the MAX_VISUAL_CROPS
 * (20) per-request cap is enforced through batching: when more than 20
 * ambiguous rooms are present the function splits them into sequential Gemini
 * calls of at most 20, ensuring every room receives a visual crop.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import type { RoomRecord } from "./room-inventory";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: {
    models: {
      generateContent: vi.fn(),
    },
  },
}));

vi.mock("./pdf-render", () => ({
  renderFloorPlanPages: vi.fn(),
}));

vi.mock("./storage", () => ({
  getFilePageImagesDir: vi.fn(() => "/fake/images"),
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Imports resolved after mocks ──────────────────────────────────────────────

import { enrichAmbiguousRoomsWithAI } from "./room-inventory";
import { ai } from "@workspace/integrations-gemini-ai";
import { renderFloorPlanPages } from "./pdf-render";
import { logger } from "./logger";

// ── Synthetic floor-plan PNG ──────────────────────────────────────────────────
//
// vitest cannot intercept `await import("@napi-rs/canvas")` inside production
// code for native modules, so we let the real canvas run on a synthetic PNG
// that we generate once per test run.

let testPngPath: string;

beforeAll(async () => {
  const canvas = createCanvas(200, 200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 200, 200);
  const pngBuffer = await canvas.encode("png");

  testPngPath = path.join(os.tmpdir(), "room-inventory-ai-enrichment-test.png");
  await fs.writeFile(testPngPath, pngBuffer);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const NO_FLAGS = {
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
};

/**
 * Creates an ambiguous RoomRecord.
 * extractionConfidence < 0.5 ensures isAmbiguousRoom() returns true regardless
 * of name length or flag state. boundingBox is set so crop attempts are made.
 */
function makeAmbiguousRoom(
  roomName: string,
  overrides: Partial<RoomRecord> = {},
): RoomRecord {
  return {
    roomNumber: null,
    roomName,
    level: "1",
    pdfPage: 1,
    occupantLoad: null,
    occupancyGroup: null,
    ...NO_FLAGS,
    boundingBox: { x: 0.1, y: 0.1, w: 0.05, h: 0.05 },
    extractionConfidence: 0.3,
    aiEnriched: false,
    ...overrides,
  };
}

/** Minimal valid Gemini response — empty array means no enrichments applied. */
const EMPTY_GEMINI_RESPONSE = { text: "[]" };

/**
 * Counts the number of inlineData parts across a single Gemini call's parts array.
 */
function countImageParts(parts: Array<Record<string, unknown>>): number {
  return parts.filter((p) => "inlineData" in p).length;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enrichAmbiguousRoomsWithAI — per-request image cap via batching", () => {
  beforeEach(() => {
    vi.mocked(ai.models.generateContent).mockReset().mockResolvedValue(EMPTY_GEMINI_RESPONSE);
    vi.mocked(renderFloorPlanPages).mockReset().mockResolvedValue(
      new Map([[1, testPngPath]]),
    );
    vi.mocked(logger.warn).mockReset();
    vi.mocked(logger.info).mockReset();
  });

  it("makes 2 Gemini calls when 25 ambiguous rooms exceed the 20-crop per-request limit", async () => {
    const rooms: RoomRecord[] = Array.from({ length: 25 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-1", "job-1", "/fake/plan.pdf");

    expect(vi.mocked(ai.models.generateContent)).toHaveBeenCalledTimes(2);
  });

  it("first batch contains exactly 20 inline image crops when 25 rooms are present", async () => {
    const rooms: RoomRecord[] = Array.from({ length: 25 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-2", "job-2", "/fake/plan.pdf");

    const firstCallParts = vi.mocked(ai.models.generateContent).mock.calls[0]![0]
      .contents[0]!.parts as Array<Record<string, unknown>>;

    expect(countImageParts(firstCallParts)).toBe(20);
  });

  it("second batch contains the remaining 5 inline image crops when 25 rooms are present", async () => {
    const rooms: RoomRecord[] = Array.from({ length: 25 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-3", "job-3", "/fake/plan.pdf");

    const secondCallParts = vi.mocked(ai.models.generateContent).mock.calls[1]![0]
      .contents[0]!.parts as Array<Record<string, unknown>>;

    expect(countImageParts(secondCallParts)).toBe(5);
  });

  it("no individual Gemini call receives more than 20 inline image crops", async () => {
    const rooms: RoomRecord[] = Array.from({ length: 45 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-4", "job-4", "/fake/plan.pdf");

    const mockFn = vi.mocked(ai.models.generateContent);
    for (const call of mockFn.mock.calls) {
      const parts = call[0].contents[0]!.parts as Array<Record<string, unknown>>;
      expect(countImageParts(parts)).toBeLessThanOrEqual(20);
    }
  });

  it("every ambiguous room index appears across all batched Gemini calls — no room is silently dropped", async () => {
    const TOTAL = 25;
    const rooms: RoomRecord[] = Array.from({ length: TOTAL }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-4b", "job-4b", "/fake/plan.pdf");

    const mockFn = vi.mocked(ai.models.generateContent);

    // Collect all room indices referenced across every batch prompt
    const mentionedIndices = new Set<number>();
    for (const call of mockFn.mock.calls) {
      const parts = call[0].contents[0]!.parts as Array<Record<string, unknown>>;
      for (const part of parts) {
        if ("text" in part) {
          const text = part.text as string;
          // Each room entry text is: `Room entry (index N): "..."`
          const matches = text.matchAll(/Room entry \(index (\d+)\)/g);
          for (const m of matches) {
            mentionedIndices.add(Number(m[1]));
          }
        }
      }
    }

    // All original room indices (0 … TOTAL-1) must be present
    for (let i = 0; i < TOTAL; i++) {
      expect(mentionedIndices).toContain(i);
    }
  });

  it("makes exactly 1 Gemini call when the room count is at the per-call limit", async () => {
    const rooms: RoomRecord[] = Array.from({ length: 20 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-5", "job-5", "/fake/plan.pdf");

    expect(vi.mocked(ai.models.generateContent)).toHaveBeenCalledTimes(1);
  });

  it("all 20 rooms receive a visual crop when the count is exactly at the limit", async () => {
    const rooms: RoomRecord[] = Array.from({ length: 20 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-6", "job-6", "/fake/plan.pdf");

    const parts = vi.mocked(ai.models.generateContent).mock.calls[0]![0]
      .contents[0]!.parts as Array<Record<string, unknown>>;

    expect(countImageParts(parts)).toBe(20);
  });
});

describe("enrichAmbiguousRoomsWithAI — batch progress logging", () => {
  beforeEach(() => {
    vi.mocked(ai.models.generateContent).mockReset().mockResolvedValue(EMPTY_GEMINI_RESPONSE);
    vi.mocked(renderFloorPlanPages).mockReset().mockResolvedValue(
      new Map([[1, testPngPath]]),
    );
    vi.mocked(logger.info).mockReset();
  });

  it("emits a logger.info batch-progress message for each batch when rooms exceed the per-call limit", async () => {
    const rooms: RoomRecord[] = Array.from({ length: 25 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-7", "job-7", "/fake/plan.pdf");

    const infoCalls = vi.mocked(logger.info).mock.calls as Array<[unknown, string]>;
    const batchLogs = infoCalls.filter(([, msg]) =>
      typeof msg === "string" && msg.includes("Processing AI enrichment batch"),
    );

    // 25 rooms → 2 batches → 2 progress log entries
    expect(batchLogs.length).toBe(2);
  });

  it("does NOT emit batch-progress logs when all rooms fit in a single call", async () => {
    const rooms: RoomRecord[] = Array.from({ length: 15 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-8", "job-8", "/fake/plan.pdf");

    const infoCalls = vi.mocked(logger.info).mock.calls as Array<[unknown, string]>;
    const batchLogs = infoCalls.filter(([, msg]) =>
      typeof msg === "string" && msg.includes("Processing AI enrichment batch"),
    );

    expect(batchLogs.length).toBe(0);
  });
});
