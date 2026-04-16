import { describe, it, expect } from "vitest";
import {
  applyRules,
  applyStairRules,
  applyElevatorRules,
  applyEvacMapRules,
  selectRestroomVariant,
  buildRoomInventory,
  type RoomInventory,
  type PlaqueSchedule,
} from "./rules-engine";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRoom(overrides: Partial<RoomInventory> = {}): RoomInventory {
  return {
    roomNumber: "101",
    roomName: "Office",
    level: "LEVEL 1",
    pageNumber: 2,
    occupantLoad: undefined,
    isCorridor: false,
    isBay: false,
    isMepUnoccupied: false,
    isStairwell: false,
    isElevator: false,
    isVariableUse: false,
    isAssembly: false,
    isRestroom: false,
    isVestibule: false,
    isPublicCorridor: false,
    isOccupied: true,
    ...overrides,
  };
}

// ─── R1 – Default Room ID ─────────────────────────────────────────────────────

describe("R1 – Default Room ID", () => {
  it("emits Room ID for a plain occupied room", () => {
    const entries = applyRules(makeRoom());
    expect(entries).toHaveLength(1);
    expect(entries[0].signType).toBe("Room ID");
    expect(entries[0].ruleRef).toBe("R1");
    expect(entries[0].qty).toBe(1);
  });

  it("does NOT emit a Room ID for a corridor", () => {
    const entries = applyRules(makeRoom({ isCorridor: true, isOccupied: false }));
    const roomIds = entries.filter((e) => e.ruleRef === "R1");
    expect(roomIds).toHaveLength(0);
  });

  it("does NOT emit a Room ID for a bay", () => {
    const entries = applyRules(makeRoom({ isBay: true, isOccupied: false }));
    const roomIds = entries.filter((e) => e.ruleRef === "R1");
    expect(roomIds).toHaveLength(0);
  });

  it("does NOT emit a Room ID for a stairwell", () => {
    const entries = applyRules(makeRoom({ isStairwell: true, isOccupied: false }));
    const roomIds = entries.filter((e) => e.ruleRef === "R1");
    expect(roomIds).toHaveLength(0);
  });

  it("does NOT emit a Room ID for an elevator", () => {
    const entries = applyRules(makeRoom({ isElevator: true, isOccupied: false }));
    const roomIds = entries.filter((e) => e.ruleRef === "R1");
    expect(roomIds).toHaveLength(0);
  });
});

// ─── R2 – Variable-use ────────────────────────────────────────────────────────

describe("R2 – Variable-use Room ID", () => {
  it("upgrades to Room ID w/ Insert for variable-use rooms", () => {
    const entries = applyRules(makeRoom({ isVariableUse: true }));
    expect(entries[0].signType).toBe("Room ID w/ Insert");
    expect(entries[0].ruleRef).toBe("R2");
    expect(entries[0].qty).toBe(1);
  });

  it("doubles qty when variable-use AND assembly", () => {
    const entries = applyRules(
      makeRoom({ isVariableUse: true, isAssembly: true })
    );
    const r2 = entries.find((e) => e.ruleRef === "R2");
    expect(r2).toBeDefined();
    expect(r2!.qty).toBe(2);
  });
});

// ─── R3–R7 – Restroom variants ────────────────────────────────────────────────

describe("R3–R7 – Restroom variants", () => {
  it("R3 – men's restroom", () => {
    const entries = applyRules(
      makeRoom({ isRestroom: true, restroomVariant: "mens" })
    );
    expect(entries[0].signType).toBe("Men's Restroom");
    expect(entries[0].ruleRef).toBe("R3");
  });

  it("R4 – women's restroom", () => {
    const entries = applyRules(
      makeRoom({ isRestroom: true, restroomVariant: "womens" })
    );
    expect(entries[0].signType).toBe("Women's Restroom");
    expect(entries[0].ruleRef).toBe("R4");
  });

  it("R5 – unisex restroom", () => {
    const entries = applyRules(
      makeRoom({ isRestroom: true, restroomVariant: "unisex" })
    );
    expect(entries[0].signType).toBe("Unisex Restroom");
    expect(entries[0].ruleRef).toBe("R5");
  });

  it("R6 – family restroom", () => {
    const entries = applyRules(
      makeRoom({ isRestroom: true, restroomVariant: "family" })
    );
    expect(entries[0].signType).toBe("Family Restroom");
    expect(entries[0].ruleRef).toBe("R6");
  });

  it("R7 – mother's room", () => {
    const entries = applyRules(
      makeRoom({ isRestroom: true, restroomVariant: "mothers" })
    );
    expect(entries[0].signType).toBe("Mother's Room");
    expect(entries[0].ruleRef).toBe("R7");
  });
});

// ─── R8 – Generic restroom (selectRestroomVariant) ────────────────────────────

describe("R8 – Generic restroom", () => {
  it("emits a Restroom sign when no variant is set", () => {
    const entries = applyRules(makeRoom({ isRestroom: true }));
    expect(entries[0].signType).toBe("Restroom");
    expect(entries[0].ruleRef).toBe("R8");
  });

  it("restroom rooms do NOT also get a Room ID sign", () => {
    const entries = applyRules(makeRoom({ isRestroom: true }));
    const roomIds = entries.filter(
      (e) => e.ruleRef === "R1" || e.ruleRef === "R2"
    );
    expect(roomIds).toHaveLength(0);
  });

  it("respects plaqueSchedule override via selectRestroomVariant", () => {
    const schedule: PlaqueSchedule = {
      plaques: [
        {
          type_id: "A1",
          name: "Custom Men's Room Plaque",
          braille: true,
          insert: false,
          letter_height: "1/2\"",
          trigger: "mens",
        },
      ],
    };
    const result = selectRestroomVariant(
      makeRoom({ isRestroom: true, restroomVariant: "mens" }),
      schedule
    );
    expect(result.signType).toBe("Custom Men's Room Plaque");
    expect(result.plaqueTypeId).toBe("A1");
    expect(result.ruleRef).toBe("R3");
  });
});

// ─── R9 – Exit signs ──────────────────────────────────────────────────────────

describe("R9 – Exit Signs", () => {
  it("vestibule gets qty 2 exit signs", () => {
    const entries = applyRules(makeRoom({ isVestibule: true }));
    const exitEntry = entries.find((e) => e.ruleRef === "R9");
    expect(exitEntry).toBeDefined();
    expect(exitEntry!.qty).toBe(2);
  });

  it("assembly room with occupantLoad >= 50 gets qty 2 exit signs", () => {
    const entries = applyRules(
      makeRoom({ isAssembly: true, occupantLoad: 50 })
    );
    const exitEntry = entries.find((e) => e.ruleRef === "R9");
    expect(exitEntry).toBeDefined();
    expect(exitEntry!.qty).toBe(2);
  });

  it("assembly room with occupantLoad < 50 gets qty 1 exit sign", () => {
    const entries = applyRules(
      makeRoom({ isAssembly: true, occupantLoad: 30 })
    );
    const exitEntry = entries.find((e) => e.ruleRef === "R9");
    expect(exitEntry).toBeDefined();
    expect(exitEntry!.qty).toBe(1);
  });

  it("plain office room does NOT get an exit sign", () => {
    const entries = applyRules(makeRoom());
    const exitEntry = entries.find((e) => e.ruleRef === "R9");
    expect(exitEntry).toBeUndefined();
  });
});

// ─── R10 – Max Occupancy placard ──────────────────────────────────────────────

describe("R10 – Max Occupancy Placard", () => {
  it("assembly room gets a Max Occupancy placard", () => {
    const entries = applyRules(makeRoom({ isAssembly: true }));
    const r10 = entries.find((e) => e.ruleRef === "R10");
    expect(r10).toBeDefined();
    expect(r10!.signType).toBe("Max Occupancy Placard");
  });

  it("plain office room does NOT get a Max Occupancy placard", () => {
    const entries = applyRules(makeRoom());
    expect(entries.find((e) => e.ruleRef === "R10")).toBeUndefined();
  });
});

// ─── R11 – Stairwell signs ────────────────────────────────────────────────────

describe("R11 – Stairwell Signs", () => {
  it("produces 2 entries per level (two faces) per stairwell", () => {
    const stair = makeRoom({ isStairwell: true, roomName: "Stair 1" });
    const entries = applyStairRules([stair], ["LEVEL 1", "LEVEL 2"]);
    expect(entries).toHaveLength(2); // 1 stair × 2 levels × qty 2 per level = 2 rows
    expect(entries.every((e) => e.ruleRef === "R11")).toBe(true);
    expect(entries.every((e) => e.qty === 2)).toBe(true);
  });

  it("produces entries for each stairwell independently", () => {
    const stair1 = makeRoom({
      isStairwell: true,
      roomNumber: "STAIR 1",
      roomName: "Stair 1",
    });
    const stair2 = makeRoom({
      isStairwell: true,
      roomNumber: "STAIR 2",
      roomName: "Stair 2",
    });
    const entries = applyStairRules([stair1, stair2], ["LEVEL 1"]);
    expect(entries).toHaveLength(2);
  });

  it("endpoint integration: same stairwell on two levels yields exactly 2 R11 rows (qty 2 each)", () => {
    // Simulate the full pipeline: buildRoomInventory returns per-level stair entries;
    // endpoint deduplicates by roomNumber before calling applyStairRules.
    const rows = [
      {
        location: "STAIR 1",
        signType: "Stairwell Sign",
        signIdentifier: null,
        pageNumber: 2,
        xPos: null,
        yPos: null,
        sheetNumber: "A2.1 LEVEL 1",
        messageContent: null,
        notes: null,
        quantity: 1,
      },
      {
        location: "STAIR 1",
        signType: "Stairwell Sign",
        signIdentifier: null,
        pageNumber: 5,
        xPos: null,
        yPos: null,
        sheetNumber: "A2.2 LEVEL 2",
        messageContent: null,
        notes: null,
        quantity: 1,
      },
    ];

    const inventory = buildRoomInventory(rows);
    const stairs = inventory.filter((r) => r.isStairwell);
    const uniqueLevels = [...new Set(inventory.map((r) => r.level))].sort();

    // Mimic the endpoint dedup: unique stairwells by room number
    const uniqueStairsByNumber = new Map<string, RoomInventory>();
    for (const stair of stairs) {
      if (!uniqueStairsByNumber.has(stair.roomNumber)) {
        uniqueStairsByNumber.set(stair.roomNumber, stair);
      }
    }
    const uniqueStairs = [...uniqueStairsByNumber.values()];

    const r11Entries = applyStairRules(uniqueStairs, uniqueLevels);

    // 1 unique stairwell × 2 levels = 2 rows, each qty 2
    expect(r11Entries).toHaveLength(2);
    expect(r11Entries.every((e) => e.ruleRef === "R11")).toBe(true);
    expect(r11Entries.every((e) => e.qty === 2)).toBe(true);
    expect(r11Entries.map((e) => e.level)).toEqual(
      expect.arrayContaining(["LEVEL 1", "LEVEL 2"])
    );
  });
});

// ─── R12 – Elevator signs ─────────────────────────────────────────────────────

describe("R12 – Elevator Signs", () => {
  it("produces one elevator sign per elevator room", () => {
    const elev = makeRoom({ isElevator: true, roomName: "Elevator 1" });
    const entries = applyElevatorRules([elev]);
    expect(entries).toHaveLength(1);
    expect(entries[0].ruleRef).toBe("R12");
    expect(entries[0].signType).toBe("Elevator Sign");
  });

  it("handles multiple elevators", () => {
    const elevs = [
      makeRoom({ isElevator: true, roomNumber: "ELEV 1" }),
      makeRoom({ isElevator: true, roomNumber: "ELEV 2" }),
    ];
    const entries = applyElevatorRules(elevs);
    expect(entries).toHaveLength(2);
  });
});

// ─── R13 – Evac map ───────────────────────────────────────────────────────────

describe("R13 – Evacuation Map", () => {
  it("produces one evac map per unique level", () => {
    const stairs = [
      makeRoom({ isStairwell: true, level: "LEVEL 1", roomNumber: "STAIR 1" }),
      makeRoom({ isStairwell: true, level: "LEVEL 2", roomNumber: "STAIR 1" }),
      makeRoom({ isStairwell: true, level: "LEVEL 1", roomNumber: "STAIR 2" }),
    ];
    const entries = applyEvacMapRules(stairs);
    expect(entries).toHaveLength(2); // one per unique level
    expect(entries.every((e) => e.ruleRef === "R13")).toBe(true);
    expect(entries.every((e) => e.signType === "Evacuation Map")).toBe(true);
  });
});

// ─── R14 – Office Directory ───────────────────────────────────────────────────

describe("R14 – Office Directory", () => {
  it("emits an Office Directory for public corridors", () => {
    const entries = applyRules(
      makeRoom({ isPublicCorridor: true, isCorridor: true })
    );
    const r14 = entries.find((e) => e.ruleRef === "R14");
    expect(r14).toBeDefined();
    expect(r14!.signType).toBe("Office Directory");
  });

  it("does NOT emit an Office Directory for a plain office", () => {
    const entries = applyRules(makeRoom());
    expect(entries.find((e) => e.ruleRef === "R14")).toBeUndefined();
  });
});

// ─── R15 – Exclusions ────────────────────────────────────────────────────────

describe("R15 – MEP/unoccupied exclusions", () => {
  it("produces NO entries for isMepUnoccupied rooms", () => {
    const entries = applyRules(makeRoom({ isMepUnoccupied: true }));
    expect(entries).toHaveLength(0);
  });
});

// ─── buildRoomInventory ───────────────────────────────────────────────────────

describe("buildRoomInventory", () => {
  it("groups rows by location into RoomInventory objects", () => {
    const rows = [
      {
        location: "101",
        signType: "Room ID",
        signIdentifier: null,
        pageNumber: 2,
        xPos: 0.5,
        yPos: 0.3,
        sheetNumber: "A1.1 LEVEL 1",
        messageContent: null,
        notes: null,
        quantity: 1,
      },
      {
        location: "102",
        signType: "Men's Restroom",
        signIdentifier: null,
        pageNumber: 2,
        xPos: null,
        yPos: null,
        sheetNumber: "A1.1 LEVEL 1",
        messageContent: null,
        notes: null,
        quantity: 1,
      },
    ];

    const inventory = buildRoomInventory(rows);
    expect(inventory).toHaveLength(2);

    const office = inventory.find((r) => r.roomNumber === "101");
    expect(office).toBeDefined();
    expect(office!.isOccupied).toBe(true);
    expect(office!.coords).toEqual({ x: 0.5, y: 0.3 });

    const restroom = inventory.find((r) => r.roomNumber === "102");
    expect(restroom).toBeDefined();
    expect(restroom!.isRestroom).toBe(true);
    expect(restroom!.restroomVariant).toBe("mens");
  });

  it("flags stairwell rooms correctly", () => {
    const rows = [
      {
        location: "STAIR 1",
        signType: "Stairwell Sign",
        signIdentifier: null,
        pageNumber: 3,
        xPos: null,
        yPos: null,
        sheetNumber: null,
        messageContent: null,
        notes: null,
        quantity: 1,
      },
    ];
    const inventory = buildRoomInventory(rows);
    expect(inventory[0].isStairwell).toBe(true);
  });

  it("flags MEP rooms correctly", () => {
    const rows = [
      {
        location: "MECHANICAL ROOM",
        signType: null,
        signIdentifier: null,
        pageNumber: 1,
        xPos: null,
        yPos: null,
        sheetNumber: null,
        messageContent: null,
        notes: null,
        quantity: null,
      },
    ];
    const inventory = buildRoomInventory(rows);
    expect(inventory[0].isMepUnoccupied).toBe(true);
  });

  it("infers occupant load from notes", () => {
    const rows = [
      {
        location: "SANCTUARY",
        signType: "Room ID",
        signIdentifier: null,
        pageNumber: 1,
        xPos: null,
        yPos: null,
        sheetNumber: null,
        messageContent: null,
        notes: "Occupant Load: 250",
        quantity: 1,
      },
    ];
    const inventory = buildRoomInventory(rows);
    expect(inventory[0].occupantLoad).toBe(250);
    expect(inventory[0].isAssembly).toBe(true);
  });

  it("handles unknown/null location gracefully", () => {
    const rows = [
      {
        location: null,
        signType: "Room ID",
        signIdentifier: null,
        pageNumber: 1,
        xPos: null,
        yPos: null,
        sheetNumber: null,
        messageContent: null,
        notes: null,
        quantity: 1,
      },
    ];
    const inventory = buildRoomInventory(rows);
    expect(inventory).toHaveLength(1);
    expect(inventory[0].roomNumber).toBe("UNKNOWN");
  });

  it("keeps same location name on different levels as separate inventory entries", () => {
    // "STAIR 1" exists on both Level 1 and Level 2 — must NOT be merged.
    const rows = [
      {
        location: "STAIR 1",
        signType: "Stairwell Sign",
        signIdentifier: null,
        pageNumber: 2,
        xPos: null,
        yPos: null,
        sheetNumber: "A2.1 LEVEL 1",
        messageContent: null,
        notes: null,
        quantity: 1,
      },
      {
        location: "STAIR 1",
        signType: "Stairwell Sign",
        signIdentifier: null,
        pageNumber: 5,
        xPos: null,
        yPos: null,
        sheetNumber: "A2.2 LEVEL 2",
        messageContent: null,
        notes: null,
        quantity: 1,
      },
    ];

    const inventory = buildRoomInventory(rows);

    // Must produce two separate inventory entries, not one merged entry.
    expect(inventory).toHaveLength(2);
    expect(inventory.every((r) => r.isStairwell)).toBe(true);

    const levels = inventory.map((r) => r.level);
    expect(levels).toContain("LEVEL 1");
    expect(levels).toContain("LEVEL 2");

    // R13: applyEvacMapRules on these two stair entries must emit one evac map
    // per level (2 maps total), not just 1.
    const evacEntries = applyEvacMapRules(inventory);
    expect(evacEntries).toHaveLength(2);
    expect(evacEntries.map((e) => e.level)).toEqual(
      expect.arrayContaining(["LEVEL 1", "LEVEL 2"])
    );
  });
});
