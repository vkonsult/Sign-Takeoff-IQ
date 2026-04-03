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

// ── pdfjs PDF operator codes (verified from pdfjs-dist OPS enum at runtime) ──
// Modern pdfjs bundles path ops into constructPath (91). Individual ops also
// appear for compatibility. These values match pdfjs-dist v4.x OPS object.
const OPS_MOVE_TO    = 13;  // m  — moveto
const OPS_LINE_TO    = 14;  // l  — lineto
const OPS_CURVE_TO   = 15;  // c  — curveto (cubic bezier: x1 y1 x2 y2 x y)
const OPS_CURVE_TO2  = 16;  // v  — curveto variant (x2 y2 x y)
const OPS_CURVE_TO3  = 17;  // y  — curveto variant (x1 y1 x y)
const OPS_CLOSE_PATH = 18;  // h  — closepath
const OPS_STROKE           = 20;  // S  — stroke current path
const OPS_CLOSE_STROKE     = 21;  // s  — close and stroke
const OPS_FILL             = 22;  // f  — fill
const OPS_EOF_FILL         = 23;  // f* — even-odd fill
const OPS_FILL_STROKE      = 25;  // B  — fill+stroke
const OPS_EOF_FILL_STROKE  = 26;  // B* — eo fill+stroke
const OPS_CLOSE_FILL_STROKE      = 27;
const OPS_CLOSE_EOF_FILL_STROKE  = 24;
const OPS_END_PATH         = 28;  // n  — end path without painting
const OPS_CONSTRUCT_PATH   = 91;  // constructPath — bundles path ops in modern pdfjs

// ── Types ────────────────────────────────────────────────────────────────────

export interface DoorGeometry {
  /** Center x of the door arc bounding box (normalised 0-1, left = 0) */
  x: number;
  /** Center y of the door arc bounding box (normalised 0-1, top = 0) */
  y: number;
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
    const req = (globalThis as Record<string, unknown>)["require"] as ((id: string) => unknown & { resolve?: (id: string) => string }) | undefined;
    if (req && typeof (req as { resolve?: (id: string) => string }).resolve === "function") {
      const workerPath = (req as { resolve: (id: string) => string }).resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
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
 * Walk through the pdfjs operator list and collect all bezier sub-paths.
 * Returns the extracted door map for the page.
 *
 * PDF coordinate system: origin bottom-left, y increases upward.
 * We flip y → normalized top-down before returning.
 */
export async function buildPageDoorMap(
  pdfPath: string,
  fileId: string,
  pageNum: number,
): Promise<PageDoorMap> {
  const cacheKey = `${fileId}:${pageNum}`;
  const cached = doorMapCache.get(cacheKey);
  if (cached) return cached;

  let result: PageDoorMap;
  try {
    result = await _extractDoorMap(pdfPath, pageNum);
  } catch (err) {
    logger.warn({ err, fileId, pageNum }, "door-geometry: extraction failed, returning empty map");
    result = { isVector: false, pathOpCount: 0, doors: [] };
  }

  if (doorMapCache.size >= 100) {
    const firstKey = doorMapCache.keys().next().value as string | undefined;
    if (firstKey) doorMapCache.delete(firstKey);
  }
  doorMapCache.set(cacheKey, result);
  return result;
}

async function _extractDoorMap(pdfPath: string, pageNum: number): Promise<PageDoorMap> {
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
      start: Point;
      minX: number; maxX: number; minY: number; maxY: number;
      hasCurve: boolean;
      segCount: number;
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

        // Door arc heuristics:
        // 1. Bounding box in door-size range (0.008 to 0.18 normalised — ~6-130pt on an 800pt page)
        // 2. Aspect ratio roughly square-ish (0.2 to 5.0 — allows for some elongation due to perspective)
        // 3. Minimum size threshold in pts (avoid tiny text-outline curves)
        const minPts = 6;
        const maxPts = 200; // max door width ~200pt (~2.8 inches at 72dpi)
        const minNorm = 0.006;
        const maxNorm = 0.20;

        if (w < minPts || h < minPts || w > maxPts || h > maxPts) continue;
        if (normW < minNorm || normH < minNorm || normW > maxNorm || normH > maxNorm) continue;

        const aspectRatio = normW / normH;
        if (aspectRatio < 0.2 || aspectRatio > 5.0) continue;

        // Segment count check: door swings are simple (1-8 segments); reject complex shapes
        if (sp.segCount > 10) continue;

        const cx = (nx0 + nx1) / 2;
        const cy = (ny0 + ny1) / 2;
        const size = Math.max(normW, normH);

        doors.push({ x: cx, y: cy, size, bbox: { x0: nx0, y0: ny0, x1: nx1, y1: ny1 } });
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
          cx = flatArgs[0] ?? 0;
          cy = flatArgs[1] ?? 0;
          if (currentPath) {
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
        // constructPath bundles multiple path sub-ops in a single operator.
        //
        // Actual pdfjs structure (verified):
        //   args[0] = paint op code (fill/stroke/endPath — one of pdfjs's OPS values)
        //   args[1] = array-like (Uint8Array or plain Array) of interleaved:
        //             [internalOp, x?, y?, internalOp, x?, y?, ...]
        //             where internalOp encoding is: 0=moveTo, 1=lineTo, 2=curveTo, 3=closePath
        //   args[2] = bounding box {0:minX, 1:minY, 2:maxX, 3:maxY} (ignored here)
        //
        // After parsing inner ops, we also fire the outer paint op (args[0]).

        const paintOp = (args as unknown as number[])[0] as number;
        // args[1] is an array containing the path data array-like: args[1][0] is the actual data
        const innerWrapper = (args as unknown as unknown[])[1];
        const innerRaw = Array.isArray(innerWrapper) ? innerWrapper[0] : innerWrapper;

        if (innerRaw && typeof innerRaw === "object") {
          // Convert array-like to a plain array of numbers
          const flat = Array.from(innerRaw as ArrayLike<number>);
          let idx = 0;

          while (idx < flat.length) {
            const internalOp = flat[idx++] as number;
            // Internal constructPath op encoding (NOT pdfjs OPS!):
            // 0 = moveTo (2 args)
            // 1 = lineTo (2 args)
            // 2 = curveTo — cubic bezier (6 args: x1 y1 x2 y2 x y)
            // 3 = closePath (0 args)
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

    logger.info({
      pageNum,
      pathOpCount,
      totalBezierOps,
      doorsFound: doors.length,
      isVector,
    }, "door-geometry: extraction complete");

    doc.destroy();
    return { isVector, pathOpCount, doors };
  } catch (err) {
    doc.destroy();
    throw err;
  }
}

// ── Room label → door matching ───────────────────────────────────────────────

/**
 * For each sign, find its room-number label in the drawing phrases, then
 * locate the nearest door arc within the search radius.
 *
 * Matching is keyed on the exact room number (e.g. "417B"), not on fuzzy
 * unit-type matching.
 *
 * @param pageWords   Already-extracted text phrases for this page (from pdf-words.ts)
 * @param doorMap     Door map for this page (from buildPageDoorMap)
 * @param signs       The residential signs to place
 * @param searchRadius How far (normalised) to look for a door arc from the label. Default 0.08.
 */
export function matchSignsToDoors(
  pageWords: PageWords,
  doorMap: PageDoorMap,
  signs: Array<{ signId: string; roomNumber?: string | null; anchorX?: number | null; anchorY?: number | null }>,
  searchRadius = 0.08,
): DoorMatchResult[] {
  if (!doorMap.isVector || doorMap.doors.length === 0) {
    // Not a vector page or no doors found — return empty (will fall back to Gemini)
    return signs.map((s) => ({ signId: s.signId, candidates: [], method: "vector" as const }));
  }

  const results: DoorMatchResult[] = [];

  for (const sign of signs) {
    const roomNum = (sign.roomNumber ?? "").trim().toUpperCase();
    if (!roomNum) {
      results.push({ signId: sign.signId, candidates: [], method: "vector" });
      continue;
    }

    // Find phrase(s) in the drawing that exactly match the room number.
    // Exact boundary match: the phrase must equal the room number (ignoring case
    // and leading/trailing whitespace). We don't do fuzzy matching here.
    const labelPhrases = pageWords.phrases.filter((p) => {
      const t = p.text.trim().toUpperCase();
      return t === roomNum || t.endsWith(` ${roomNum}`) || t.startsWith(`${roomNum} `);
    });

    // If no phrase matches, fall back to anchor hint (annotation-band position)
    let anchorX: number;
    let anchorY: number;

    if (labelPhrases.length > 0) {
      // Use the centroid of the first (most confident) matching phrase
      const ph = labelPhrases[0]!;
      anchorX = (ph.x0 + ph.x1) / 2;
      anchorY = (ph.y0 + ph.y1) / 2;
    } else if (sign.anchorX != null && sign.anchorY != null) {
      anchorX = sign.anchorX;
      anchorY = sign.anchorY;
    } else {
      // No anchor at all — can't match
      results.push({ signId: sign.signId, candidates: [], method: "vector" });
      continue;
    }

    // Find all doors within the search radius of the anchor, scored by distance
    const nearby: Array<{ door: DoorGeometry; dist: number }> = [];
    for (const door of doorMap.doors) {
      const dx = door.x - anchorX;
      const dy = door.y - anchorY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= searchRadius) {
        nearby.push({ door, dist });
      }
    }

    if (nearby.length === 0) {
      // No door found in primary radius; try double radius for candidate suggestions
      for (const door of doorMap.doors) {
        const dx = door.x - anchorX;
        const dy = door.y - anchorY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= searchRadius * 2.5) {
          nearby.push({ door, dist });
        }
      }
    }

    if (nearby.length === 0) {
      results.push({ signId: sign.signId, candidates: [], method: "vector" });
      continue;
    }

    // Sort by distance ascending
    nearby.sort((a, b) => a.dist - b.dist);

    // Build candidates (up to 3)
    const candidates: DoorMatchCandidate[] = nearby.slice(0, 3).map(({ door, dist }) => {
      // Confidence: 1.0 at dist=0, decays to 0.5 at searchRadius, 0.2 at 2.5*searchRadius
      const confidence = Math.max(0.1, 1.0 - (dist / (searchRadius * 2.5)) * 0.8);
      return {
        x: door.x,
        y: door.y,
        confidence: parseFloat(confidence.toFixed(2)),
        description: `Vector: door arc at (${door.x.toFixed(3)}, ${door.y.toFixed(3)}) for room ${roomNum}`,
      };
    });

    results.push({ signId: sign.signId, candidates, method: "vector" });
  }

  return results;
}
