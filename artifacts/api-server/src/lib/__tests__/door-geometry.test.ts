import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchSignsToDoors } from "../door-geometry.js";
import type { PageDoorMap, DoorGeometry } from "../door-geometry.js";

function makeDoor(tx: number, ty: number): DoorGeometry {
  return {
    threshold: { x: tx, y: ty },
    pivot: { x: tx - 0.02, y: ty },
    openingDir: { x: 1, y: 0 },
    size: 0.05,
    bbox: { x0: tx - 0.025, y0: ty - 0.025, x1: tx + 0.025, y1: ty + 0.025 },
  };
}

function makeMap(doors: DoorGeometry[], labels: [string, { x: number; y: number }][]): PageDoorMap {
  return {
    isVector: true,
    pathOpCount: 10000,
    doors,
    labels: new Map(labels),
  };
}

function makeSign(signId: string, roomNumber: string) {
  return { signId, roomNumber };
}

describe("matchSignsToDoors — no doors", () => {
  it("returns empty candidates when door list is empty", () => {
    const map = makeMap([], [["417", { x: 0.3, y: 0.4 }]]);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "417")]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].candidates, []);
  });
});

describe("matchSignsToDoors — no labels", () => {
  it("returns empty candidates when room number has no label entry", () => {
    const map = makeMap([makeDoor(0.3, 0.4)], []);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "417")]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].candidates, []);
  });

  it("does NOT fall back to anchorX/anchorY", () => {
    const door = makeDoor(0.3, 0.4);
    const map = makeMap([door], []);
    const sign = { signId: "s1", roomNumber: "417", anchorX: 0.3, anchorY: 0.4 };
    const result = matchSignsToDoors(null, map, [sign]);
    assert.equal(result[0].candidates.length, 0, "must not use anchorX/Y as fallback");
  });
});

describe("matchSignsToDoors — happy path", () => {
  it("matches sign to nearby door and sets method to vector", () => {
    const door = makeDoor(0.31, 0.41);
    const map = makeMap([door], [["417", { x: 0.3, y: 0.4 }]]);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "417")]);
    assert.equal(result.length, 1);
    assert.equal(result[0].signId, "s1");
    assert.equal(result[0].method, "vector");
    assert.ok(result[0].candidates.length >= 1);
    const c = result[0].candidates[0]!;
    assert.ok(c.confidence > 0 && c.confidence <= 1, `confidence=${c.confidence}`);
    assert.ok(c.x >= 0 && c.x <= 1);
    assert.ok(c.y >= 0 && c.y <= 1);
  });

  it("returns all signs with correct signId keys", () => {
    const map = makeMap([makeDoor(0.3, 0.4)], [["A1", { x: 0.3, y: 0.4 }], ["B2", { x: 0.7, y: 0.4 }]]);
    const signs = [makeSign("sA", "A1"), makeSign("sB", "B2")];
    const result = matchSignsToDoors(null, map, signs);
    const ids = result.map((r) => r.signId).sort();
    assert.deepEqual(ids, ["sA", "sB"]);
  });
});

describe("matchSignsToDoors — door outside radius", () => {
  it("returns empty candidates when door is outside searchRadius", () => {
    const door = makeDoor(0.9, 0.9);
    const map = makeMap([door], [["101", { x: 0.1, y: 0.1 }]]);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "101")]);
    assert.equal(result[0].candidates.length, 0, "door is far away — no match");
  });
});

describe("matchSignsToDoors — single weak match suppression", () => {
  it("suppresses a single candidate below AUTO_CONFIDENCE_FLOOR", () => {
    // Place door at the edge of searchRadius (default 0.08) → low score
    const door = makeDoor(0.5 + 0.075, 0.5);
    const map = makeMap([door], [["101", { x: 0.5, y: 0.5 }]]);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "101")]);
    // dist ≈ 0.075, searchRadius=0.08 → distScore ≈ 0.06 → score ≈ 0.06*0.75 + orient*0.25 ≈ small
    // This is well below 0.75 (AUTO_CONFIDENCE_FLOOR) and only 1 candidate → suppress
    assert.equal(result[0].candidates.length, 0, "single weak match should be suppressed");
  });

  it("does NOT suppress when score >= AUTO_CONFIDENCE_FLOOR (close door)", () => {
    // Place door very close → high distScore → confident match
    const door = makeDoor(0.5 + 0.005, 0.5);
    const map = makeMap([door], [["101", { x: 0.5, y: 0.5 }]]);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "101")]);
    assert.ok(result[0].candidates.length >= 1, "confident match should not be suppressed");
    assert.ok(result[0].candidates[0]!.confidence >= 0.75);
  });
});

describe("matchSignsToDoors — multiple candidates", () => {
  it("sorts candidates by confidence descending", () => {
    const doors = [makeDoor(0.35, 0.4), makeDoor(0.31, 0.41), makeDoor(0.32, 0.39)];
    const map = makeMap(doors, [["200", { x: 0.3, y: 0.4 }]]);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "200")]);
    if (result[0].candidates.length > 1) {
      const confs = result[0].candidates.map((c) => c.confidence);
      for (let i = 1; i < confs.length; i++) {
        assert.ok(confs[i - 1]! >= confs[i]!, "candidates must be sorted descending");
      }
    }
  });

  it("returns at most 3 candidates", () => {
    const doors = Array.from({ length: 10 }, (_, i) => makeDoor(0.3 + i * 0.005, 0.4));
    const map = makeMap(doors, [["300", { x: 0.3, y: 0.4 }]]);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "300")]);
    assert.ok(result[0].candidates.length <= 3);
  });

  it("allows low best-score when there are >=2 candidates", () => {
    // Two doors close to the label (dist ≈ 0.02) so both score well above MIN_CANDIDATE_SCORE
    // but below AUTO_CONFIDENCE_FLOOR. The ≥2 path should return both as candidates.
    const doors = [makeDoor(0.5 + 0.02, 0.5), makeDoor(0.5 + 0.02, 0.503)];
    const map = makeMap(doors, [["400", { x: 0.5, y: 0.5 }]]);
    const result = matchSignsToDoors(null, map, [makeSign("s1", "400")]);
    assert.ok(result[0].candidates.length >= 1, "≥2 candidates should not be fully suppressed");
  });
});
