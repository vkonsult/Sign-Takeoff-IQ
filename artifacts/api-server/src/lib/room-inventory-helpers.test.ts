/**
 * Direct unit tests for the room-type helper functions used inside AI enrichment:
 *   - roomTypeToFlags  – maps a Gemini roomType string to boolean flags
 *   - isAmbiguousRoom  – decides whether a room needs AI classification
 */

import { describe, it, expect } from "vitest";
import { roomTypeToFlags, isAmbiguousRoom } from "./room-inventory";
import type { RoomRecord } from "./room-inventory";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** All boolean flags set to false, confidence high, name long enough. */
const BASE_ROOM: RoomRecord = {
  roomNumber: "101",
  roomName: "Conference Room",
  level: "L1",
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
  isResidentialUnit: false,
  boundingBox: null,
  extractionConfidence: 0.9,
};

// ── roomTypeToFlags ────────────────────────────────────────────────────────────

describe("roomTypeToFlags", () => {
  const ALL_FALSE = {
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
  };

  it.each([
    ["RESTROOM", "isRestroom"],
    ["STAIR", "isStair"],
    ["ELEVATOR", "isElevator"],
    ["VESTIBULE", "isVestibule"],
    ["CORRIDOR", "isCorridorOrHall"],
    ["VEHICLE_BAY", "isVehicleBay"],
    ["MEP_UNOCCUPIED", "isMepUnoccupied"],
    ["VARIABLE_USE", "isVariableUse"],
    ["PUBLIC_FACING", "isPublicFacing"],
    ["STAFF_ONLY", "isStaffOnly"],
    ["ASSEMBLY", "isAssembly"],
  ] as const)(
    'sets only %s flag for roomType "%s"',
    (roomType, expectedFlag) => {
      const flags = roomTypeToFlags(roomType);

      expect(flags[expectedFlag]).toBe(true);

      const otherFlags = Object.entries(flags).filter(
        ([key]) => key !== expectedFlag,
      );
      for (const [key, value] of otherFlags) {
        expect(value, `${key} should be false when roomType is ${roomType}`).toBe(false);
      }
    },
  );

  it('returns all flags false for roomType "OFFICE"', () => {
    expect(roomTypeToFlags("OFFICE")).toEqual(ALL_FALSE);
  });

  it('returns all flags false for roomType "STORAGE"', () => {
    expect(roomTypeToFlags("STORAGE")).toEqual(ALL_FALSE);
  });

  it('returns all flags false for roomType "OTHER"', () => {
    expect(roomTypeToFlags("OTHER")).toEqual(ALL_FALSE);
  });

  it("returns all flags false for a completely unrecognised roomType value", () => {
    const unknown = "UNRECOGNIZED" as unknown as Parameters<typeof roomTypeToFlags>[0];
    expect(roomTypeToFlags(unknown)).toEqual(ALL_FALSE);
  });

  it("never sets more than one flag at a time", () => {
    const types = [
      "RESTROOM",
      "STAIR",
      "ELEVATOR",
      "VESTIBULE",
      "CORRIDOR",
      "VEHICLE_BAY",
      "MEP_UNOCCUPIED",
      "VARIABLE_USE",
      "PUBLIC_FACING",
      "STAFF_ONLY",
      "ASSEMBLY",
      "OFFICE",
      "STORAGE",
      "OTHER",
    ] as const;

    for (const roomType of types) {
      const flags = roomTypeToFlags(roomType);
      const trueCount = Object.values(flags).filter(Boolean).length;
      expect(
        trueCount,
        `roomType "${roomType}" should set at most one flag`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

// ── isAmbiguousRoom ────────────────────────────────────────────────────────────

describe("isAmbiguousRoom", () => {
  describe("confidence threshold", () => {
    it("returns true when extractionConfidence is below 0.5", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        extractionConfidence: 0.49,
        isRestroom: true,
        roomName: "Restroom",
      };
      expect(isAmbiguousRoom(room)).toBe(true);
    });

    it("returns true when extractionConfidence is 0.0", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        extractionConfidence: 0,
        isRestroom: true,
        roomName: "Restroom",
      };
      expect(isAmbiguousRoom(room)).toBe(true);
    });

    it("does not trigger the confidence clause when confidence is exactly 0.5", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        extractionConfidence: 0.5,
        isRestroom: true,
        roomName: "Restroom",
      };
      expect(isAmbiguousRoom(room)).toBe(false);
    });

    it("does not trigger the confidence clause when confidence is 1.0", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        extractionConfidence: 1.0,
        isRestroom: true,
        roomName: "Restroom",
      };
      expect(isAmbiguousRoom(room)).toBe(false);
    });
  });

  describe("short-name edge cases", () => {
    it("returns true when room name has fewer than 4 non-whitespace characters", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        roomName: "Rm",
        isRestroom: true,
      };
      expect(isAmbiguousRoom(room)).toBe(true);
    });

    it("returns true when room name has exactly 2 non-whitespace characters", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        roomName: "R m",
        isRestroom: true,
      };
      expect(isAmbiguousRoom(room)).toBe(true);
    });

    it("returns true when room name is all whitespace (collapses to empty)", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        roomName: "   ",
        isRestroom: true,
      };
      expect(isAmbiguousRoom(room)).toBe(true);
    });

    it("does not trigger the short-name clause when name has exactly 4 non-whitespace characters", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        roomName: "S ta r",
        isStair: true,
      };
      expect(isAmbiguousRoom(room)).toBe(false);
    });

    it("does not trigger the short-name clause when name has more than 4 non-whitespace characters", () => {
      const room: RoomRecord = {
        ...BASE_ROOM,
        roomName: "Lobby",
        isVestibule: true,
      };
      expect(isAmbiguousRoom(room)).toBe(false);
    });
  });

  describe("rooms already flagged as a known type", () => {
    it("returns false when isRestroom is set (and confidence/name are fine)", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isRestroom: true })).toBe(false);
    });

    it("returns false when isStair is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isStair: true })).toBe(false);
    });

    it("returns false when isElevator is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isElevator: true })).toBe(false);
    });

    it("returns false when isVestibule is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isVestibule: true })).toBe(false);
    });

    it("returns false when isCorridorOrHall is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isCorridorOrHall: true })).toBe(false);
    });

    it("returns false when isVehicleBay is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isVehicleBay: true })).toBe(false);
    });

    it("returns false when isMepUnoccupied is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isMepUnoccupied: true })).toBe(false);
    });

    it("returns false when isVariableUse is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isVariableUse: true })).toBe(false);
    });

    it("returns false when isPublicFacing is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isPublicFacing: true })).toBe(false);
    });

    it("returns false when isStaffOnly is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isStaffOnly: true })).toBe(false);
    });

    it("returns false when isAssembly is set", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM, isAssembly: true })).toBe(false);
    });

    it("returns true when no flags are set (unclassified room)", () => {
      expect(isAmbiguousRoom({ ...BASE_ROOM })).toBe(true);
    });
  });
});
