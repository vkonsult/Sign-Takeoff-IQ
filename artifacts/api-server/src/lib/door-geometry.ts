/**
 * door-geometry.ts
 *
 * Deterministic vector-based door placement for architectural floor plans.
 *
 * Uses pdfjs getOperatorList() to extract raw PDF path geometry, detects
 * door arc/swing symbols (quarter-circle bezier strokes), then matches each
 * residential unit's room-number label to its nearest door arc.
 *
 * This runs ONCE per page (not once per sign) and returns placements for
 * all signs in a single pass. Results are cached in-memory.
 *
 * Coordinate system: all output coords are normalised [0,1] top-down
 * (y=0 = top of page), matching the SVG overlay system in the frontend.
 */

import fs from "fs/promises";
import { logger } from "./logger";
import type { PageWords } from "./pdf-words";

// pdfjs-dist OPS values (verified against pdfjs-dist@5.4.296 OPS enum)
const OPS_MOVE_TO               = 13;
const OPS_LINE_TO               = 14;
const OPS_CURVE_TO              = 15;  // cubic bezier: x1 y1 x2 y2 x y
const OPS_CURVE_TO2             = 16;  // curveTo variant v: x2 y2 x y
const OPS_CURVE_TO3             = 17;  // curveTo variant y: x1 y1 x y
const OPS_CLOSE_PATH            = 18;
const OPS_STROKE                = 20;
const OPS_CLOSE_STROKE          = 21;
const OPS_FILL                  = 22;
const OPS_EOF_FILL              = 23;
const OPS_FILL_STROKE           = 24;
const OPS_EOF_FILL_STROKE       = 25;
const OPS_CLOSE_FILL_STROKE     = 26;
const OPS_CLOSE_EOF_FILL_STROKE = 27;
const OPS_END_PATH              = 28;
const OPS_CONSTRUCT_PATH        = 91;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DoorGeometry {
  /**
   * Pivot (hinge) point in normalised coords [0-1, top-down].
   * This is the moveTo start-point of the arc path — the hinge corner.
   */
  pivot: { x: number; y: number };
  /**
   * Threshold midpoint — the approximate centre of the door opening.
   * Computed as the centre of the arc bounding box.
   */
  threshold: { x: number; y: number };
  /**
   * Unit vector pointing from the pivot into the room space
   * (the direction the door opens toward).
   * Derived as normalize(threshold − pivot).
   */
  openingDir: { x: number; y: number };
  /** Approximate door width (normalised, diameter of the arc) */
  size: number;
  /** Bounding box of the arc (for debug / candidate scoring) */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface PageDoorMap {
  /** True when the page has substantial vector path geometry (not raster-only) */
  isVector: boolean;
  /** Total number of bezier/path operations found (debug metric) */
  pathOpCount: number;
  /** All detected door arcs on the page */
  doors: DoorGeometry[];
  /**
   * Room-number token index built from PageWords phrases.
   * Key: exact uppercase room-number token (e.g. "417B", "1A").
   * Value: normalised anchor position of the label centroid.
   * Computed once per page so matchSignsToDoors does not re-scan phrases per sign.
   */
  labels: Map<string, { x: number; y: number }>;
}

export interface DoorMatchCandidate {
  x: number;
  y: number;
  confidence: number;
  description: string;
}

export interface DoorMatchResult {
  signId: string;
  candidates: DoorMatchCandidate[];
  method: "vector";
}

// ── In-memory cache keyed by `fileId:pageNum` (max 100 entries) ─────────────
const doorMapCache = new Map<string, PageDoorMap>();

// ── pdfjs loader (same pattern as pdf-words.ts — shares Node module cache) ──

interface PdfjsOperatorList {
  fnArray: number[];
  argsArray: Array<number[] | null>;
}

interface PdfjsPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getOperatorList(): Promise<PdfjsOperatorList>;
}

interface PdfjsDocument {
  getPage(num: number): Promise<PdfjsPage>;
  destroy(): void;
}

interface PdfjsLib {
  getDocument(opts: { data: Uint8Array; disableAutoFetch: boolean; disableStream: boolean }): { promise: Promise<PdfjsDocument> };
  GlobalWorkerOptions: { workerSrc: string };
}

let pdfjsInstance: PdfjsLib | null = null;

async function getPdfjsLib(): Promise<PdfjsLib> {
  if (pdfjsInstance) return pdfjsInstance;
  const imported = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const lib = imported as unknown as PdfjsLib;
  try {
    type NodeRequire = ((id: string) => unknown) & { resolve?: (id: string) => string };
    const req = (globalThis as Record<string, unknown>)["require"] as NodeRequire | undefined;
    if (req && typeof req.resolve === "function") {
      const workerPath = (req.resolve as (id: string) => string)("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
      lib.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;
    }
  } catch {
    lib.GlobalWorkerOptions.workerSrc = "";
  }
  pdfjsInstance = lib;
  return lib;
}

// ── Core geometry extraction ─────────────────────────────────────────────────

/**
 * Walk through the pdfjs operator list and collect all bezier sub-paths,
 * then build the room-number label index from `pageWords` (if provided).
 *
 * PDF coordinate system: origin bottom-left, y increases upward.
 * We flip y → normalized top-down before returning.
 *
 * @param pageWords  Optional pre-extracted text phrases. When supplied, the
 *                   returned `PageDoorMap.labels` map is populated with exact
 *                   room-number token → anchor position entries. Pass `null`
 *                   to skip label indexing (e.g. when called without text).
 */
export async function buildPageDoorMap(
  pdfPath: string,
  fileId: string,
  pageNum: number,
  pageWords: PageWords | null = null,
): Promise<PageDoorMap> {
  const cacheKey = `${fileId}:${pageNum}`;
  const cached = doorMapCache.get(cacheKey);
  // Invalidate cache if labels were not yet built but pageWords is now available
  if (cached && (pageWords === null || cached.labels.size > 0)) return cached;

  let result: PageDoorMap;
  try {
    result = await _extractDoorMap(pdfPath, pageNum, pageWords);
  } catch (err) {
    logger.warn({ err, fileId, pageNum }, "door-geometry: extraction failed, returning empty map");
    result = { isVector: false, pathOpCount: 0, doors: [], labels: new Map() };
  }

  if (doorMapCache.size >= 100) {
    const firstKey = doorMapCache.keys().next().value as string | undefined;
    if (firstKey) doorMapCache.delete(firstKey);
  }
  doorMapCache.set(cacheKey, result);
  return result;
}

async function _extractDoorMap(pdfPath: string, pageNum: number, pageWords: PageWords | null): Promise<PageDoorMap> {
  const lib = await getPdfjsLib();
  const rawBuffer = await fs.readFile(pdfPath);
  const data = new Uint8Array(rawBuffer);
  const doc = await lib.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;

  try {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const pageW = viewport.width;
    const pageH = viewport.height;

    const opList = await page.getOperatorList();
    const { fnArray, argsArray } = opList;

    // Walk operators: collect sub-paths, detect when they end (stroke/fill/endPath).
    // We track the bounding box of each sub-path incrementally.

    type Point = { x: number; y: number };
    interface SubPath {
      /** Start point in PDF coords (the moveTo — i.e. hinge/pivot) */
      start: Point;
      minX: number; maxX: number; minY: number; maxY: number;
      hasCurve: boolean;
      segCount: number;
      /** Length of the longest line segment in this sub-path (in PDF pts) */
      maxLinePts: number;
    }

    const doors: DoorGeometry[] = [];
    let pathOpCount = 0;
    let totalBezierOps = 0;

    // Current graphics state: position in PDF coordinates (pts, y-up)
    let cx = 0;
    let cy = 0;
    // Current open sub-paths
    const subPaths: SubPath[] = [];
    let currentPath: SubPath | null = null;

    const startSubPath = (x: number, y: number) => {
      currentPath = {
        start: { x, y },
        minX: x, maxX: x, minY: y, maxY: y,
        hasCurve: false,
        segCount: 0,
        maxLinePts: 0,
      };
    };

    const extendBbox = (p: SubPath, x: number, y: number) => {
      if (x < p.minX) p.minX = x;
      if (x > p.maxX) p.maxX = x;
      if (y < p.minY) p.minY = y;
      if (y > p.maxY) p.maxY = y;
    };

    const flushSubPaths = () => {
      if (currentPath) {
        subPaths.push(currentPath);
        currentPath = null;
      }
    };

    const processPaths = () => {
      for (const sp of subPaths) {
        if (!sp.hasCurve) continue; // only interested in curved paths (door arcs)
        const w = sp.maxX - sp.minX; // pts
        const h = sp.maxY - sp.minY; // pts

        // Normalise to [0,1]
        const nx0 = Math.max(0, Math.min(1, sp.minX / pageW));
        const nx1 = Math.max(0, Math.min(1, sp.maxX / pageW));
        // y-flip: PDF y-up → top-down
        const ny0 = Math.max(0, Math.min(1, 1 - sp.maxY / pageH)); // top (smaller y in top-down)
        const ny1 = Math.max(0, Math.min(1, 1 - sp.minY / pageH)); // bottom

        const normW = nx1 - nx0;
        const normH = ny1 - ny0;

        // Door arc heuristics: aspect ratio ~1:1 (quarter-circle), normalised size 1-12%,
        // min 6 pts, 1-8 segments. Adjacent line check (radius arm ≈ arc radius) only for
        // paths with ≥2 segments — bare M+C arcs (segCount=1) have their arm in a separate sub-path.
        const minPts = 6;
        const maxPts = 200;
        const minNorm = 0.01;
        const maxNorm = 0.12;

        if (w < minPts || h < minPts || w > maxPts || h > maxPts) continue;
        if (normW < minNorm || normH < minNorm || normW > maxNorm || normH > maxNorm) continue;

        // Tighter aspect ratio: quarter-circle bbox is nearly square
        const aspectRatio = normW / normH;
        if (aspectRatio < 0.6 || aspectRatio > 1.8) continue;

        // Segment count: door arcs have 1–8 segments
        // (1 = bare M+C quarter-circle; 2+ = arc with radius arm(s) in same sub-path)
        if (sp.segCount < 1 || sp.segCount > 8) continue;

        // Adjacent line check: only for paths with ≥2 segments (combined arc+arm).
        // Bare M+C paths (segCount=1) skip this — their radius arm is a separate sub-path.
        if (sp.segCount >= 2) {
          const arcRadiusPts = Math.max(w, h) / 2;
          const lineOk = sp.maxLinePts >= arcRadiusPts * 0.6 && sp.maxLinePts <= arcRadiusPts * 1.4;
          if (!lineOk) continue;
        }

        // Pivot within page bounds — reject off-page elements (title-block stamps)
        const rawPivotNx = sp.start.x / pageW;
        const rawPivotNy = 1 - sp.start.y / pageH;
        if (rawPivotNx < 0 || rawPivotNx > 1 || rawPivotNy < 0 || rawPivotNy > 1) continue;

        const thresholdX = (nx0 + nx1) / 2;
        const thresholdY = (ny0 + ny1) / 2;
        const size = Math.max(normW, normH);

        // Pivot: normalised coords of the moveTo start point (hinge corner)
        const pivotX = Math.max(0, Math.min(1, rawPivotNx));
        const pivotY = Math.max(0, Math.min(1, rawPivotNy));

        // Opening direction: unit vector from pivot toward the arc centre (into the room)
        const odx = thresholdX - pivotX;
        const ody = thresholdY - pivotY;
        const odLen = Math.sqrt(odx * odx + ody * ody);
        const openingDir = odLen > 1e-6
          ? { x: odx / odLen, y: ody / odLen }
          : { x: 0, y: 1 }; // fallback: downward

        doors.push({
          pivot: { x: pivotX, y: pivotY },
          threshold: { x: thresholdX, y: thresholdY },
          openingDir,
          size,
          bbox: { x0: nx0, y0: ny0, x1: nx1, y1: ny1 },
        });
      }
      subPaths.length = 0;
    };

    /**
     * Process a single path drawing op and its args (used for both individual
     * ops and ops unwrapped from a constructPath bundle).
     *
     * `flatArgs` is the flat coordinate array for the single op.
     * Returns the updated current position { cx, cy }.
     */
    const processOp = (op: number, flatArgs: number[]): void => {
      switch (op) {
        case OPS_MOVE_TO: {
          flushSubPaths();
          pathOpCount++;
          cx = flatArgs[0] ?? 0;
          cy = flatArgs[1] ?? 0;
          startSubPath(cx, cy);
          break;
        }
        case OPS_LINE_TO: {
          pathOpCount++;
          const prevLx = cx;
          const prevLy = cy;
          cx = flatArgs[0] ?? 0;
          cy = flatArgs[1] ?? 0;
          if (currentPath) {
            const linePts = Math.sqrt((cx - prevLx) ** 2 + (cy - prevLy) ** 2);
            if (linePts > currentPath.maxLinePts) currentPath.maxLinePts = linePts;
            extendBbox(currentPath, cx, cy);
            currentPath.segCount++;
          }
          break;
        }
        case OPS_CURVE_TO: {
          // cubic bezier: x1 y1 x2 y2 x y
          pathOpCount++;
          totalBezierOps++;
          const cv1x = flatArgs[0] ?? 0;
          const cv1y = flatArgs[1] ?? 0;
          const cv2x = flatArgs[2] ?? 0;
          const cv2y = flatArgs[3] ?? 0;
          cx = flatArgs[4] ?? 0;
          cy = flatArgs[5] ?? 0;
          if (currentPath) {
            currentPath.hasCurve = true;
            extendBbox(currentPath, cv1x, cv1y);
            extendBbox(currentPath, cv2x, cv2y);
            extendBbox(currentPath, cx, cy);
            currentPath.segCount++;
          }
          break;
        }
        case OPS_CURVE_TO2: {
          // v: CP1 = current point, x2 y2 x y
          pathOpCount++;
          totalBezierOps++;
          const cv2x = flatArgs[0] ?? 0;
          const cv2y = flatArgs[1] ?? 0;
          cx = flatArgs[2] ?? 0;
          cy = flatArgs[3] ?? 0;
          if (currentPath) {
            currentPath.hasCurve = true;
            extendBbox(currentPath, cv2x, cv2y);
            extendBbox(currentPath, cx, cy);
            currentPath.segCount++;
          }
          break;
        }
        case OPS_CURVE_TO3: {
          // y: x1 y1 x y, CP2 = end point
          pathOpCount++;
          totalBezierOps++;
          const cv1x = flatArgs[0] ?? 0;
          const cv1y = flatArgs[1] ?? 0;
          cx = flatArgs[2] ?? 0;
          cy = flatArgs[3] ?? 0;
          if (currentPath) {
            currentPath.hasCurve = true;
            extendBbox(currentPath, cv1x, cv1y);
            extendBbox(currentPath, cx, cy);
            currentPath.segCount++;
          }
          break;
        }
        case OPS_CLOSE_PATH: {
          if (currentPath) {
            extendBbox(currentPath, currentPath.start.x, currentPath.start.y);
            currentPath.segCount++;
          }
          break;
        }
        case OPS_STROKE:
        case OPS_CLOSE_STROKE:
        case OPS_FILL:
        case OPS_EOF_FILL:
        case OPS_FILL_STROKE:
        case OPS_EOF_FILL_STROKE:
        case OPS_CLOSE_FILL_STROKE:
        case OPS_CLOSE_EOF_FILL_STROKE:
        case OPS_END_PATH: {
          flushSubPaths();
          processPaths();
          cx = 0;
          cy = 0;
          break;
        }
        default:
          break;
      }
    };

    for (let i = 0; i < fnArray.length; i++) {
      const op = fnArray[i]!;
      const args = argsArray[i] ?? [];

      if (op === OPS_CONSTRUCT_PATH) {
        // constructPath (OPS=91) layout in pdfjs-dist@5.x:
        //   args[0]  — paint op (number: fill/stroke/endPath)
        //   args[1]  — Array[1]; args[1][0] is ArrayLike with interleaved internal ops:
        //              0=moveTo(x,y)  1=lineTo(x,y)  2=curveTo(x1,y1,x2,y2,x,y)  3=closePath
        //   args[2]  — bounding box (ignored; we track bbox ourselves)
        const rawArgs = args as unknown[];
        const paintOp = typeof rawArgs[0] === "number" ? rawArgs[0] : null;
        if (paintOp === null) continue;

        const innerWrapper = rawArgs[1];
        const innerRaw: unknown = Array.isArray(innerWrapper) ? innerWrapper[0] : innerWrapper;
        if (!innerRaw || typeof innerRaw !== "object") {
          processOp(paintOp, []);
          continue;
        }

        const flat = Array.from(innerRaw as ArrayLike<number>);
        if (flat.length === 0) {
          processOp(paintOp, []);
          continue;
        }

        {
          let idx = 0;
          while (idx < flat.length) {
            const internalOp = flat[idx++] as number;
            switch (internalOp) {
              case 0: { // moveTo
                const mx = flat[idx++] ?? 0;
                const my = flat[idx++] ?? 0;
                processOp(OPS_MOVE_TO, [mx, my]);
                break;
              }
              case 1: { // lineTo
                const lx = flat[idx++] ?? 0;
                const ly = flat[idx++] ?? 0;
                processOp(OPS_LINE_TO, [lx, ly]);
                break;
              }
              case 2: { // curveTo (cubic bezier)
                const cv1x = flat[idx++] ?? 0;
                const cv1y = flat[idx++] ?? 0;
                const cv2x = flat[idx++] ?? 0;
                const cv2y = flat[idx++] ?? 0;
                const ex = flat[idx++] ?? 0;
                const ey = flat[idx++] ?? 0;
                processOp(OPS_CURVE_TO, [cv1x, cv1y, cv2x, cv2y, ex, ey]);
                break;
              }
              case 3: { // closePath
                processOp(OPS_CLOSE_PATH, []);
                break;
              }
              default:
                // Unknown internal op — stop parsing this constructPath
                idx = flat.length;
                break;
            }
          }
        }

        // Fire the outer paint op (flush and process accumulated sub-paths)
        processOp(paintOp, []);
      } else {
        processOp(op, args as number[]);
      }
    }

    // Flush any remaining open path
    flushSubPaths();
    processPaths();

    // A page is "vector" if it has substantial path operations.
    // Raster pages typically have 0-2 path ops (just the image frame rectangle).
    // We use 50 as threshold to distinguish raster (near-zero ops) from vector floor plans.
    const isVector = pathOpCount > 50;

    // ── Build room-number label index from pageWords ──────────────────────────
    // Keyed by the exact uppercase room-number token found in any phrase.
    // This is computed once here so matchSignsToDoors does not re-scan phrases
    // for every sign. We index ALL whitespace-delimited tokens from all phrases.
    const labels = new Map<string, { x: number; y: number }>();
    if (pageWords) {
      for (const phrase of pageWords.phrases) {
        const cx = (phrase.x0 + phrase.x1) / 2;
        const cy = (phrase.y0 + phrase.y1) / 2;
        const tokens = phrase.text.trim().toUpperCase().split(/\s+/);
        for (const tok of tokens) {
          if (tok.length === 0) continue;
          // Only store the first occurrence of each token (most prominent label)
          if (!labels.has(tok)) {
            labels.set(tok, { x: cx, y: cy });
          }
        }
      }
    }

    logger.info({
      pageNum,
      pathOpCount,
      totalBezierOps,
      doorsFound: doors.length,
      labelsIndexed: labels.size,
      isVector,
    }, "door-geometry: extraction complete");

    doc.destroy();
    return { isVector, pathOpCount, doors, labels };
  } catch (err) {
    doc.destroy();
    throw err;
  }
}

// ── Room label → door matching ───────────────────────────────────────────────

// ── Confidence thresholds ────────────────────────────────────────────────────
/** Distance ≤ this fraction of searchRadius → confident auto-place (score ≥ AUTO_CONFIDENCE_FLOOR) */
const AUTO_CONFIDENCE_FLOOR = 0.75;
/** Score below this → don't include in candidates at all */
const MIN_CANDIDATE_SCORE = 0.35;
/** Orientation weight in the combined score (0 = ignore orientation, 1 = pure orientation) */
const ORIENTATION_WEIGHT = 0.25;

/**
 * For each sign, find its room-number label in the drawing phrases, then
 * locate the nearest door arc within the search radius.
 *
 * **Room-number matching** is exact-token keyed — the room number must appear as
 * a standalone whitespace-delimited token in a phrase (e.g., "417B" matches phrase
 * "UNIT 417B" but not "417BC"). `startsWith`/`endsWith` substring patterns are
 * intentionally not used.
 *
 * **Scoring** combines distance and orientation plausibility:
 *   score = (1 − distFraction) * (1 − ORIENTATION_WEIGHT)
 *         + dotProduct(openingDir, labelDir) * ORIENTATION_WEIGHT
 * where `labelDir` is the unit vector from door pivot toward the label anchor.
 *
 * **Confidence bands**:
 * - score ≥ AUTO_CONFIDENCE_FLOOR → single confident match → return only that one (auto-place)
 * - MIN_CANDIDATE_SCORE ≤ score < AUTO_CONFIDENCE_FLOOR → plausible candidate
 * - score < MIN_CANDIDATE_SCORE → excluded
 *
 * @param pageWords   Already-extracted text phrases for this page (from pdf-words.ts)
 * @param doorMap     Door map for this page (from buildPageDoorMap)
 * @param signs       The residential signs to place
 * @param searchRadius How far (normalised) to search for a door arc. Default 0.08.
 */
export function matchSignsToDoors(
  _pageWords: PageWords | null,
  doorMap: PageDoorMap,
  signs: Array<{ signId: string; roomNumber?: string | null; anchorX?: number | null; anchorY?: number | null }>,
  searchRadius = 0.08,
): DoorMatchResult[] {
  if (!doorMap.isVector || doorMap.doors.length === 0) {
    return signs.map((s) => ({ signId: s.signId, candidates: [], method: "vector" as const }));
  }

  const results: DoorMatchResult[] = [];

  for (const sign of signs) {
    const roomNum = (sign.roomNumber ?? "").trim().toUpperCase();
    if (!roomNum) {
      results.push({ signId: sign.signId, candidates: [], method: "vector" });
      continue;
    }

    // Exact-token room-number lookup — must be present in doorMap.labels for a vector match.
    // Labels are keyed by uppercase whitespace-delimited tokens (e.g., "417B" ≠ "417BC").
    const labelPos = doorMap.labels.get(roomNum);
    if (!labelPos) {
      results.push({ signId: sign.signId, candidates: [], method: "vector" });
      continue;
    }

    const anchorX = labelPos.x;
    const anchorY = labelPos.y;

    // Score all doors within searchRadius
    const scored: Array<{ door: DoorGeometry; dist: number; score: number }> = [];

    for (const door of doorMap.doors) {
      const dx = door.threshold.x - anchorX;
      const dy = door.threshold.y - anchorY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > searchRadius) continue;

      // Distance component: 1.0 at dist=0, 0.0 at searchRadius
      const distFraction = Math.min(1, dist / searchRadius);
      const distScore = 1 - distFraction;

      // Orientation plausibility: dot product of door's openingDir with the unit
      // vector pointing from the door pivot TOWARD the room label anchor.
      // A positive dot product means the door opens toward the room — good.
      const ldx = anchorX - door.pivot.x;
      const ldy = anchorY - door.pivot.y;
      const ldLen = Math.sqrt(ldx * ldx + ldy * ldy);
      const orientScore = ldLen > 1e-6
        ? Math.max(0, (door.openingDir.x * ldx + door.openingDir.y * ldy) / ldLen)
        : 0;

      const score = distScore * (1 - ORIENTATION_WEIGHT) + orientScore * ORIENTATION_WEIGHT;
      if (score >= MIN_CANDIDATE_SCORE) {
        scored.push({ door, dist, score });
      }
    }

    if (scored.length === 0) {
      results.push({ signId: sign.signId, candidates: [], method: "vector" });
      continue;
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0]!;

    // Confidence-band gating:
    //   ≥ AUTO_CONFIDENCE_FLOOR → single confident match (auto-place)
    //   < AUTO_CONFIDENCE_FLOOR, ≥2 candidates → present up to 3 for user selection
    //   < AUTO_CONFIDENCE_FLOOR, only 1 candidate → suppress; let Gemini handle
    let candidateSlice: typeof scored;
    if (best.score >= AUTO_CONFIDENCE_FLOOR) {
      candidateSlice = [best];
    } else if (scored.length >= 2) {
      candidateSlice = scored.slice(0, 3);
    } else {
      results.push({ signId: sign.signId, candidates: [], method: "vector" });
      continue;
    }

    const candidates: DoorMatchCandidate[] = candidateSlice.map(({ door, score }) => ({
      x: door.threshold.x,
      y: door.threshold.y,
      confidence: parseFloat(score.toFixed(2)),
      description: `Vector: door at (${door.threshold.x.toFixed(3)}, ${door.threshold.y.toFixed(3)}) for room ${roomNum}`,
    }));

    results.push({ signId: sign.signId, candidates, method: "vector" });
  }

  return results;
}
