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

describe("enrichAmbiguousRoomsWithAI — unparseable Gemini response telemetry", () => {
  beforeEach(() => {
    vi.mocked(ai.models.generateContent).mockReset();
    vi.mocked(renderFloorPlanPages).mockReset().mockResolvedValue(
      new Map([[1, testPngPath]]),
    );
    vi.mocked(logger.warn).mockReset();
  });

  it("emits logger.warn with reason: 'no_json_array' when Gemini returns a response with no JSON array", async () => {
    vi.mocked(ai.models.generateContent).mockResolvedValue({ text: "Sorry, I cannot help with that." });

    const rooms: RoomRecord[] = [makeAmbiguousRoom("OFFICE")];

    await enrichAmbiguousRoomsWithAI(rooms, "file-x", "job-x", "/fake/plan.pdf");

    const warnCalls = vi.mocked(logger.warn).mock.calls as Array<[unknown, string]>;
    const noJsonWarn = warnCalls.find(
      ([fields, msg]) =>
        typeof msg === "string" &&
        msg.includes("no JSON array") &&
        (fields as Record<string, unknown>).reason === "no_json_array",
    );

    expect(noJsonWarn).toBeDefined();
  });

  it("returns the original rooms unchanged when Gemini returns no JSON array", async () => {
    vi.mocked(ai.models.generateContent).mockResolvedValue({ text: "No valid response here." });

    const rooms: RoomRecord[] = [makeAmbiguousRoom("LOBBY")];

    const { rooms: result } = await enrichAmbiguousRoomsWithAI(rooms, "file-y", "job-y", "/fake/plan.pdf");

    expect(result[0]!.aiEnriched).toBe(false);
    expect(result[0]!.roomName).toBe("LOBBY");
  });
});

describe("enrichAmbiguousRoomsWithAI — no_json_array failure rate alerting", () => {
  beforeEach(() => {
    vi.mocked(ai.models.generateContent).mockReset();
    vi.mocked(renderFloorPlanPages).mockReset().mockResolvedValue(
      new Map([[1, testPngPath]]),
    );
    vi.mocked(logger.warn).mockReset();
    vi.mocked(logger.error).mockReset();
  });

  it("emits logger.error with reason 'no_json_array_rate_exceeded' when all batches fail (100% > 50%)", async () => {
    vi.mocked(ai.models.generateContent).mockResolvedValue({ text: "Sorry, I cannot help." });

    const rooms: RoomRecord[] = Array.from({ length: 25 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-rate-a", "job-rate-a", "/fake/plan.pdf");

    const errorCalls = vi.mocked(logger.error).mock.calls as Array<[unknown, string]>;
    const rateAlert = errorCalls.find(
      ([fields, msg]) =>
        typeof msg === "string" &&
        msg.includes("failure rate exceeded threshold") &&
        (fields as Record<string, unknown>).reason === "no_json_array_rate_exceeded",
    );

    expect(rateAlert).toBeDefined();
  });

  it("includes failedBatches, totalBatches, failureRate, and threshold in the structured error payload", async () => {
    vi.mocked(ai.models.generateContent).mockResolvedValue({ text: "Sorry, I cannot help." });

    const rooms: RoomRecord[] = Array.from({ length: 25 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-rate-b", "job-rate-b", "/fake/plan.pdf");

    const errorCalls = vi.mocked(logger.error).mock.calls as Array<[unknown, string]>;
    const rateAlert = errorCalls.find(
      ([, msg]) => typeof msg === "string" && msg.includes("failure rate exceeded threshold"),
    );

    expect(rateAlert).toBeDefined();
    const fields = rateAlert![0] as Record<string, unknown>;
    expect(fields.failedBatches).toBe(2);
    expect(fields.totalBatches).toBe(2);
    expect(fields.failureRate).toBe(1);
    expect(fields.threshold).toBe(0.5);
  });

  it("does NOT emit logger.error when exactly 50% of batches fail (not strictly greater than threshold)", async () => {
    // 2 batches: first fails, second succeeds → 50% failure rate, NOT > 50%
    vi.mocked(ai.models.generateContent)
      .mockResolvedValueOnce({ text: "Sorry, I cannot help." })
      .mockResolvedValueOnce({ text: "[]" });

    const rooms: RoomRecord[] = Array.from({ length: 25 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-rate-c", "job-rate-c", "/fake/plan.pdf");

    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it("does NOT emit logger.error when fewer than 50% of batches fail", async () => {
    // 3 batches: one fails → 33% failure rate, NOT > 50%
    vi.mocked(ai.models.generateContent)
      .mockResolvedValueOnce({ text: "Sorry, I cannot help." })
      .mockResolvedValueOnce({ text: "[]" })
      .mockResolvedValueOnce({ text: "[]" });

    const rooms: RoomRecord[] = Array.from({ length: 45 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    await enrichAmbiguousRoomsWithAI(rooms, "file-rate-d", "job-rate-d", "/fake/plan.pdf");

    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it("preserves non-fatal fallback: rooms that succeeded in other batches are still enriched despite high failure rate", async () => {
    // 2 batches: first fails (rooms 0-19), second succeeds with a classification for room 20
    vi.mocked(ai.models.generateContent)
      .mockResolvedValueOnce({ text: "Sorry, I cannot help." })
      .mockResolvedValueOnce({ text: JSON.stringify([{ index: 20, roomName: "RESTROOM", roomType: "RESTROOM", confidence: 0.9 }]) });

    const rooms: RoomRecord[] = Array.from({ length: 25 }, (_, i) =>
      makeAmbiguousRoom(`ROOM${String(i).padStart(2, "0")}`),
    );

    const { rooms: result } = await enrichAmbiguousRoomsWithAI(rooms, "file-rate-e", "job-rate-e", "/fake/plan.pdf");

    expect(result[20]!.aiEnriched).toBe(true);
    expect(result[20]!.roomName).toBe("RESTROOM");
    expect(result[0]!.aiEnriched).toBe(false);
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
