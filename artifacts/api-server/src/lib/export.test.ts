import { describe, it, expect, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { tmpdir } from "os";
import { join } from "path";
import { rm } from "fs/promises";
import { buildExcelExport } from "./export.js";
import type { ExtractedSign } from "@workspace/db";
import type { PlaqueSchedule } from "@workspace/db";
import type { OccupantLoad } from "@workspace/db";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpFiles: string[] = [];

function tmpPath(suffix = ".xlsx"): string {
  const p = join(tmpdir(), `export-test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  tmpFiles.push(p);
  return p;
}

afterEach(async () => {
  for (const f of tmpFiles) {
    await rm(f, { force: true });
  }
  tmpFiles = [];
});

function makeSign(overrides: Partial<ExtractedSign> = {}): ExtractedSign {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    jobId: "job-1",
    jobFileId: null,
    sheetNumber: "A1.01",
    detailReference: "D1",
    signType: "Room ID",
    signIdentifier: "101",
    quantity: 1,
    location: "Room 101",
    dimensions: '6" x 6"',
    mountingType: "Wall Mount",
    finishColor: "Aluminum",
    illumination: "None",
    materials: "Acrylic",
    messageContent: "101",
    notes: "",
    pageNumber: 2,
    xPos: 0.5,
    yPos: 0.75,
    placementSource: "heuristic",
    extractionMethod: "text",
    pairedSignId: null,
    adaRequired: false,
    manuallyAdded: false,
    manuallyEdited: false,
    userVerified: false,
    hidden: false,
    confidenceScore: 0.9,
    reviewFlag: false,
    exceptionReason: null,
    aiBboxX: null,
    aiBboxY: null,
    aiBboxW: null,
    aiBboxH: null,
    aiBbox: false,
    dataSource: "pdf",
    rawJson: null,
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makePlaque(overrides: Partial<PlaqueSchedule> = {}): PlaqueSchedule {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    jobId: "job-1",
    typeId: "T1",
    name: "Room ID Plaque",
    braille: true,
    insert: null,
    insertSize: null,
    letterHeight: '5/8"',
    trigger: "Occupied Room",
    mapsToColumn: null,
    generalNotes: null,
    rawJson: null,
    sourcePage: null,
    manuallyEdited: false,
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeOccupantLoad(overrides: Partial<OccupantLoad> = {}): OccupantLoad {
  return {
    id: "00000000-0000-0000-0000-000000000020",
    jobId: "job-1",
    roomNum: "101",
    roomName: "Conference Room",
    occupantLoad: 30,
    occupancyGroup: "B",
    sourcePage: null,
    manuallyEdited: false,
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

async function loadWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

function getSheetHeaders(sheet: ExcelJS.Worksheet): string[] {
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell) => {
    headers.push(String(cell.value ?? ""));
  });
  return headers;
}

function _getRowValues(row: ExcelJS.Row): unknown[] {
  const vals: unknown[] = [];
  row.eachCell({ includeEmpty: true }, (cell) => {
    vals.push(cell.value);
  });
  return vals;
}

// ── Sheet names ───────────────────────────────────────────────────────────────

describe("buildExcelExport — sheet names", () => {
  it("creates all five worksheets", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out);
    const wb = await loadWorkbook(out);
    const names = wb.worksheets.map((ws) => ws.name);
    expect(names).toContain("Sign Takeoff");
    expect(names).toContain("Summary");
    expect(names).toContain("By Sign Type");
    expect(names).toContain("Plaque Schedule");
    expect(names).toContain("Occupant Loads");
    expect(names).toHaveLength(5);
  });
});

// ── Column headers ─────────────────────────────────────────────────────────────

describe("buildExcelExport — column headers", () => {
  it("Sign Takeoff sheet has the expected headers", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out);
    const wb = await loadWorkbook(out);
    const headers = getSheetHeaders(wb.getWorksheet("Sign Takeoff")!);
    expect(headers).toEqual([
      "Sheet #",
      "Detail/Ref",
      "Sign ID",
      "Sign Type",
      "Qty",
      "Location",
      "Dimensions",
      "Mounting Type",
      "Finish / Color",
      "Illumination",
      "Materials",
      "Message / Content",
      "Notes",
      "Confidence",
      "Review Flag",
    ]);
  });

  it("Summary sheet has Metric and Value headers", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out);
    const wb = await loadWorkbook(out);
    const headers = getSheetHeaders(wb.getWorksheet("Summary")!);
    expect(headers).toContain("Metric");
    expect(headers).toContain("Value");
  });

  it("By Sign Type sheet has the expected headers", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out);
    const wb = await loadWorkbook(out);
    const headers = getSheetHeaders(wb.getWorksheet("By Sign Type")!);
    expect(headers).toEqual(["Sign Type", "Size", "Total Qty", "Floors / Sheets"]);
  });

  it("Plaque Schedule sheet has the expected headers", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out);
    const wb = await loadWorkbook(out);
    const headers = getSheetHeaders(wb.getWorksheet("Plaque Schedule")!);
    expect(headers).toEqual(["Type ID", "Name", "Braille", "Letter Height", "Trigger"]);
  });

  it("Occupant Loads sheet has the expected headers", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out);
    const wb = await loadWorkbook(out);
    const headers = getSheetHeaders(wb.getWorksheet("Occupant Loads")!);
    expect(headers).toEqual(["Room #", "Room Name", "Occupant Load", "Occupancy Group", "Assembly (Y/N)"]);
  });
});

// ── Sign Takeoff rows ─────────────────────────────────────────────────────────

describe("buildExcelExport — Sign Takeoff rows", () => {
  it("writes one data row per sign", async () => {
    const signs = [makeSign(), makeSign({ id: "00000000-0000-0000-0000-000000000002", signIdentifier: "102" })];
    const out = tmpPath();
    await buildExcelExport(signs, "job-1", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Sign Takeoff")!;
    expect(ws.rowCount).toBe(3);
  });

  it("maps sign fields to the correct columns", async () => {
    const sign = makeSign({
      sheetNumber: "A2.01",
      detailReference: "D9",
      signIdentifier: "201",
      signType: "Exit",
      quantity: 3,
      location: "Stairwell",
      dimensions: '12" x 6"',
      mountingType: "Ceiling",
      finishColor: "White",
      illumination: "LED",
      materials: "Metal",
      messageContent: "EXIT",
      notes: "See detail",
      confidenceScore: 0.95,
      reviewFlag: false,
    });
    const out = tmpPath();
    await buildExcelExport([sign], "job-1", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Sign Takeoff")!;
    const dataRow = ws.getRow(2);
    expect(dataRow.getCell(1).value).toBe("A2.01");
    expect(dataRow.getCell(2).value).toBe("D9");
    expect(dataRow.getCell(3).value).toBe("201");
    expect(dataRow.getCell(4).value).toBe("Exit");
    expect(dataRow.getCell(5).value).toBe(3);
    expect(dataRow.getCell(6).value).toBe("Stairwell");
    expect(dataRow.getCell(7).value).toBe('12" x 6"');
    expect(dataRow.getCell(8).value).toBe("Ceiling");
    expect(dataRow.getCell(9).value).toBe("White");
    expect(dataRow.getCell(10).value).toBe("LED");
    expect(dataRow.getCell(11).value).toBe("Metal");
    expect(dataRow.getCell(12).value).toBe("EXIT");
    expect(dataRow.getCell(13).value).toBe("See detail");
    expect(dataRow.getCell(14).value).toBe(0.95);
    expect(dataRow.getCell(15).value).toBe("");
  });

  it("sets review_flag cell to 'REVIEW' when reviewFlag is true", async () => {
    const sign = makeSign({ reviewFlag: true, confidenceScore: 0.4 });
    const out = tmpPath();
    await buildExcelExport([sign], "job-1", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Sign Takeoff")!;
    const dataRow = ws.getRow(2);
    expect(dataRow.getCell(15).value).toBe("REVIEW");
  });

  it("produces an empty data section when signs array is empty", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Sign Takeoff")!;
    expect(ws.rowCount).toBe(1);
  });
});

// ── Summary sheet ─────────────────────────────────────────────────────────────

describe("buildExcelExport — Summary sheet", () => {
  it("includes the job ID in the summary", async () => {
    const out = tmpPath();
    await buildExcelExport([], "my-job-id", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Summary")!;
    const metrics: Record<string, unknown> = {};
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const metric = String(row.getCell(1).value ?? "");
      const value = row.getCell(2).value;
      if (metric) metrics[metric] = value;
    });
    expect(metrics["Job ID"]).toBe("my-job-id");
  });

  it("reports correct sign counts", async () => {
    const signs = [
      makeSign({ quantity: 2, confidenceScore: 0.9, reviewFlag: false }),
      makeSign({ id: "2", quantity: 1, confidenceScore: 0.5, reviewFlag: true }),
      makeSign({ id: "3", quantity: 3, confidenceScore: 0.85, reviewFlag: false }),
    ];
    const out = tmpPath();
    await buildExcelExport(signs, "job-1", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Summary")!;
    const metrics: Record<string, unknown> = {};
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const metric = String(row.getCell(1).value ?? "");
      const value = row.getCell(2).value;
      if (metric) metrics[metric] = value;
    });
    expect(metrics["Total Sign Line Items"]).toBe(3);
    expect(metrics["Total Sign Quantity"]).toBe(6);
    expect(metrics["High Confidence Items"]).toBe(2);
    expect(metrics["Items Flagged for Review"]).toBe(1);
  });

  it("reports plaque and occupant load counts", async () => {
    const plaques = [makePlaque(), makePlaque({ id: "2", typeId: "T2" })];
    const loads = [makeOccupantLoad(), makeOccupantLoad({ id: "2", roomNum: "102" })];
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, plaques, loads);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Summary")!;
    const metrics: Record<string, unknown> = {};
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const metric = String(row.getCell(1).value ?? "");
      const value = row.getCell(2).value;
      if (metric) metrics[metric] = value;
    });
    expect(metrics["Plaque Types"]).toBe(2);
    expect(metrics["Occupant Load Rooms"]).toBe(2);
  });

  it("counts assembly rooms by occupancy group starting with A", async () => {
    const loads = [
      makeOccupantLoad({ id: "1", occupancyGroup: "A-2", occupantLoad: 20 }),
      makeOccupantLoad({ id: "2", occupancyGroup: "B", occupantLoad: 10 }),
      makeOccupantLoad({ id: "3", occupancyGroup: "A-3", occupantLoad: 5 }),
    ];
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [], loads);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Summary")!;
    const metrics: Record<string, unknown> = {};
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const metric = String(row.getCell(1).value ?? "");
      const value = row.getCell(2).value;
      if (metric) metrics[metric] = value;
    });
    expect(metrics["Assembly Rooms"]).toBe(2);
  });

  it("counts assembly rooms by occupant load >= 50 even when group is not A", async () => {
    const loads = [
      makeOccupantLoad({ id: "1", occupancyGroup: "B", occupantLoad: 75 }),
      makeOccupantLoad({ id: "2", occupancyGroup: "B", occupantLoad: 25 }),
    ];
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [], loads);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Summary")!;
    const metrics: Record<string, unknown> = {};
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const metric = String(row.getCell(1).value ?? "");
      const value = row.getCell(2).value;
      if (metric) metrics[metric] = value;
    });
    expect(metrics["Assembly Rooms"]).toBe(1);
  });
});

// ── By Sign Type sheet ────────────────────────────────────────────────────────

describe("buildExcelExport — By Sign Type sheet", () => {
  it("groups signs by sign type and dimensions, summing quantity", async () => {
    const signs = [
      makeSign({ id: "1", signType: "Exit", dimensions: '12" x 6"', quantity: 2, sheetNumber: "A1" }),
      makeSign({ id: "2", signType: "Exit", dimensions: '12" x 6"', quantity: 3, sheetNumber: "A2" }),
      makeSign({ id: "3", signType: "Room ID", dimensions: '6" x 6"', quantity: 1, sheetNumber: "A1" }),
    ];
    const out = tmpPath();
    await buildExcelExport(signs, "job-1", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("By Sign Type")!;
    const rows: Array<{ type: string; size: string; qty: unknown }> = [];
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const type = String(row.getCell(1).value ?? "");
      const size = String(row.getCell(2).value ?? "");
      const qty = row.getCell(3).value;
      rows.push({ type, size, qty });
    });
    const exitRow = rows.find((r) => r.type === "Exit");
    expect(exitRow).toBeDefined();
    expect(exitRow!.qty).toBe(5);
    const roomRow = rows.find((r) => r.type === "Room ID");
    expect(roomRow).toBeDefined();
    expect(roomRow!.qty).toBe(1);
  });

  it("adds a TOTAL row with the grand total quantity", async () => {
    const signs = [
      makeSign({ id: "1", quantity: 2 }),
      makeSign({ id: "2", quantity: 3 }),
    ];
    const out = tmpPath();
    await buildExcelExport(signs, "job-1", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("By Sign Type")!;
    const lastRow = ws.getRow(ws.rowCount);
    expect(lastRow.getCell(1).value).toBe("TOTAL");
    expect(lastRow.getCell(3).value).toBe(5);
  });

  it("collects unique sheet numbers for each group", async () => {
    const signs = [
      makeSign({ id: "1", signType: "Exit", dimensions: '12" x 6"', sheetNumber: "A1" }),
      makeSign({ id: "2", signType: "Exit", dimensions: '12" x 6"', sheetNumber: "A2" }),
      makeSign({ id: "3", signType: "Exit", dimensions: '12" x 6"', sheetNumber: "A1" }),
    ];
    const out = tmpPath();
    await buildExcelExport(signs, "job-1", out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("By Sign Type")!;
    const dataRow = ws.getRow(2);
    const sheetsValue = String(dataRow.getCell(4).value ?? "");
    expect(sheetsValue).toContain("A1");
    expect(sheetsValue).toContain("A2");
  });
});

// ── Plaque Schedule sheet ─────────────────────────────────────────────────────

describe("buildExcelExport — Plaque Schedule sheet", () => {
  it("writes one row per plaque with correct field mapping", async () => {
    const plaque = makePlaque({
      typeId: "P1",
      name: "Directional",
      braille: false,
      letterHeight: '1"',
      trigger: "Corridor Intersection",
    });
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [plaque]);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Plaque Schedule")!;
    expect(ws.rowCount).toBe(2);
    const dataRow = ws.getRow(2);
    expect(dataRow.getCell(1).value).toBe("P1");
    expect(dataRow.getCell(2).value).toBe("Directional");
    expect(dataRow.getCell(3).value).toBe("No");
    expect(dataRow.getCell(4).value).toBe('1"');
    expect(dataRow.getCell(5).value).toBe("Corridor Intersection");
  });

  it("renders braille=true as 'Yes'", async () => {
    const plaque = makePlaque({ braille: true });
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [plaque]);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Plaque Schedule")!;
    expect(ws.getRow(2).getCell(3).value).toBe("Yes");
  });

  it("renders braille=null as empty string", async () => {
    const plaque = makePlaque({ braille: null });
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [plaque]);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Plaque Schedule")!;
    expect(ws.getRow(2).getCell(3).value).toBe("");
  });

  it("produces only a header row when no plaques provided", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, []);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Plaque Schedule")!;
    expect(ws.rowCount).toBe(1);
  });
});

// ── Occupant Loads sheet ──────────────────────────────────────────────────────

describe("buildExcelExport — Occupant Loads sheet", () => {
  it("writes one row per occupant load with correct field mapping", async () => {
    const load = makeOccupantLoad({
      roomNum: "201",
      roomName: "Board Room",
      occupantLoad: 45,
      occupancyGroup: "B",
    });
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [], [load]);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Occupant Loads")!;
    expect(ws.rowCount).toBe(2);
    const dataRow = ws.getRow(2);
    expect(dataRow.getCell(1).value).toBe("201");
    expect(dataRow.getCell(2).value).toBe("Board Room");
    expect(dataRow.getCell(3).value).toBe(45);
    expect(dataRow.getCell(4).value).toBe("B");
    expect(dataRow.getCell(5).value).toBe("N");
  });

  it("marks assembly as Y for occupancy group starting with A", async () => {
    const load = makeOccupantLoad({ occupancyGroup: "A-2", occupantLoad: 30 });
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [], [load]);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Occupant Loads")!;
    expect(ws.getRow(2).getCell(5).value).toBe("Y");
  });

  it("marks assembly as Y for occupant load >= 50 regardless of group", async () => {
    const load = makeOccupantLoad({ occupancyGroup: "E", occupantLoad: 55 });
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [], [load]);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Occupant Loads")!;
    expect(ws.getRow(2).getCell(5).value).toBe("Y");
  });

  it("marks assembly as N for non-assembly group with low load", async () => {
    const load = makeOccupantLoad({ occupancyGroup: "S-2", occupantLoad: 10 });
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [], [load]);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Occupant Loads")!;
    expect(ws.getRow(2).getCell(5).value).toBe("N");
  });

  it("produces only a header row when no occupant loads provided", async () => {
    const out = tmpPath();
    await buildExcelExport([], "job-1", out, [], []);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet("Occupant Loads")!;
    expect(ws.rowCount).toBe(1);
  });
});
