import { describe, it, expect } from "vitest";
import { buildRoomInventory } from "./room-inventory.js";
import type { HeuristicSignInsert } from "./extraction-heuristic.js";

// ── Helper ────────────────────────────────────────────────────────────────────

function makeRow(
  location: string,
  signIdentifier = "101",
  overrides: Partial<HeuristicSignInsert> = {},
): HeuristicSignInsert {
  return {
    sheetNumber: null,
    detailReference: null,
    signType: "ROOM SIGN",
    signIdentifier,
    quantity: 1,
    location,
    dimensions: null,
    mountingType: null,
    finishColor: null,
    illumination: null,
    materials: null,
    messageContent: null,
    notes: "",
    pageNumber: 2,
    xPos: 0.5,
    yPos: 0.75,
    placementSource: "heuristic",
    confidenceScore: 0.6,
    reviewFlag: true,
    extractionMethod: "heuristic",
    rawJson: {},
    ...overrides,
  };
}

// ── RoomLabel field mapping ───────────────────────────────────────────────────

describe("buildRoomInventory — RoomLabel field mapping", () => {
  it("maps signIdentifier to roomNumber", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE", "109")]);
    expect(room.roomNumber).toBe("109");
  });

  it("maps location to roomName", () => {
    const [room] = buildRoomInventory([makeRow("POLICE CHIEF")]);
    expect(room.roomName).toBe("POLICE CHIEF");
  });

  it("uses the level parameter", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")], "LEVEL 1");
    expect(room.level).toBe("LEVEL 1");
  });

  it("defaults level to empty string when omitted", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.level).toBe("");
  });

  it("maps pageNumber to pdfPage", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE", "101", { pageNumber: 5 })]);
    expect(room.pdfPage).toBe(5);
  });

  it("converts xPos/yPos (0-1) to coords (0-1000)", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE", "101", { xPos: 0.25, yPos: 0.8 })]);
    expect(room.coords.x).toBe(250);
    expect(room.coords.y).toBe(800);
  });

  it("sets sheetId to empty string", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.sheetId).toBe("");
  });

  it("sets occupantLoad to null", () => {
    const [room] = buildRoomInventory([makeRow("LOBBY")]);
    expect(room.occupantLoad).toBeNull();
  });

  it("sets occupancyGroup to null", () => {
    const [room] = buildRoomInventory([makeRow("LOBBY")]);
    expect(room.occupancyGroup).toBeNull();
  });
});

// ── Flag: isRestroom ──────────────────────────────────────────────────────────

describe("flag: isRestroom", () => {
  it.each([
    ["RESTROOM"],
    ["WOMEN'S RESTROOM"],
    ["MEN'S TOILET"],
    ["BATH"],
    ["SHOWER ROOM"],
    ["WC"],
    ["LAVATORY"],
  ])("sets isRestroom=true for '%s'", (loc) => {
    const [room] = buildRoomInventory([makeRow(loc)]);
    expect(room.flags.isRestroom).toBe(true);
  });

  it("does not set isRestroom for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isRestroom).toBe(false);
  });
});

// ── Flag: isStair ─────────────────────────────────────────────────────────────

describe("flag: isStair", () => {
  it.each([["STAIR 1"], ["STAIR A"], ["STAIRWELL"], ["STAIR-A"]])(
    "sets isStair=true for '%s'",
    (loc) => {
      const [room] = buildRoomInventory([makeRow(loc)]);
      expect(room.flags.isStair).toBe(true);
    },
  );

  it("does not set isStair for 'UPSTAIRS OFFICE' (does not start with STAIR)", () => {
    const [room] = buildRoomInventory([makeRow("UPSTAIRS OFFICE")]);
    expect(room.flags.isStair).toBe(false);
  });
});

// ── Flag: isElevator ─────────────────────────────────────────────────────────

describe("flag: isElevator", () => {
  it.each([["ELEV"], ["ELEVATOR LOBBY"], ["ELEVATOR"]])(
    "sets isElevator=true for '%s'",
    (loc) => {
      const [room] = buildRoomInventory([makeRow(loc)]);
      expect(room.flags.isElevator).toBe(true);
    },
  );

  it("does not set isElevator for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isElevator).toBe(false);
  });
});

// ── Flag: isVestibule ────────────────────────────────────────────────────────

describe("flag: isVestibule", () => {
  it.each([["VESTIBULE"], ["VEST"], ["ENTRY VESTIBULE"]])(
    "sets isVestibule=true for '%s'",
    (loc) => {
      const [room] = buildRoomInventory([makeRow(loc)]);
      expect(room.flags.isVestibule).toBe(true);
    },
  );

  it("does not set isVestibule for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isVestibule).toBe(false);
  });
});

// ── Flag: isCorridorOrHall ───────────────────────────────────────────────────

describe("flag: isCorridorOrHall", () => {
  it.each([["HALL"], ["CORRIDOR"], ["CORR"], ["LOBBY"], ["FOYER"]])(
    "sets isCorridorOrHall=true for '%s'",
    (loc) => {
      const [room] = buildRoomInventory([makeRow(loc)]);
      expect(room.flags.isCorridorOrHall).toBe(true);
    },
  );

  it("does not set isCorridorOrHall for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isCorridorOrHall).toBe(false);
  });
});

// ── Flag: isVehicleBay ───────────────────────────────────────────────────────

describe("flag: isVehicleBay", () => {
  it.each([["APPARATUS BAY"], ["VEHICLE BAY"], ["SALLY PORT"], ["GARAGE"]])(
    "sets isVehicleBay=true for '%s'",
    (loc) => {
      const [room] = buildRoomInventory([makeRow(loc)]);
      expect(room.flags.isVehicleBay).toBe(true);
    },
  );

  it("does not set isVehicleBay for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isVehicleBay).toBe(false);
  });
});

// ── Flag: isMepUnoccupied ────────────────────────────────────────────────────

describe("flag: isMepUnoccupied", () => {
  it.each([
    ["MECHANICAL ROOM"],
    ["ELECTRICAL ROOM"],
    ["TELECOM ROOM"],
    ["JANITOR"],
    ["STORAGE"],
    ["RISER"],
  ])("sets isMepUnoccupied=true for '%s'", (loc) => {
    const [room] = buildRoomInventory([makeRow(loc)]);
    expect(room.flags.isMepUnoccupied).toBe(true);
  });

  it("does not set isMepUnoccupied for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isMepUnoccupied).toBe(false);
  });
});

// ── Flag: isVariableUse ──────────────────────────────────────────────────────

describe("flag: isVariableUse", () => {
  it.each([["TRAINING ROOM"], ["COMMUNITY ROOM"], ["EOC"], ["MULTIPURPOSE ROOM"]])(
    "sets isVariableUse=true for '%s'",
    (loc) => {
      const [room] = buildRoomInventory([makeRow(loc)]);
      expect(room.flags.isVariableUse).toBe(true);
    },
  );

  it("does not set isVariableUse for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isVariableUse).toBe(false);
  });
});

// ── Flag: isPublicFacing ─────────────────────────────────────────────────────

describe("flag: isPublicFacing", () => {
  it.each([["LOBBY"], ["RECEPTION"], ["WAITING ROOM"], ["ENTRY"]])(
    "sets isPublicFacing=true for '%s'",
    (loc) => {
      const [room] = buildRoomInventory([makeRow(loc)]);
      expect(room.flags.isPublicFacing).toBe(true);
    },
  );

  it("does not set isPublicFacing for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isPublicFacing).toBe(false);
  });
});

// ── Flag: isStaffOnly ────────────────────────────────────────────────────────

describe("flag: isStaffOnly", () => {
  it.each([["STAFF LOUNGE"], ["STAFF OFFICE"], ["STAFF BREAK ROOM"]])(
    "sets isStaffOnly=true for '%s'",
    (loc) => {
      const [room] = buildRoomInventory([makeRow(loc)]);
      expect(room.flags.isStaffOnly).toBe(true);
    },
  );

  it("does not set isStaffOnly for 'OFFICE'", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE")]);
    expect(room.flags.isStaffOnly).toBe(false);
  });
});

// ── Flag: isAssembly ─────────────────────────────────────────────────────────

describe("flag: isAssembly", () => {
  it("is false when occupantLoad and occupancyGroup are null (initial state)", () => {
    const [room] = buildRoomInventory([makeRow("TRAINING ROOM")]);
    expect(room.flags.isAssembly).toBe(false);
  });
});

// ── Multi-row / edge cases ───────────────────────────────────────────────────

describe("buildRoomInventory — multi-row and edge cases", () => {
  it("returns an array with the same length as input", () => {
    const rows = [makeRow("OFFICE", "101"), makeRow("RESTROOM", "102")];
    const inventory = buildRoomInventory(rows, "LEVEL 1");
    expect(inventory).toHaveLength(2);
  });

  it("LOBBY sets both isCorridorOrHall and isPublicFacing", () => {
    const [room] = buildRoomInventory([makeRow("LOBBY")]);
    expect(room.flags.isCorridorOrHall).toBe(true);
    expect(room.flags.isPublicFacing).toBe(true);
  });

  it("handles empty rows array", () => {
    const inventory = buildRoomInventory([]);
    expect(inventory).toHaveLength(0);
  });

  it("correctly rounds coords at boundary (xPos=1, yPos=1)", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE", "101", { xPos: 1, yPos: 1 })]);
    expect(room.coords.x).toBe(1000);
    expect(room.coords.y).toBe(1000);
  });

  it("correctly rounds coords at zero (xPos=0, yPos=0)", () => {
    const [room] = buildRoomInventory([makeRow("OFFICE", "101", { xPos: 0, yPos: 0 })]);
    expect(room.coords.x).toBe(0);
    expect(room.coords.y).toBe(0);
  });
});
