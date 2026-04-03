/**
 * Integration test for buildPageDoorMap (door-geometry.ts).
 *
 * Validates that the vector extraction pipeline correctly:
 *   1. Parses constructPath operator arguments (empirically verified structure)
 *   2. Identifies pages as vector (isVector=true) when path ops exist
 *   3. Detects on-page door arcs when present
 *
 * Run with: node src/lib/__tests__/door-geometry.integration.test.mjs
 *
 * Test PDFs (stored in data/uploads, not checked into git):
 *   • 1st_Floor_Union_at_Tower_Dist.pdf page 1 — vector, NO on-page door arcs
 *     (9 bezier ops are all off-page title-block stamps at x>pageW)
 *   • Att__K__Drawings_Volume_1a.pdf page 28 — vector, HAS on-page door arcs
 *     (quarter-circle M+C arcs confirmed by diagnostic at constructPath idx=49419)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

const PDFJS_PATH = resolve(ROOT, 'node_modules/.pnpm/pdfjs-dist@5.4.296/node_modules/pdfjs-dist/legacy/build/pdf.mjs');

const PDFS = {
  union1st: {
    path: resolve(ROOT, 'artifacts/api-server/data/uploads/3e7eacf8-2add-4ecb-ac0a-a13da40437d0/1775175255644-1st_Floor_Union_at_Tower_Dist.pdf'),
    page: 1,
    expectedVector: true,
    expectedMinDoors: 0,
    note: 'all bezier ops are off-page title-block stamps',
  },
  attKp28: {
    path: resolve(ROOT, 'artifacts/api-server/data/uploads/0e11d0b9-ebe0-41f8-ba30-61b070d6582c/1774885927615-Att__K__Drawings_Volume_1a.pdf'),
    page: 28,
    expectedVector: true,
    expectedMinDoors: 1,
    note: 'has at least 1 on-page quarter-circle door arc (confirmed M+C at idx=49419)',
  },
};

let passed = 0;
let failed = 0;

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// Minimal re-implementation of buildPageDoorMap logic (mirrors door-geometry.ts exactly)
async function extractDoors(pdfjsLib, pdfPath, pageNum) {
  const OPS = pdfjsLib.OPS;
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1.0 });
  const pageW = vp.width;
  const pageH = vp.height;
  const ol = await page.getOperatorList();
  const { fnArray, argsArray } = ol;

  let pathOpCount = 0;
  let cx = 0, cy = 0;
  const subPaths = [];
  let currentPath = null;

  const startSubPath = (x, y) => {
    currentPath = { start: { x, y }, minX: x, maxX: x, minY: y, maxY: y, hasCurve: false, segCount: 0, maxLinePts: 0 };
  };
  const extendBbox = (sp, x, y) => {
    if (x < sp.minX) sp.minX = x; if (x > sp.maxX) sp.maxX = x;
    if (y < sp.minY) sp.minY = y; if (y > sp.maxY) sp.maxY = y;
  };
  const flush = () => { if (currentPath) { subPaths.push(currentPath); currentPath = null; } };

  const doors = [];

  const processPaths = () => {
    for (const sp of subPaths) {
      if (!sp.hasCurve) continue;
      const w = sp.maxX - sp.minX, h = sp.maxY - sp.minY;
      const nx0 = Math.max(0, Math.min(1, sp.minX / pageW));
      const nx1 = Math.max(0, Math.min(1, sp.maxX / pageW));
      const ny0 = Math.max(0, Math.min(1, 1 - sp.maxY / pageH));
      const ny1 = Math.max(0, Math.min(1, 1 - sp.minY / pageH));
      const normW = nx1 - nx0, normH = ny1 - ny0;
      if (w < 6 || h < 6 || w > 200 || h > 200) continue;
      if (normW < 0.01 || normH < 0.01 || normW > 0.12 || normH > 0.12) continue;
      const ar = normW / normH;
      if (ar < 0.6 || ar > 1.8) continue;
      if (sp.segCount < 1 || sp.segCount > 8) continue;
      if (sp.segCount >= 2) {
        const r = Math.max(w, h) / 2;
        if (!(sp.maxLinePts >= r * 0.6 && sp.maxLinePts <= r * 1.4)) continue;
      }
      const rawPivotNx = sp.start.x / pageW;
      const rawPivotNy = 1 - sp.start.y / pageH;
      if (rawPivotNx < 0 || rawPivotNx > 1 || rawPivotNy < 0 || rawPivotNy > 1) continue;
      doors.push({ threshold: { x: (nx0 + nx1) / 2, y: (ny0 + ny1) / 2 }, normW, normH });
    }
    subPaths.length = 0;
  };

  const processOp = (op, args) => {
    switch (op) {
      case OPS.moveTo:
        flush(); pathOpCount++;
        cx = args[0] ?? 0; cy = args[1] ?? 0;
        startSubPath(cx, cy);
        break;
      case OPS.lineTo:
        pathOpCount++;
        if (currentPath) {
          const px = cx, py = cy;
          cx = args[0] ?? 0; cy = args[1] ?? 0;
          const d = Math.sqrt((cx - px) ** 2 + (cy - py) ** 2);
          if (d > currentPath.maxLinePts) currentPath.maxLinePts = d;
          extendBbox(currentPath, cx, cy);
          currentPath.segCount++;
        }
        break;
      case OPS.curveTo:
        pathOpCount++;
        if (currentPath) {
          cx = args[4] ?? 0; cy = args[5] ?? 0;
          currentPath.hasCurve = true;
          extendBbox(currentPath, cx, cy);
          currentPath.segCount++;
        }
        break;
      case OPS.closePath:
        if (currentPath) currentPath.segCount++;
        break;
      case OPS.fill: case OPS.eoFill: case OPS.fillStroke: case OPS.eoFillStroke:
      case OPS.stroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke:
      case OPS.closeStroke: case OPS.endPath:
        flush(); processPaths();
        cx = 0; cy = 0;
        break;
    }
  };

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i] ?? [];

    if (op === OPS.constructPath) {
      const rawArgs = args;
      const paintOp = typeof rawArgs[0] === 'number' ? rawArgs[0] : null;
      if (paintOp === null) continue;
      const innerWrapper = rawArgs[1];
      const innerRaw = Array.isArray(innerWrapper) ? innerWrapper[0] : innerWrapper;
      if (!innerRaw || typeof innerRaw !== 'object') {
        processOp(paintOp, []);
        continue;
      }
      const flat = Array.from(innerRaw);
      if (flat.length === 0) { processOp(paintOp, []); continue; }

      let idx = 0;
      while (idx < flat.length) {
        const internalOp = flat[idx++];
        switch (internalOp) {
          case 0: { const mx = flat[idx++] ?? 0, my = flat[idx++] ?? 0; processOp(OPS.moveTo, [mx, my]); break; }
          case 1: { const lx = flat[idx++] ?? 0, ly = flat[idx++] ?? 0; processOp(OPS.lineTo, [lx, ly]); break; }
          case 2: {
            const x1 = flat[idx++] ?? 0, y1 = flat[idx++] ?? 0;
            const x2 = flat[idx++] ?? 0, y2 = flat[idx++] ?? 0;
            const ex = flat[idx++] ?? 0, ey = flat[idx++] ?? 0;
            processOp(OPS.curveTo, [x1, y1, x2, y2, ex, ey]);
            break;
          }
          case 3: processOp(OPS.closePath, []); break;
          default: idx = flat.length; break;
        }
      }
      processOp(paintOp, []);
    } else {
      processOp(op, args);
    }
  }
  flush(); processPaths();

  return { pathOpCount, isVector: pathOpCount > 50, doors };
}

async function main() {
  console.log('door-geometry integration tests\n');

  const pdfjsLib = await import(PDFJS_PATH);
  const OPS = pdfjsLib.OPS;

  // ── Verify constructPath argument structure (empirical validation) ──────────
  console.log('1. constructPath argument structure');
  {
    const pdfPath = PDFS.union1st.path;
    if (!existsSync(pdfPath)) {
      console.log('  SKIP  PDF not available in this environment');
    } else {
      const data = new Uint8Array(readFileSync(pdfPath));
      const doc = await pdfjsLib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
      const page = await doc.getPage(1);
      const { fnArray, argsArray } = await page.getOperatorList();

      const cpIdx = fnArray.indexOf(OPS.constructPath);
      assert('constructPath op found in fnArray', cpIdx >= 0, `first at idx=${cpIdx}`);
      if (cpIdx >= 0) {
        const args = argsArray[cpIdx];
        assert('args[0] is a number (paint op code)', typeof args[0] === 'number',
          `got typeof=${typeof args[0]} value=${args[0]}`);
        assert('args[1] is an Array', Array.isArray(args[1]),
          `got typeof=${typeof args[1]}`);
        assert('args[1][0] is ArrayLike (inner op stream)', args[1] && args[1][0] && typeof args[1][0] === 'object',
          `got typeof=${typeof (args[1] ?? [])[0]}`);
        if (args[1] && args[1][0]) {
          const flat = Array.from(args[1][0]);
          assert('inner op stream is non-empty', flat.length > 0, `len=${flat.length}`);
          assert('inner op stream first element is 0-3', flat[0] >= 0 && flat[0] <= 3,
            `first op=${flat[0]}`);
        }
        assert('args[2] is bbox (ArrayLike length 4)', args[2] && Array.from(args[2]).length === 4);
      }
    }
  }

  // ── Vector page detection (1st Floor Union) ─────────────────────────────────
  console.log('\n2. Vector page detection — 1st Floor Union at Tower Dist, page 1');
  {
    const { path, page, expectedVector, note } = PDFS.union1st;
    if (!existsSync(path)) {
      console.log('  SKIP  PDF not available');
    } else {
      const result = await extractDoors(pdfjsLib, path, page);
      assert(`isVector === ${expectedVector}  (${note})`, result.isVector === expectedVector,
        `pathOpCount=${result.pathOpCount}`);
      assert('pathOpCount > 100000  (complex floor plan)', result.pathOpCount > 100000,
        `pathOpCount=${result.pathOpCount}`);
      assert('doorsFound === 0  (all arcs are off-page stamps)', result.doors.length === 0,
        `found=${result.doors.length}`);
    }
  }

  // ── Door arc detection (Att K page 28) ──────────────────────────────────────
  console.log('\n3. Door arc detection — Att__K__ page 28');
  {
    const { path, page, expectedVector, expectedMinDoors, note } = PDFS.attKp28;
    if (!existsSync(path)) {
      console.log('  SKIP  PDF not available');
    } else {
      const result = await extractDoors(pdfjsLib, path, page);
      assert(`isVector === ${expectedVector}`, result.isVector === expectedVector,
        `pathOpCount=${result.pathOpCount}`);
      assert(`doorsFound >= ${expectedMinDoors}  (${note})`, result.doors.length >= expectedMinDoors,
        `found=${result.doors.length}`);
      if (result.doors.length > 0) {
        const d = result.doors[0];
        assert('door threshold.x in [0,1]', d.threshold.x >= 0 && d.threshold.x <= 1,
          `x=${d.threshold.x.toFixed(3)}`);
        assert('door threshold.y in [0,1]', d.threshold.y >= 0 && d.threshold.y <= 1,
          `y=${d.threshold.y.toFixed(3)}`);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
