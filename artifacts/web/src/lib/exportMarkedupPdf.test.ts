import { describe, it, expect } from "vitest";
import {
  getSignColor,
  normalizedToMediaBox,
  sanitizeFileName,
  SIGN_TYPE_COLORS,
} from "./exportMarkedupPdf";

// ── getSignColor ─────────────────────────────────────────────────────────────

describe("getSignColor", () => {
  it("returns grey fallback for null", () => {
    expect(getSignColor(null)).toEqual([0.420, 0.447, 0.502]);
  });

  it("returns grey fallback for undefined", () => {
    expect(getSignColor(undefined)).toEqual([0.420, 0.447, 0.502]);
  });

  it("returns grey fallback for unrecognised type", () => {
    expect(getSignColor("totallymadeuptype")).toEqual([0.420, 0.447, 0.502]);
  });

  it("returns the correct colour for 'wayfinding' (exact key)", () => {
    expect(getSignColor("wayfinding")).toEqual(SIGN_TYPE_COLORS["wayfinding"]);
  });

  it("is case-insensitive (WAYFINDING)", () => {
    expect(getSignColor("WAYFINDING")).toEqual(SIGN_TYPE_COLORS["wayfinding"]);
  });

  it("matches when the type string contains the key ('ADA Wayfinding')", () => {
    expect(getSignColor("ADA Wayfinding")).toEqual(SIGN_TYPE_COLORS["wayfinding"]);
  });

  it("returns the correct colour for 'ada'", () => {
    expect(getSignColor("ada")).toEqual(SIGN_TYPE_COLORS["ada"]);
  });

  it("returns the correct colour for 'exit'", () => {
    expect(getSignColor("exit")).toEqual(SIGN_TYPE_COLORS["exit"]);
  });

  it("returns the correct colour for 'restroom'", () => {
    expect(getSignColor("restroom")).toEqual(SIGN_TYPE_COLORS["restroom"]);
  });

  it("returns the correct colour for 'room id'", () => {
    expect(getSignColor("room id")).toEqual(SIGN_TYPE_COLORS["room id"]);
  });

  it("returns the correct colour for 'channel letter'", () => {
    expect(getSignColor("Channel Letter")).toEqual(SIGN_TYPE_COLORS["channel letter"]);
  });
});

// ── normalizedToMediaBox ─────────────────────────────────────────────────────

describe("normalizedToMediaBox", () => {
  const W = 800;
  const H = 600;

  it("rotation 0 — maps (0,0) to top-left in PDF space", () => {
    const { x, y } = normalizedToMediaBox(0, 0, W, H, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(H);
  });

  it("rotation 0 — maps (1,1) to bottom-right in PDF space", () => {
    const { x, y } = normalizedToMediaBox(1, 1, W, H, 0);
    expect(x).toBeCloseTo(W);
    expect(y).toBeCloseTo(0);
  });

  it("rotation 0 — maps centre (0.5, 0.5) to centre of page", () => {
    const { x, y } = normalizedToMediaBox(0.5, 0.5, W, H, 0);
    expect(x).toBeCloseTo(W / 2);
    expect(y).toBeCloseTo(H / 2);
  });

  it("rotation 90 — maps (0,0) correctly", () => {
    const { x, y } = normalizedToMediaBox(0, 0, W, H, 90);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });

  it("rotation 90 — maps (1,1) correctly", () => {
    const { x, y } = normalizedToMediaBox(1, 1, W, H, 90);
    expect(x).toBeCloseTo(W);
    expect(y).toBeCloseTo(H);
  });

  it("rotation 90 — maps centre (0.5, 0.5) to centre", () => {
    const { x, y } = normalizedToMediaBox(0.5, 0.5, W, H, 90);
    expect(x).toBeCloseTo(W / 2);
    expect(y).toBeCloseTo(H / 2);
  });

  it("rotation 180 — maps (0,0) to bottom-right (flipped both axes)", () => {
    const { x, y } = normalizedToMediaBox(0, 0, W, H, 180);
    expect(x).toBeCloseTo(W);
    expect(y).toBeCloseTo(0);
  });

  it("rotation 180 — maps (1,1) to top-left", () => {
    const { x, y } = normalizedToMediaBox(1, 1, W, H, 180);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(H);
  });

  it("rotation 270 — maps (0,0) correctly", () => {
    const { x, y } = normalizedToMediaBox(0, 0, W, H, 270);
    expect(x).toBeCloseTo(W);
    expect(y).toBeCloseTo(H);
  });

  it("rotation 270 — maps (1,1) correctly", () => {
    const { x, y } = normalizedToMediaBox(1, 1, W, H, 270);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });

  it("treats 360 the same as 0", () => {
    const r0 = normalizedToMediaBox(0.3, 0.7, W, H, 0);
    const r360 = normalizedToMediaBox(0.3, 0.7, W, H, 360);
    expect(r360.x).toBeCloseTo(r0.x);
    expect(r360.y).toBeCloseTo(r0.y);
  });

  it("treats -90 the same as 270", () => {
    const r270 = normalizedToMediaBox(0.3, 0.7, W, H, 270);
    const rNeg90 = normalizedToMediaBox(0.3, 0.7, W, H, -90);
    expect(rNeg90.x).toBeCloseTo(r270.x);
    expect(rNeg90.y).toBeCloseTo(r270.y);
  });
});

// ── sanitizeFileName ─────────────────────────────────────────────────────────

describe("sanitizeFileName", () => {
  it("replaces spaces with underscores", () => {
    expect(sanitizeFileName("My Job Name")).toBe("My_Job_Name");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeFileName("Job/Name:Test*File")).toBe("Job_Name_Test_File");
  });

  it("preserves allowed characters (letters, digits, _, -, .)", () => {
    expect(sanitizeFileName("job_name-v1.0")).toBe("job_name-v1.0");
  });

  it("collapses multiple spaces into a single underscore", () => {
    expect(sanitizeFileName("Job   Name")).toBe("Job_Name");
  });

  it("truncates to 80 characters", () => {
    const longName = "a".repeat(100);
    expect(sanitizeFileName(longName).length).toBe(80);
  });

  it("handles an empty string", () => {
    expect(sanitizeFileName("")).toBe("");
  });

  it("handles a name that is exactly 80 characters — no truncation", () => {
    const name = "a".repeat(80);
    expect(sanitizeFileName(name).length).toBe(80);
  });
});
