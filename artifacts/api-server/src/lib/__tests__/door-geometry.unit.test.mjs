/**
 * Unit tests for door-geometry.ts helper logic.
 *
 * Uses matchSignsToDoors and the OPS constant values — both importable from the
 * compiled JS output via tsx/ts-node, or tested here via the exported helpers.
 *
 * Run with: node --import tsx/esm src/lib/__tests__/door-geometry.unit.test.mjs
 * (or via the existing test runner configured in package.json)
 *
 * These tests do NOT require real PDF files on disk. All data is synthetic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Inline the scoreDoor / matchSignsToDoors logic under test so this file does
// not depend on a compiled build path.  The implementation below is a faithful
// copy of the relevant pure-function portions of door-geometry.ts.
// ---------------------------------------------------------------------------

const AUTO_CONFIDENCE_FLOOR = 0.55;

function scoreDoor(labelPos, door) {
  const dx = door.threshold.x - labelPos.x;
  const dy = door.threshold.y - labelPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 0.25) return 0;
  return Math.max(0, 1 - dist / 0.25);
}

function matchSignsToDoors(signs, pageDoorMap) {
  const { doors, labels } = pageDoorMap;
  if (doors.length === 0 || labels.size === 0) return [];

  const results = [];
  for (const sign of signs) {
    const roomToken = sign.unit?.toUpperCase().trim() ?? "";
    const labelPos = labels.get(roomToken);
    if (!labelPos) continue;

    const scored = doors
      .map((door) => ({ door, score: scoreDoor(labelPos, door) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) continue;
    const best = scored[0];

    if (best.score < AUTO_CONFIDENCE_FLOOR && scored.length < 2) continue;

    results.push({
      signId: sign.id,
      candidates: scored.slice(0, 3).map((s) => ({
        x: s.door.threshold.x,
        y: s.door.threshold.y,
        confidence: s.score,
        description: `door at (${s.door.threshold.x.toFixed(3)},${s.door.threshold.y.toFixed(3)})`,
      })),
      method: "vector",
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoor(tx, ty) {
  return {
    threshold: { x: tx, y: ty },
    pivot: { x: tx, y: ty },
    openingDir: { x: 1, y: 0 },
    size: 0.05,
    bbox: { x0: tx - 0.02, y0: ty - 0.02, x1: tx + 0.02, y1: ty + 0.02 },
  };
}

function makeSign(id, unit) {
  return { id, unit };
}

function makePageDoorMap(doors, labelEntries) {
  return {
    isVector: true,
    pathOpCount: 10000,
    doors,
    labels: new Map(labelEntries),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scoreDoor", () => {
  it("returns 1.0 when label is exactly at door threshold", () => {
    const door = makeDoor(0.5, 0.5);
    const score = scoreDoor({ x: 0.5, y: 0.5 }, door);
    assert.ok(Math.abs(score - 1.0) < 1e-9);
  });

  it("returns 0 when distance > 0.25", () => {
    const door = makeDoor(0.5, 0.5);
    assert.equal(scoreDoor({ x: 0.8, y: 0.8 }, door), 0);
  });

  it("returns a positive value for distance < 0.25", () => {
    const door = makeDoor(0.5, 0.5);
    const score = scoreDoor({ x: 0.5, y: 0.6 }, door);
    assert.ok(score > 0 && score < 1);
  });
});

describe("matchSignsToDoors — no doors", () => {
  it("returns empty when door list is empty", () => {
    const map = makePageDoorMap([], [["417", { x: 0.3, y: 0.4 }]]);
    const result = matchSignsToDoors([makeSign("s1", "417")], map);
    assert.deepEqual(result, []);
  });
});

describe("matchSignsToDoors — no labels", () => {
  it("returns empty when label map is empty", () => {
    const map = makePageDoorMap([makeDoor(0.3, 0.4)], []);
    const result = matchSignsToDoors([makeSign("s1", "417")], map);
    assert.deepEqual(result, []);
  });
});

describe("matchSignsToDoors — happy path", () => {
  it("matches sign to nearest door", () => {
    const door = makeDoor(0.31, 0.41);
    const map = makePageDoorMap([door], [["417", { x: 0.3, y: 0.4 }]]);
    const result = matchSignsToDoors([makeSign("s1", "417")], map);
    assert.equal(result.length, 1);
    assert.equal(result[0].signId, "s1");
    assert.equal(result[0].method, "vector");
    assert.ok(result[0].candidates.length >= 1);
    const c = result[0].candidates[0];
    assert.ok(c.confidence > 0 && c.confidence <= 1);
    assert.ok(c.x >= 0 && c.x <= 1);
    assert.ok(c.y >= 0 && c.y <= 1);
  });

  it("skips sign whose unit token has no matching label", () => {
    const door = makeDoor(0.3, 0.4);
    const map = makePageDoorMap([door], [["999", { x: 0.3, y: 0.4 }]]);
    const result = matchSignsToDoors([makeSign("s1", "417")], map);
    assert.deepEqual(result, []);
  });
});

describe("matchSignsToDoors — single weak match", () => {
  it("suppresses single candidate with score < AUTO_CONFIDENCE_FLOOR", () => {
    // Door placed just beyond the 0.25 cutoff radius — score will be 0 → filtered
    // Use a door close enough to score but below the floor: dist ~ 0.22 → score ~ 0.12
    const door = makeDoor(0.5 + 0.22, 0.5);
    const map = makePageDoorMap([door], [["101", { x: 0.5, y: 0.5 }]]);
    const result = matchSignsToDoors([makeSign("s1", "101")], map);
    // score = 1 - 0.22/0.25 = 0.12, which is < 0.55 and only 1 candidate → suppressed
    assert.deepEqual(result, []);
  });

  it("allows single candidate when score >= AUTO_CONFIDENCE_FLOOR", () => {
    // dist = 0.05 → score = 1 - 0.05/0.25 = 0.8 > 0.55
    const door = makeDoor(0.5 + 0.05, 0.5);
    const map = makePageDoorMap([door], [["101", { x: 0.5, y: 0.5 }]]);
    const result = matchSignsToDoors([makeSign("s1", "101")], map);
    assert.equal(result.length, 1);
    assert.ok(result[0].candidates[0].confidence >= AUTO_CONFIDENCE_FLOOR);
  });
});

describe("matchSignsToDoors — multiple candidates", () => {
  it("returns up to 3 sorted candidates", () => {
    const doors = [makeDoor(0.35, 0.4), makeDoor(0.31, 0.41), makeDoor(0.28, 0.38)];
    const map = makePageDoorMap(doors, [["200", { x: 0.3, y: 0.4 }]]);
    const result = matchSignsToDoors([makeSign("s1", "200")], map);
    assert.equal(result.length, 1);
    assert.ok(result[0].candidates.length <= 3);
    const confs = result[0].candidates.map((c) => c.confidence);
    for (let i = 1; i < confs.length; i++) {
      assert.ok(confs[i - 1] >= confs[i], "candidates must be sorted descending");
    }
  });

  it("allows low-score best match when scored.length >= 2", () => {
    // best score will be low but there are 2 candidates → should NOT be suppressed
    const doors = [makeDoor(0.5 + 0.22, 0.5), makeDoor(0.5 + 0.23, 0.5)];
    const map = makePageDoorMap(doors, [["300", { x: 0.5, y: 0.5 }]]);
    const result = matchSignsToDoors([makeSign("s1", "300")], map);
    assert.equal(result.length, 1);
  });
});
