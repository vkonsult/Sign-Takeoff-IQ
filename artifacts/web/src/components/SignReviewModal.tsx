import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { apiFetch } from "@/lib/apiClient";
import { usePdfBlob } from "@/hooks/use-pdf-blob";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Save,
  Loader2,
  FileText,
  AlertTriangle,
  MapPin,
  Eye,
  EyeOff,
  PenLine,
  MousePointer,
  Trash2,
  Plus,
  CheckCircle,
  Sparkles,
} from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

interface ExtractedSign {
  id: string;
  jobId?: string;
  jobFileId?: string | null;
  sheetNumber?: string | null;
  detailReference?: string | null;
  signType?: string | null;
  signIdentifier?: string | null;
  quantity?: number | null;
  location?: string | null;
  dimensions?: string | null;
  mountingType?: string | null;
  finishColor?: string | null;
  illumination?: string | null;
  materials?: string | null;
  messageContent?: string | null;
  notes?: string | null;
  pageNumber?: number | null;
  xPos?: number | null;
  yPos?: number | null;
  placementSource?: string | null;
  manuallyAdded?: boolean;
  userVerified?: boolean;
  confidenceScore: number;
  reviewFlag: boolean;
}

interface PageStats {
  floorPlanPages: number[];
  signSchedulePages: number[];
  otherPages: number[];
}

interface FileInfo {
  id: string;
  originalName: string;
  pageCount?: number | null;
  pageStats?: PageStats | null;
}

interface SignReviewModalProps {
  sign: ExtractedSign;
  jobId: string;
  files: FileInfo[];
  allSigns: ExtractedSign[];
  onClose: () => void;
  onSaved: (updated: Record<string, unknown>) => void;
  onSignAdded?: (sign: ExtractedSign) => void;
  onSignDeleted?: (signId: string) => void;
}

const SIGN_TYPE_COLORS: Record<string, string> = {
  wayfinding: "#3B82F6",
  directional: "#10B981",
  informational: "#06B6D4",
  regulatory: "#EF4444",
  safety: "#F97316",
  exit: "#DC2626",
  ada: "#8B5CF6",
  accessibility: "#8B5CF6",
  "room id": "#F59E0B",
  "building id": "#6366F1",
  monument: "#78716C",
  pylon: "#78716C",
  parking: "#EC4899",
  "restroom": "#EC4899",
  "channel letter": "#84CC16",
  cabinet: "#14B8A6",
  "dimensional letter": "#A78BFA",
  "building sign": "#6366F1",
};

function getSignColor(signType: string | null | undefined): string {
  if (!signType) return "#6B7280";
  const key = signType.toLowerCase();
  for (const [k, v] of Object.entries(SIGN_TYPE_COLORS)) {
    if (key.includes(k)) return v;
  }
  return "#6B7280";
}

type FormState = {
  sheetNumber: string;
  detailReference: string;
  signType: string;
  signIdentifier: string;
  quantity: string;
  location: string;
  dimensions: string;
  mountingType: string;
  finishColor: string;
  illumination: string;
  materials: string;
  messageContent: string;
  notes: string;
  reviewFlag: boolean;
};

function signToForm(sign: ExtractedSign): FormState {
  return {
    sheetNumber: sign.sheetNumber ?? "",
    detailReference: sign.detailReference ?? "",
    signType: sign.signType ?? "",
    signIdentifier: sign.signIdentifier ?? "",
    quantity: sign.quantity != null ? String(sign.quantity) : "",
    location: sign.location ?? "",
    dimensions: sign.dimensions ?? "",
    mountingType: sign.mountingType ?? "",
    finishColor: sign.finishColor ?? "",
    illumination: sign.illumination ?? "",
    materials: sign.materials ?? "",
    messageContent: sign.messageContent ?? "",
    notes: sign.notes ?? "",
    reviewFlag: sign.reviewFlag,
  };
}

// ─── Types ─────────────────────────────────────────────────────────────────

/** Phrase extracted server-side from the PDF text layer (normalised bbox). */
interface PdfPhrase {
  text: string;
  x0: number; // 0–1 normalised left edge
  y0: number; // 0–1 normalised top edge   (top-down: 0 = top of page)
  x1: number; // 0–1 normalised right edge
  y1: number; // 0–1 normalised bottom edge
}

/** A candidate door/entrance position returned by the Gemini visual-locate pass. */
interface VisualCandidate {
  x: number;
  y: number;
  description: string;
  confidence: number;
}

interface TextMarker {
  x: number;               // 0–1 final marker position (page width)  — may be offset from text
  y: number;               // 0–1 final marker position (page height, top-down)
  phraseCenter?: { x: number; y: number }; // 0–1 original phrase bbox centre (debug overlay)
  signId: string;
  color: string;
  label: string;
  isCurrent: boolean;
  placementScore: number;  // 0–1 match confidence; 1.0 = exact ID or manual
  matchedPhrase?: PdfPhrase; // the phrase whose centre was used (for debug overlay)
  rejectedCandidates?: PdfPhrase[]; // runner-up candidate phrases (for debug overlay)
}

/** Tokenize a string into searchable words (len ≥ 2, deduplicated) */
function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  )];
}

function normId(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]/g, "");
}

/** True when `needle` appears in `haystack` but is NOT part of a longer alphanumeric run */
function exactBoundaryMatch(haystack: string, needle: string): boolean {
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : null;
    const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : null;
    const validBefore = before == null || !/[a-z0-9]/.test(before);
    const validAfter = after == null || !/[a-z0-9]/.test(after);
    if (validBefore && validAfter) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

/** Levenshtein edit distance between two strings. */
function levenshtein(s: string, t: string): number {
  const m = s.length, n = t.length;
  // Use two rolling rows to keep memory O(n)
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = s[i - 1] === t[j - 1]
        ? prev[j - 1]!
        : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Levenshtein similarity in [0, 1]: 1 − normalised edit distance. */
function levenshteinSim(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * Token-level best-match score between a query token and a set of phrase tokens.
 * Returns a value in [0, 1] reflecting the best possible match:
 *   • Exact match → 1.0
 *   • Prefix containment (one is a prefix of the other) → len_shorter / len_longer
 *   • Levenshtein similarity for near-misses
 */
function bestTokenMatch(qtok: string, phraseTokens: string[]): number {
  let best = 0;
  for (const ptok of phraseTokens) {
    if (qtok === ptok) return 1;
    // Prefix/suffix containment: "STOR" → "STORAGE" or "STORAGE" → "STOR"
    const [shorter, longer] = qtok.length <= ptok.length ? [qtok, ptok] : [ptok, qtok];
    if (longer.startsWith(shorter)) {
      best = Math.max(best, shorter.length / longer.length);
    }
    // Levenshtein similarity for close edits
    best = Math.max(best, levenshteinSim(qtok, ptok));
  }
  return best;
}

/**
 * Combined phrase-match score using token-level best-match Levenshtein.
 * For each query token, finds the best matching phrase token (via exact match,
 * prefix containment, or Levenshtein), then averages across all query tokens.
 * This handles space-normalisation differences ("UNIT1A" ↔ "UNIT 1A") and
 * partial word matches ("STOR" ↔ "STORAGE") that a whole-string edit distance
 * would incorrectly penalise.
 */
function phraseMatchScore(phraseText: string, query: string): number {
  const pn = phraseText.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const qn = query.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  if (!pn || !qn) return 0;
  const pt = tokenize(pn);
  const qt = tokenize(qn);
  if (!pt.length || !qt.length) return 0;
  let total = 0;
  for (const qtok of qt) {
    total += bestTokenMatch(qtok, pt);
  }
  return total / qt.length;
}

/**
 * True if the identifier token appears in any hit within `CONTEXT_RADIUS` of
 * the floor-plan hit — distinguishing room-label occurrences from schedule-table
 * occurrences.  Uses phrase bbox centres for the spatial check.
 */
function hasContextNearHitInPhrases(
  phrases: PdfPhrase[],
  locationSrc: string,
  tokenNorm: string,
  hx: number,
  hy: number,
): boolean {
  const CONTEXT_RADIUS = 0.05;
  const words = (locationSrc.match(/\S+/g) ?? [])
    .map((w) => normId(w))
    .filter((w) => w.length >= 2 && w !== tokenNorm);
  if (words.length === 0) return true; // no context → accept

  for (const p of phrases) {
    const pn = normId(p.text);
    const matched = words.some(
      (w) =>
        pn === w ||
        (w.length >= 3 && pn.includes(w)) ||
        (pn.length >= 3 && w.includes(pn)),
    );
    if (!matched) continue;
    const px = (p.x0 + p.x1) / 2;
    const py = (p.y0 + p.y1) / 2;
    if (Math.hypot(px - hx, py - hy) <= CONTEXT_RADIUS) return true;
  }
  return false;
}

/**
 * Quantitative cluster-context score: counts how many unique words from
 * `locationSrc` (excluding `excludeToken`) appear within `CONTEXT_RADIUS` of
 * point (hx, hy) in the surrounding phrase cluster.  Returns a value in
 * [0, 1] — the fraction of location words found nearby.  A score of 0 means
 * no contextual evidence; higher values indicate a better spatial match.
 * Used to disambiguate repeated room labels across a plan.
 */
function contextClusterScore(
  phrases: PdfPhrase[],
  locationSrc: string,
  excludeToken: string,
  hx: number,
  hy: number,
): number {
  const CONTEXT_RADIUS = 0.08;
  const words = [...new Set(
    (locationSrc.match(/\S+/g) ?? [])
      .map((w) => normId(w))
      .filter((w) => w.length >= 2 && w !== excludeToken),
  )];
  if (words.length === 0) return 1; // no context words → neutral

  let matched = 0;
  for (const word of words) {
    for (const p of phrases) {
      const pn = normId(p.text);
      const wordFound =
        pn === word ||
        (word.length >= 3 && pn.includes(word)) ||
        (pn.length >= 3 && word.includes(pn));
      if (!wordFound) continue;
      const px = (p.x0 + p.x1) / 2;
      const py = (p.y0 + p.y1) / 2;
      if (Math.hypot(px - hx, py - hy) <= CONTEXT_RADIUS) {
        matched++;
        break; // count each word at most once
      }
    }
  }
  return matched / words.length;
}

interface ScoredCandidate {
  phrase: PdfPhrase;
  x: number;
  y: number;
  phraseScore: number;
  roomBonus: number;   // 1.0 if a room-number token from locationSrc is found exactly nearby
  clusterScore: number;
  totalScore: number;
}

/**
 * Re-rank phrase candidates using a room-number exact-match bonus and context
 * cluster score.  Room-number tokens (e.g. "B405", "307B") strongly dominate
 * when present in locationSrc.  When no room numbers exist, context cluster
 * becomes the primary differentiator.
 *
 * ROOM_RADIUS is kept tight (0.06) so that "B405" only matches if the token
 * actually appears very close to the candidate anchor.
 */
function rankCandidates(
  candidates: Array<{ score: number; phrase: PdfPhrase; x: number; y: number }>,
  allPhrases: PdfPhrase[],
  locationSrc: string,
  excludeToken: string,
): ScoredCandidate[] {
  const ROOM_RADIUS = 0.06;
  const roomTokens = (
    locationSrc.match(/\b(?:[A-Za-z]{1,2}\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]{1,2})\b/g) ?? []
  )
    .map((t) => normId(t))
    .filter((t) => t.length >= 2);

  return candidates
    .map((c): ScoredCandidate => {
      let roomBonus = 0;
      if (roomTokens.length > 0) {
        outer: for (const rt of roomTokens) {
          for (const p of allPhrases) {
            if (exactBoundaryMatch(normId(p.text), rt)) {
              const px = (p.x0 + p.x1) / 2;
              const py = (p.y0 + p.y1) / 2;
              if (Math.hypot(px - c.x, py - c.y) <= ROOM_RADIUS) {
                roomBonus = 1.0;
                break outer;
              }
            }
          }
        }
      }
      const clusterScore = contextClusterScore(allPhrases, locationSrc, excludeToken, c.x, c.y);
      // When location has room-number tokens they strongly differentiate candidates.
      // When no room-number tokens exist, cluster context is the primary signal.
      const totalScore =
        roomTokens.length > 0
          ? roomBonus * 0.60 + clusterScore * 0.30 + c.score * 0.10
          : clusterScore * 0.65 + c.score * 0.35;
      return { phrase: c.phrase, x: c.x, y: c.y, phraseScore: c.score, roomBonus, clusterScore, totalScore };
    })
    .sort((a, b) => b.totalScore - a.totalScore);
}

/** Exact or building-prefix match ("b101b" satisfies token "101b"). */
function roomMatch(phraseNorm: string, tokenNorm: string): boolean {
  if (exactBoundaryMatch(phraseNorm, tokenNorm)) return true;
  if (
    phraseNorm.length === tokenNorm.length + 1 &&
    /^[a-z]/.test(phraseNorm) &&
    phraseNorm.slice(1) === tokenNorm
  )
    return true;
  return false;
}

/**
 * Returns a tight bbox covering only the tokens in matchedText within phrase.
 * Splits phrase.text by whitespace, estimates x-positions proportionally by
 * character count, finds the contiguous run of words that best matches the
 * matchedText tokens, and returns { x0, x1, y0, y1 }.
 * Falls back to the full phrase bbox if no matching run is found.
 */
function tightBboxForTokens(
  phrase: PdfPhrase,
  matchedText: string,
): { x0: number; x1: number; y0: number; y1: number } {
  const phraseWords = phrase.text.split(/\s+/).filter(Boolean);
  if (phraseWords.length === 0) return phrase;

  const matchWords = matchedText
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
  if (matchWords.length === 0) return phrase;

  const totalChars = phraseWords.reduce((s, w) => s + w.length, 0);
  const span = phrase.x1 - phrase.x0;

  let charOffset = 0;
  const wordPositions: { x0: number; x1: number }[] = phraseWords.map((w) => {
    const wx0 = phrase.x0 + (charOffset / totalChars) * span;
    const wx1 = phrase.x0 + ((charOffset + w.length) / totalChars) * span;
    charOffset += w.length;
    return { x0: wx0, x1: wx1 };
  });

  let bestRunStart = -1;
  let bestRunScore = 0;

  for (let i = 0; i <= phraseWords.length - matchWords.length; i++) {
    let matches = 0;
    for (let j = 0; j < matchWords.length; j++) {
      if (phraseWords[i + j]!.toUpperCase() === matchWords[j]) matches++;
    }
    const score = matches / matchWords.length;
    if (score > bestRunScore) {
      bestRunScore = score;
      bestRunStart = i;
    }
  }

  if (bestRunStart < 0 || bestRunScore < 0.5) return phrase;

  const runEnd = bestRunStart + matchWords.length - 1;
  return {
    x0: wordPositions[bestRunStart]!.x0,
    x1: wordPositions[runEnd]!.x1,
    y0: phrase.y0,
    y1: phrase.y1,
  };
}

/**
 * Split a location string into a { typeToken, numberToken } pair.
 *
 * Room-number tokens (e.g. "325A", "B405") are extracted using the same regex
 * used by Pass 2.  The remaining text (after removal) becomes the type token.
 *
 * Examples:
 *   "UNIT 1A 325A" → { typeToken: "UNIT 1A", numberToken: "325A" }
 *   "MECH B405"    → { typeToken: "MECH",    numberToken: "B405" }
 *   "UNIT 1A"      → { typeToken: "UNIT 1A", numberToken: null }
 *   "325A"         → { typeToken: null,       numberToken: "325A" }
 */
function parseLocationParts(
  location: string,
): { typeToken: string | null; numberToken: string | null } {
  const ROOM_NUM_RE = /\b(?:[A-Za-z]{1,2}\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]{1,2})\b/g;
  const numberMatches = location.match(ROOM_NUM_RE) ?? [];
  // Use the first (and usually only) room-number token
  const numberToken = numberMatches.length > 0 ? numberMatches[0]! : null;
  // Strip all room-number tokens to get the type residual
  const typeRaw = location.replace(ROOM_NUM_RE, " ").replace(/\s+/g, " ").trim();
  const typeToken = typeRaw.length >= 2 ? typeRaw : null;
  return { typeToken, numberToken };
}

/**
 * Returns true if the typeToken looks like a residential unit type prefix.
 * Used to restrict Gemini visual-locate to residential units only, preventing
 * non-residential Pass 0.5 signs (e.g. mechanical rooms, stairs) from being
 * unnecessarily sent to the vision endpoint.
 */
const RESIDENTIAL_UNIT_TYPE_RE = /^\s*(?:UNIT|SUITE|APT|APARTMENT|FLAT|CONDO|STUDIO|TOWNHOUSE|TH|PH|PENTHOUSE)\b/i;

function isResidentialUnitLocation(location: string): boolean {
  const { typeToken, numberToken } = parseLocationParts(location);
  if (!typeToken || !numberToken) return false;
  return RESIDENTIAL_UNIT_TYPE_RE.test(typeToken);
}

/**
 * Paired-cluster matching: requires both a unit-type phrase and a room-number
 * phrase to co-occur within CLUSTER_RADIUS on the page.
 *
 * Returns:
 *   - a match object anchored to the room-number phrase bbox (most specific anchor)
 *   - null       if no valid cluster found (number not on page near any type)
 *   - "ambiguous" if 2+ equally-close clusters exist
 */
function findPairedClusterMatch(
  drawingPhrases: PdfPhrase[],
  typeToken: string,
  numberToken: string,
  signId: string | undefined,
): { x: number; y: number; matched: string; score: number; phrase: PdfPhrase; rejectedCandidates: PdfPhrase[] } | null | "ambiguous" {
  const CLUSTER_RADIUS = 0.05;
  const TYPE_MATCH_THRESHOLD = 0.70;

  // All phrase candidates matching the unit-type token (e.g. "UNIT 1A", "MECH")
  const typeCands = drawingPhrases.filter(
    (p) => phraseMatchScore(p.text, typeToken) >= TYPE_MATCH_THRESHOLD,
  );

  // Room-number candidates: exact boundary match only — no fuzzy
  const numNorm = normId(numberToken);
  const numCands = drawingPhrases.filter(
    (p) => exactBoundaryMatch(normId(p.text), numNorm),
  );

  console.log(
    `[CLUSTER] ${signId ?? "?"} type="${typeToken}" number="${numberToken}"`,
  );
  console.log(
    `  typeCands(${typeCands.length}): [${typeCands.slice(0, 4).map((p) => `"${p.text}"@(${((p.x0 + p.x1) / 2).toFixed(2)},${((p.y0 + p.y1) / 2).toFixed(2)})`).join(", ")}]`,
  );
  console.log(
    `  numCands(${numCands.length}): [${numCands.slice(0, 4).map((p) => `"${p.text}"@(${((p.x0 + p.x1) / 2).toFixed(2)},${((p.y0 + p.y1) / 2).toFixed(2)})`).join(", ")}]`,
  );

  if (typeCands.length === 0 || numCands.length === 0) {
    console.log(`  → no candidates — null`);
    return null;
  }

  // Build all (typePhrase, numPhrase) pairs within CLUSTER_RADIUS
  const pairs: Array<{
    typePhrase: PdfPhrase;
    numPhrase: PdfPhrase;
    dist: number;
  }> = [];

  for (const tc of typeCands) {
    const tcx = (tc.x0 + tc.x1) / 2;
    const tcy = (tc.y0 + tc.y1) / 2;
    for (const nc of numCands) {
      const ncx = (nc.x0 + nc.x1) / 2;
      const ncy = (nc.y0 + nc.y1) / 2;
      const dist = Math.hypot(ncx - tcx, ncy - tcy);
      if (dist <= CLUSTER_RADIUS) {
        pairs.push({ typePhrase: tc, numPhrase: nc, dist });
        console.log(
          `  pair: "${tc.text}"+(${tcx.toFixed(2)},${tcy.toFixed(2)}) + ` +
          `"${nc.text}"+(${ncx.toFixed(2)},${ncy.toFixed(2)}) dist=${dist.toFixed(3)}`,
        );
      }
    }
  }

  if (pairs.length === 0) {
    console.log(`  → 0 pairs — null`);
    return null;
  }

  // Sort by distance ascending (closest pair = most co-located)
  pairs.sort((a, b) => a.dist - b.dist);
  const winner = pairs[0]!;
  const second = pairs[1];

  // Ambiguous: 2+ pairs and they are almost equally close
  if (second !== undefined && second.dist - winner.dist < 0.02) {
    console.log(
      `  → AMBIGUOUS: winner dist=${winner.dist.toFixed(3)} vs second dist=${second.dist.toFixed(3)}`,
    );
    return "ambiguous";
  }

  // Anchor to the room-number phrase bbox (most specific / unique)
  const anchor = {
    x: (winner.numPhrase.x0 + winner.numPhrase.x1) / 2,
    y: (winner.numPhrase.y0 + winner.numPhrase.y1) / 2,
  };
  console.log(
    `  → WINNER: "${winner.typePhrase.text}" + "${winner.numPhrase.text}" ` +
    `anchor=(${anchor.x.toFixed(3)},${anchor.y.toFixed(3)}) score=0.95`,
  );

  // Rejected = type candidates that did NOT pair with the winning number phrase
  const winningTypePhrase = winner.typePhrase;
  const rejectedCandidates = typeCands
    .filter((tc) => tc !== winningTypePhrase)
    .slice(0, 2);

  return {
    x: anchor.x,
    y: anchor.y,
    matched: `${typeToken} ${numberToken}`,
    score: 0.95,
    phrase: winner.numPhrase,
    rejectedCandidates,
  };
}

/**
 * Given server-extracted phrases for one PDF page and a sign, find the best
 * matching position using bbox centres.
 *
 * Pass 0   — exact identifier match (single occurrence = callout bubble) → score 1.0
 * Pass 0.5 — paired-cluster match: requires type token + number token to
 *             co-occur within CLUSTER_RADIUS=0.05. Owns all locations that
 *             contain a room-number component; does not fall through to P1–3.
 * Pass 1   — full-phrase location string match via phraseMatchScore (≥ 0.65)  → score ≥ 0.8
 * Pass 2   — room-number token matching with context co-location check         → score 0.75
 * Pass 3   — fuzzy phrase scoring fallback (threshold raised to 0.6)           → proportional score
 *
 * Margin filtering: phrases with y < 0.04 or y > 0.96 (title blocks / borders)
 * or fewer than 2 characters are excluded from Passes 1–3.
 */
function findSignLocationFromPhrases(
  phrases: PdfPhrase[],
  sign: ExtractedSign,
): { x: number; y: number; matched: string; score: number; phrase: PdfPhrase; rejectedCandidates?: PdfPhrase[] } | null {

  // ── Margin filtering — exclude border/title-block phrases from Passes 1–3 ──
  const drawingPhrases = phrases.filter((p) => {
    const cy = (p.y0 + p.y1) / 2;
    return cy >= 0.04 && cy <= 0.96 && p.text.trim().length >= 2;
  });

  // ── Pass 0: exact identifier ───────────────────────────────────────────────
  // Uses ALL phrases (not margin-filtered) so that callout bubbles near edges
  // are still found. Requires the ID to appear exactly once on the page.
  if (sign.signIdentifier && sign.signIdentifier.length >= 3) {
    const idNorm = normId(sign.signIdentifier);
    if (idNorm.length >= 3) {
      const idHits: { x: number; y: number; phrase: PdfPhrase }[] = [];
      for (const p of phrases) {
        if (exactBoundaryMatch(normId(p.text), idNorm)) {
          idHits.push({ x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2, phrase: p });
        }
      }
      if (idHits.length === 1) {
        return { x: idHits[0]!.x, y: idHits[0]!.y, matched: sign.signIdentifier, score: 1.0, phrase: idHits[0]!.phrase };
      }
    }
  }

  const locationSource = [sign.location, sign.messageContent].filter(Boolean).join(" ");
  const pageCy = 0.5; // page centroid y used for tie-breaking

  // ── Pass 0.5: paired-cluster match ────────────────────────────────────────
  // When the location string contains BOTH a unit-type part ("UNIT 1A", "MECH")
  // AND a room-number part ("325A", "B405"), require them to co-occur within
  // CLUSTER_RADIUS=0.05 on the page.  This pass owns all locations with a
  // room-number component — Pass 1/2/3 are skipped for those locations because
  // a wrong marker (spread across repeated unit labels) is worse than no marker.
  if (sign.location) {
    const { typeToken, numberToken } = parseLocationParts(sign.location);
    if (typeToken && numberToken) {
      const clusterResult = findPairedClusterMatch(
        drawingPhrases,
        typeToken,
        numberToken,
        sign.signIdentifier ?? undefined,
      );
      if (clusterResult === "ambiguous") return null;  // ambiguous — suppress
      if (clusterResult !== null) return clusterResult; // clean winner
      return null; // number not found near any type — suppress (no fallback to P1)
    }
  }

  // ── Pass 1: full-phrase location string match ──────────────────────────────
  // Score the entire sign.location string against every drawing-area phrase
  // using phraseMatchScore. Accept anything ≥ 0.65. When multiple phrases tie,
  // pick the one whose surroundings best match the broader location string,
  // then prefer the hit closest to the page centroid y.
  const PASS1_THRESHOLD = 0.65;
  if (sign.location) {
    let bestScore = 0;
    const candidates: { score: number; phrase: PdfPhrase; x: number; y: number }[] = [];

    for (const p of drawingPhrases) {
      const score = phraseMatchScore(p.text, sign.location);
      if (score >= PASS1_THRESHOLD) {
        candidates.push({ score, phrase: p, x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2 });
        if (score > bestScore) bestScore = score;
      }
    }

    if (candidates.length > 0) {
      // Rank all pass-1 candidates by room-number exact-match bonus + cluster score.
      const ranked1 = rankCandidates(candidates, drawingPhrases, sign.location ?? locationSource, "");
      const top1 = ranked1[0]!;
      const second1 = ranked1[1];

      // Suppress if ambiguous: 2+ candidates and no clear winner.
      // "Clear winner" = gap ≥ 0.12 OR top totalScore ≥ 0.75.
      const ambiguous1 = second1 !== undefined
        && (top1.totalScore - second1.totalScore) < 0.12
        && top1.totalScore < 0.75;

      if (ambiguous1) {
        // Fall through to Pass 2 for room-number matching which may disambiguate.
        console.log(
          `[MATCH] ${sign.signIdentifier ?? "?"} P1-AMBIGUOUS: ` +
          `top="${top1.phrase.text}" ${top1.totalScore.toFixed(2)} vs ` +
          `"${second1.phrase.text}" ${second1.totalScore.toFixed(2)}`,
        );
      } else {
        const rejected1 = ranked1.slice(1, 3).map((r) => r.phrase);
        console.log(
          `[MATCH] ${sign.signIdentifier ?? "?"} P1→"${top1.phrase.text}" ` +
          `total=${top1.totalScore.toFixed(2)} room=${top1.roomBonus.toFixed(2)} cluster=${top1.clusterScore.toFixed(2)}`,
        );
        ranked1.slice(1, 3).forEach((r, i) =>
          console.log(
            `  [MATCH] cand${i + 2}: "${r.phrase.text}" ` +
            `total=${r.totalScore.toFixed(2)} room=${r.roomBonus.toFixed(2)} cluster=${r.clusterScore.toFixed(2)}`,
          ),
        );
        const confidence = 0.8 + (top1.phraseScore - PASS1_THRESHOLD) / (1 - PASS1_THRESHOLD) * 0.2;
        const tight1 = tightBboxForTokens(top1.phrase, sign.location ?? top1.phrase.text);
        return {
          x: (tight1.x0 + tight1.x1) / 2,
          y: (tight1.y0 + tight1.y1) / 2,
          matched: top1.phrase.text,
          score: Math.min(1.0, confidence),
          phrase: top1.phrase,
          rejectedCandidates: rejected1,
        };
      }
    }
  }

  // ── Pass 2: room-number token matching ────────────────────────────────────
  if (locationSource) {
    const roomTokens: string[] = (
      locationSource.match(/\b(?:[A-Za-z]{1,2}\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]{1,2})\b/g) ?? []
    )
      .filter((t: string) => t.length >= 2)
      .sort((a: string, b: string) => b.length - a.length);

    for (const token of roomTokens) {
      const tokenNorm = normId(token);
      const hits: { x: number; y: number; phrase: PdfPhrase }[] = [];

      for (const p of drawingPhrases) {
        if (roomMatch(normId(p.text), tokenNorm)) {
          hits.push({ x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2, phrase: p });
        }
      }

      if (hits.length === 0) continue;

      const floorPlanHits = hits.filter((h) =>
        hasContextNearHitInPhrases(drawingPhrases, locationSource, tokenNorm, h.x, h.y),
      );
      if (floorPlanHits.length === 0) continue;

      // Rank floor-plan hits using room-number bonus + context cluster score.
      const pass2Cands = floorPlanHits.map((h) => ({ score: 0.75, phrase: h.phrase, x: h.x, y: h.y }));
      const ranked2 = rankCandidates(pass2Cands, drawingPhrases, locationSource, tokenNorm);
      const top2 = ranked2[0]!;
      const second2 = ranked2[1];

      // Suppress if ambiguous.
      const ambiguous2 = second2 !== undefined
        && (top2.totalScore - second2.totalScore) < 0.12
        && top2.totalScore < 0.75;

      if (ambiguous2) {
        console.log(
          `[MATCH] ${sign.signIdentifier ?? "?"} P2-AMBIGUOUS on "${token}": ` +
          `top="${top2.phrase.text}" ${top2.totalScore.toFixed(2)} vs ` +
          `"${second2.phrase.text}" ${second2.totalScore.toFixed(2)}`,
        );
        continue; // try next room-number token
      }

      const rejected2 = ranked2.slice(1, 3).map((r) => r.phrase);
      console.log(
        `[MATCH] ${sign.signIdentifier ?? "?"} P2→"${top2.phrase.text}" ` +
        `total=${top2.totalScore.toFixed(2)} room=${top2.roomBonus.toFixed(2)} cluster=${top2.clusterScore.toFixed(2)}`,
      );
      ranked2.slice(1, 3).forEach((r, i) =>
        console.log(
          `  [MATCH] cand${i + 2}: "${r.phrase.text}" ` +
          `total=${r.totalScore.toFixed(2)} room=${r.roomBonus.toFixed(2)} cluster=${r.clusterScore.toFixed(2)}`,
        ),
      );
      const tight2 = tightBboxForTokens(top2.phrase, token);
      return {
        x: (tight2.x0 + tight2.x1) / 2,
        y: (tight2.y0 + tight2.y1) / 2,
        matched: token,
        score: 0.75,
        phrase: top2.phrase,
        rejectedCandidates: rejected2,
      };
    }
  }

  // ── Pass 3: fuzzy phrase match (raised threshold to 0.6) ──────────────────
  const FUZZY_MATCH_THRESHOLD = 0.6;
  if (locationSource) {
    let bestScore = 0;
    let bestPhrase: PdfPhrase | null = null;
    for (const p of drawingPhrases) {
      const score = phraseMatchScore(p.text, locationSource);
      if (score > bestScore) { bestScore = score; bestPhrase = p; }
    }
    if (bestScore >= FUZZY_MATCH_THRESHOLD && bestPhrase) {
      const tight3 = tightBboxForTokens(bestPhrase, locationSource);
      return {
        x: (tight3.x0 + tight3.x1) / 2,
        y: (tight3.y0 + tight3.y1) / 2,
        matched: bestPhrase.text,
        score: bestScore,
        phrase: bestPhrase,
      };
    }
  }

  return null;
}

/**
 * Given a matched phrase and all phrases on the page, compute the best marker
 * position by offsetting away from the text toward open (low-density) space.
 *
 * Tries 4 directions (right, left, down, up) and picks the one with the
 * least surrounding text density. Anti-stacking nudges the result if it
 * lands too close to an already-placed marker.
 */
function computeMarkerOffset(
  phrase: PdfPhrase,
  allPhrases: PdfPhrase[],
  placedMarkers: Array<{ x: number; y: number }>,
): { x: number; y: number } {
  const cx = (phrase.x0 + phrase.x1) / 2;
  const cy = (phrase.y0 + phrase.y1) / 2;

  // Offset magnitude: scale with phrase size, but enforce a minimum so there's
  // always visible clearance. 0.07 normalized ≈ ~55–70 px at typical scale.
  const phraseW = phrase.x1 - phrase.x0;
  const phraseH = phrase.y1 - phrase.y0;
  const dx = Math.max(phraseW * 2.5, 0.06);
  const dy = Math.max(phraseH * 3.0, 0.05);

  const candidates = [
    { x: cx + dx, y: cy },   // right
    { x: cx - dx, y: cy },   // left
    { x: cx,      y: cy + dy }, // down
    { x: cx,      y: cy - dy }, // up
  ].filter((d) => d.x >= 0.01 && d.x <= 0.99 && d.y >= 0.01 && d.y <= 0.99);

  if (candidates.length === 0) return { x: cx, y: cy }; // nowhere to go, use center

  // Score each candidate by text density in a radius around it.
  // Lower score = less text = better (more open space).
  const DENSITY_RADIUS = Math.max(dx, dy) * 0.9;
  function textDensity(nx: number, ny: number): number {
    let score = 0;
    for (const p of allPhrases) {
      if (p === phrase) continue;
      const pcx = (p.x0 + p.x1) / 2;
      const pcy = (p.y0 + p.y1) / 2;
      const dist = Math.hypot(nx - pcx, ny - pcy);
      if (dist < DENSITY_RADIUS) score += 1 - dist / DENSITY_RADIUS;
    }
    return score;
  }

  const scored = candidates
    .map((d) => ({ ...d, density: textDensity(d.x, d.y) }))
    .sort((a, b) => a.density - b.density);

  let { x, y } = scored[0]!;

  // Anti-stacking: if an already-placed marker is too close, nudge further
  // in the same offset direction from the phrase center.
  const STACK_RADIUS = 0.04;
  for (const m of placedMarkers) {
    if (Math.hypot(x - m.x, y - m.y) < STACK_RADIUS) {
      x = x + (x - cx) * 0.5;
      y = y + (y - cy) * 0.5;
    }
  }

  return { x, y };
}

export function SignReviewModal({
  sign,
  jobId,
  files,
  allSigns: allSignsProp,
  onClose,
  onSaved,
  onSignAdded,
  onSignDeleted,
}: SignReviewModalProps) {
  const [localSigns, setLocalSigns] = useState<ExtractedSign[]>(allSignsProp);
  useEffect(() => { setLocalSigns(allSignsProp); }, [allSignsProp]);
  const allSigns = localSigns;
  const file = files.find((f) => f.id === sign.jobFileId) ?? null;
  const rawPdfApiUrl = file ? `/api/jobs/${jobId}/files/${file.id}/pdf` : null;
  const { pdfBuffer, blobError: pdfLoadError } = usePdfBlob(rawPdfApiUrl);
  // Stable flag: true once data is ready, false while loading or if no file.
  const pdfReady = !!pdfBuffer;
  // Memoized react-pdf file object — creates a fresh copy from the stored ArrayBuffer
  // so react-pdf's internal postMessage transfer never detaches our state reference.
  const pdfFile = useMemo(
    () => (pdfBuffer ? { data: new Uint8Array(pdfBuffer.slice(0)) } : null),
    [pdfBuffer]
  );

  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(sign.pageNumber ?? 1);
  const [scale, setScale] = useState(1.0);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  // activeSign tracks which sign is currently being edited — starts as the
  // prop but can change when the user clicks a marker on the PDF.
  const [activeSign, setActiveSign] = useState<ExtractedSign>(sign);

  const [form, setForm] = useState<FormState>(() => signToForm(sign));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // ── Highlight / marker state ────────────────────────────────────────────
  type ServerPhraseData = { pageWidth: number; pageHeight: number; phrases: PdfPhrase[] };
  const [serverPhrases, setServerPhrases] = useState<ServerPhraseData | null>(null);
  // Track whether the most recent phrase fetch failed so we can show ghost markers
  // even when phrases are unavailable (rather than clearing markers silently).
  const [phrasesFetchFailed, setPhrasesFetchFailed] = useState(false);
  const [textMarkers, setTextMarkers] = useState<TextMarker[]>([]);
  const [nativeSize, setNativeSize] = useState<{ w: number; h: number } | null>(null);

  // Auto-fit scale to container width when the page dimensions become known
  useEffect(() => {
    if (!nativeSize || !pdfContainerRef.current) return;
    const containerW = pdfContainerRef.current.clientWidth - 32; // subtract padding
    if (containerW > 0) {
      const fit = containerW / nativeSize.w;
      setScale(Math.min(1.2, Math.max(0.3, fit)));
    }
  // Only run when native width first becomes known or changes (new page/doc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeSize?.w]);
  const [textSearchStatus, setTextSearchStatus] = useState<"idle" | "found" | "not-found">("idle");
  const [showOverlay, setShowOverlay] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [addingSign, setAddingSign] = useState(false);

  // ── Visual-locate (Gemini door placement) ───────────────────────────────
  // visualCandidates: signId → alternative candidates (index 1+) to show as numbered dots
  const [visualCandidates, setVisualCandidates] = useState<Map<string, VisualCandidate[]>>(new Map());
  // visualLocateFailed: signs for which Gemini returned no candidates → suppress marker
  const [visualLocateFailed, setVisualLocateFailed] = useState<Set<string>>(new Set());
  const [visualLocating, setVisualLocating] = useState(false);
  // Page-level dedup ref: prevents re-firing the Gemini request for the same page
  const visualLocateQueriedRef = useRef<Set<string>>(new Set());
  // Per-sign ref: tracks exactly which sign IDs were submitted in the last request batch.
  // Used for per-sign marker suppression — only suppress signs actually sent to Gemini.
  const visualLocateSubmittedRef = useRef<Set<string>>(new Set());

  // Measure actual rendered page size by observing the Page element's DOM dimensions.
  // This is more reliable than computing nativeSize.w * scale because react-pdf may
  // apply rounding or additional transforms internally.
  const pageWrapRef = useRef<HTMLDivElement>(null);
  const [measuredPageSize, setMeasuredPageSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = pageWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const canvas = el.querySelector("canvas");
      if (canvas) {
        setMeasuredPageSize({ w: canvas.offsetWidth, h: canvas.offsetHeight });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Suppress marker dots when viewing a sign schedule / spec page — those pages
  // are tabular data, not spatial floor plans, so dots on them are meaningless.
  const fileStats = file?.pageStats ?? null;
  const isSignSchedulePage = fileStats?.signSchedulePages?.includes(pageNumber) ?? false;

  // When the parent passes a new sign (user clicked a different row), reset activeSign.
  useEffect(() => {
    setActiveSign(sign);
  }, [sign.id]);

  // When activeSign changes (from parent switch or marker click), reset form + jump page.
  // Do NOT clear textMarkers here — the text-search effect will re-run (activeSign.id is
  // in its deps) and recompute colors. Clearing here caused all dots to disappear when
  // clicking a same-page marker, because the text-search effect wouldn't re-run.
  useEffect(() => {
    setForm(signToForm(activeSign));
    setDirty(false);
    setPageNumber((prev) => activeSign.pageNumber ?? prev);
    setTextSearchStatus("idle");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSign.id]);

  // Treat null pageNumber as page 1 — single-page PDFs often have null when
  // the AI didn't explicitly output the field.
  const signsOnCurrentPage = allSigns.filter(
    (s) => s.jobFileId === sign.jobFileId && (s.pageNumber ?? 1) === pageNumber
  );

  // Fetch server-extracted phrase list whenever the file or page changes.
  // The server groups adjacent pdfjs items into phrases and returns full bboxes
  // so the client can use bbox centres for marker placement.
  useEffect(() => {
    if (!file) {
      setServerPhrases(null);
      setPhrasesFetchFailed(false);
      return;
    }
    setServerPhrases(null);
    setPhrasesFetchFailed(false);
    let cancelled = false;
    apiFetch(`/api/jobs/${jobId}/files/${file.id}/pages/${pageNumber}/words`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("non-ok"))))
      .then((data: { pageWidth: number; pageHeight: number; phrases: PdfPhrase[] }) => {
        if (!cancelled) setServerPhrases(data);
      })
      .catch(() => {
        if (!cancelled) setPhrasesFetchFailed(true);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, pageNumber, jobId]);

  // Compute text markers from server phrases.
  // A stable string that changes whenever any sign on the page has its xPos/yPos/placementSource
  // updated. Used as a dependency for the marker-building effect so it re-fires after AI
  // auto-applies placements without needing the full signsOnCurrentPage array reference.
  const signPlacementKey = signsOnCurrentPage
    .map((s) => `${s.id}:${s.xPos?.toFixed(4) ?? ""}:${s.yPos?.toFixed(4) ?? ""}:${s.placementSource ?? ""}`)
    .join("|");

  // When phrases are available, markers use bbox centres + fuzzy matching.
  // When the fetch is still in-flight (serverPhrases null, failed false), we
  // wait. When the fetch failed, we render ghost markers so the active sign
  // is always visually represented.
  // activeSign.id is a dep so colors re-compute when user clicks a marker.
  useEffect(() => {
    // Still loading — keep whatever markers were already showing
    if (!serverPhrases && !phrasesFetchFailed) return;

    // Set native page size from server data so the SVG overlay scales correctly.
    if (serverPhrases) setNativeSize({ w: serverPhrases.pageWidth, h: serverPhrases.pageHeight });

    if (signsOnCurrentPage.length === 0) {
      setTextMarkers([]);
      setTextSearchStatus("idle");
      return;
    }

    const markers: TextMarker[] = [];
    let currentSignFound = false;
    // Use server phrases if available; empty array on failure (ghost-only path)
    const phrases = serverPhrases?.phrases ?? [];

    for (const s of signsOnCurrentPage) {
      const isCurrent = s.id === activeSign.id;
      const color = isCurrent ? "#22c55e" : (s.manuallyAdded ? "#a855f7" : "#eab308");

      // Manually-placed or AI-confirmed markers: use stored coordinates directly.
      if (s.xPos != null && s.yPos != null && (s.manuallyAdded || s.placementSource != null)) {
        markers.push({
          x: s.xPos,
          y: s.yPos,
          signId: s.id,
          color,
          label: s.signIdentifier ?? s.signType?.slice(0, 6) ?? "SIGN",
          isCurrent,
          placementScore: 1.0,
        });
        if (isCurrent) currentSignFound = true;
        continue;
      }

      // Suppress annotation-band text markers for signs awaiting or having failed visual-locate.
      // Visual candidates (numbered dots) or AI-placed markers will appear instead.
      if (visualLocateFailed.has(s.id)) {
        // No marker at all — Gemini confirmed it couldn't find the door
        if (isCurrent) currentSignFound = false; // will get ghost marker below
        continue;
      }
      if (visualCandidates.has(s.id)) {
        // Alternatives exist for this sign (top candidate already auto-applied above)
        continue;
      }

      // Suppress annotation-band text marker for THIS sign if it was actually submitted to
      // visual-locate (per-sign suppression — not page-level). Signs not included in the
      // batch (failed cluster check, excluded by cap, non-residential) are NOT suppressed.
      if (visualLocateSubmittedRef.current.has(s.id)) continue;

      const loc = findSignLocationFromPhrases(phrases, s);
      if (loc) {
        markers.push({
          x: loc.x,
          y: loc.y,
          phraseCenter: { x: loc.x, y: loc.y },
          signId: s.id,
          color,
          label: s.signIdentifier ?? s.signType?.slice(0, 6) ?? "SIGN",
          isCurrent,
          placementScore: loc.score,
          matchedPhrase: loc.phrase,
          rejectedCandidates: loc.rejectedCandidates,
        });
        if (isCurrent) currentSignFound = true;
      }
    }

    // Minimal collision nudge: if two auto-matched markers would fully overlap,
    // nudge the later one slightly. At most one nudge per marker, no cascading.
    const COLLISION_THRESHOLD = 0.012;
    for (let i = 0; i < markers.length; i++) {
      const mi = markers[i]!;
      if (mi.placementScore === 1.0) continue; // skip manually-placed
      for (let j = 0; j < i; j++) {
        const mj = markers[j]!;
        if (Math.hypot(mi.x - mj.x, mi.y - mj.y) < COLLISION_THRESHOLD) {
          // Nudge in whichever axis has more room to the boundary
          const roomRight = 1 - mi.x;
          const roomDown  = 1 - mi.y;
          if (roomRight >= roomDown) {
            mi.x = Math.min(1, mi.x + COLLISION_THRESHOLD);
          } else {
            mi.y = Math.min(1, mi.y + COLLISION_THRESHOLD);
          }
          break;
        }
      }
    }

    // Ghost marker for active sign when text search fails — user can still see
    // the green dot and drag it to the correct position.
    if (!currentSignFound && signsOnCurrentPage.some((s) => s.id === activeSign.id)) {
      markers.push({
        x: 0.5,
        y: 0.08,
        signId: activeSign.id,
        color: "#22c55e",
        label: "?",
        isCurrent: true,
        placementScore: 0,
      });
    }

    setTextMarkers(markers);
    if (signsOnCurrentPage.some((s) => s.id === activeSign.id)) {
      setTextSearchStatus(currentSignFound ? "found" : "not-found");
    } else {
      setTextSearchStatus("idle");
    }
  }, [serverPhrases, phrasesFetchFailed, pageNumber, sign.id, signPlacementKey, activeSign.id, visualLocateFailed, visualCandidates]);

  // Clear visual candidates, failed set, and per-sign submitted set when the page or file changes
  useEffect(() => {
    setVisualCandidates(new Map());
    setVisualLocateFailed(new Set());
    visualLocateSubmittedRef.current = new Set();
  }, [file?.id, pageNumber]);

  // Auto-fire Gemini visual-locate for residential-unit paired-cluster signs ONLY — i.e.
  // signs that (a) pass the isResidentialUnitLocation test, (b) do not already have a stored
  // placementSource, and (c) can actually produce a Pass 0.5 (paired-cluster) result on this
  // page. The phrases from serverPhrases are used to verify the cluster is present before
  // sending to Gemini — this prevents sending signs whose location text simply looks like a
  // residential unit but for which no matching cluster exists on the current page.
  //
  // Failure-safe: if the request fails the page key is cleared from the ref so annotation-band
  // text markers fall back normally (no permanent suppression).
  //
  // Batching: signs are capped to 20 per request (backend enforces this too).
  useEffect(() => {
    if (!file || !serverPhrases) return;

    const pageKey = `${file.id}:${pageNumber}`;
    if (visualLocateQueriedRef.current.has(pageKey)) return;

    // Build marker map for anchor hints (annotation-band text-matched positions)
    const markerMap = new Map(textMarkers.map((m) => [m.signId, m]));
    const phrases = serverPhrases.phrases;

    // Select residential-unit signs that (1) have no stored AI placement, (2) pass
    // isResidentialUnitLocation, AND (3) produce a non-null cluster result on this page.
    // This gates visual-locate to confirmed Pass-0.5 matches only.
    const targetSigns = signsOnCurrentPage.filter((s) => {
      if (s.placementSource != null) return false;
      if (!s.location) return false;
      if (!isResidentialUnitLocation(s.location)) return false;
      // Verify the paired cluster actually exists on this page before sending to Gemini
      const { typeToken, numberToken } = parseLocationParts(s.location);
      if (!typeToken || !numberToken) return false;
      const clusterResult = findPairedClusterMatch(phrases, typeToken, numberToken, s.signIdentifier ?? undefined);
      return clusterResult !== null; // null = no cluster found; "ambiguous" or object = eligible
    }).slice(0, 20); // cap to backend max

    if (targetSigns.length === 0) return;

    visualLocateQueriedRef.current.add(pageKey);
    // Track exactly which sign IDs are being submitted so we can suppress only those markers
    targetSigns.forEach((s) => visualLocateSubmittedRef.current.add(s.id));
    setVisualLocating(true);

    apiFetch(`/api/jobs/${jobId}/visual-locate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: file.id,
        pageNumber,
        signs: targetSigns.map((s) => {
          const { typeToken, numberToken } = parseLocationParts(s.location!);
          const marker = markerMap.get(s.id);
          return {
            signId: s.id,
            signType: s.signType,
            location: s.location,
            signIdentifier: s.signIdentifier,
            roomNumber: numberToken,
            typeToken: typeToken,
            anchorX: marker?.x ?? null,
            anchorY: marker?.y ?? null,
          };
        }),
      }),
    })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("non-ok")))
      .then((data: { results: { signId: string; candidates: VisualCandidate[] }[] }) => {
        const toAutoApply: Array<{ signId: string; candidate: VisualCandidate }> = [];
        const newCandidates = new Map<string, VisualCandidate[]>();
        const newFailed = new Set<string>();

        for (const r of data.results) {
          if (r.candidates.length === 0) {
            newFailed.add(r.signId);
          } else {
            // Always auto-apply the top candidate as gemini_vision (highest-confidence pick).
            // This moves the marker to the correct door position without user interaction.
            toAutoApply.push({ signId: r.signId, candidate: r.candidates[0]! });
            // For 2-3 candidates, also store alternatives (index 1+) as numbered dots
            // so the user can see exactly what was auto-chosen and override if needed.
            if (r.candidates.length > 1) {
              newCandidates.set(r.signId, r.candidates.slice(1, 3));
            }
          }
        }

        setVisualLocateFailed((prev) => {
          const next = new Set(prev);
          newFailed.forEach((id) => next.add(id));
          return next;
        });
        setVisualCandidates((prev) => {
          const next = new Map(prev);
          newCandidates.forEach((v, k) => next.set(k, v));
          return next;
        });

        // Auto-PATCH top candidates as gemini_vision (fire-and-forget — UI updates via setLocalSigns)
        for (const { signId, candidate } of toAutoApply) {
          apiFetch(`/api/extracted-signs/${signId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              xPos: candidate.x,
              yPos: candidate.y,
              placementSource: "gemini_vision",
            }),
          })
            .then((r) => r.ok ? r.json() : Promise.reject(new Error("non-ok")))
            .then((d: { sign: ExtractedSign }) => {
              setLocalSigns((prev) => prev.map((s) => s.id === signId ? d.sign : s));
              if (signId === activeSign.id) setActiveSign(d.sign);
            })
            .catch((err) => console.error(`[visual-locate] auto-apply failed for ${signId}:`, err));
        }
      })
      .catch((err) => {
        console.error("[visual-locate] request failed:", err);
        // Failure-safe: clear the page key AND per-sign submitted IDs so annotation-band
        // markers fall back to normal text matching without permanent suppression.
        visualLocateQueriedRef.current.delete(pageKey);
        targetSigns.forEach((s) => visualLocateSubmittedRef.current.delete(s.id));
      })
      .finally(() => setVisualLocating(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPhrases, textMarkers, file?.id, pageNumber]);

  const handleField = useCallback(
    (field: keyof FormState, value: string | boolean) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      setDirty(true);
    },
    []
  );

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {
        sheetNumber: form.sheetNumber || null,
        detailReference: form.detailReference || null,
        signType: form.signType || null,
        signIdentifier: form.signIdentifier || null,
        quantity: form.quantity ? parseInt(form.quantity, 10) : null,
        location: form.location || null,
        dimensions: form.dimensions || null,
        mountingType: form.mountingType || null,
        finishColor: form.finishColor || null,
        illumination: form.illumination || null,
        materials: form.materials ?? null,
        messageContent: form.messageContent || null,
        notes: form.notes || null,
        reviewFlag: form.reviewFlag,
      };

      const res = await apiFetch(`/api/extracted-signs/${activeSign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((err as { error?: string }).error ?? "Save failed");
      }

      const data = await res.json() as { sign: Record<string, unknown> };
      setDirty(false);
      onSaved(data.sign);
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateSign = async (nx: number, ny: number) => {
    if (!file) return;
    setAddingSign(true);
    try {
      const res = await apiFetch("/api/extracted-signs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          jobFileId: file.id,
          pageNumber,
          xPos: nx,
          yPos: ny,
          signType: "Unknown",
          signIdentifier: null,
          location: null,
          notes: "Manually added",
        }),
      });
      if (!res.ok) throw new Error("Failed to create sign");
      const data = await res.json() as { sign: ExtractedSign };
      const newSign = data.sign;
      setLocalSigns((prev) => [...prev, newSign]);
      setActiveSign(newSign);
      onSignAdded?.(newSign);
    } catch (err) {
      console.error("Create sign failed:", err);
    } finally {
      setAddingSign(false);
    }
  };

  const handleDeleteSign = async (signId: string) => {
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete sign");
      setLocalSigns((prev) => prev.filter((s) => s.id !== signId));
      setHoveredMarkerId(null);
      if (activeSign.id === signId) {
        const next = allSigns.find((s) => s.id !== signId);
        if (next) setActiveSign(next);
      }
      onSignDeleted?.(signId);
    } catch (err) {
      console.error("Delete sign failed:", err);
    }
  };

  const confirmVisualPlacement = async (signId: string, candidate: VisualCandidate) => {
    try {
      const res = await apiFetch(`/api/extracted-signs/${signId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xPos: candidate.x,
          yPos: candidate.y,
          placementSource: "user_confirmed",
        }),
      });
      if (!res.ok) throw new Error("Failed to confirm placement");
      const data = await res.json() as { sign: ExtractedSign };
      setLocalSigns((prev) => prev.map((s) => s.id === signId ? data.sign : s));
      setVisualCandidates((prev) => {
        const next = new Map(prev);
        next.delete(signId);
        return next;
      });
      if (signId === activeSign.id) {
        setActiveSign(data.sign);
      }
    } catch (err) {
      console.error("[visual-locate] confirm placement failed:", err);
    }
  };

  const confidence = Math.round(activeSign.confidenceScore * 100);
  const confColor =
    confidence >= 80
      ? "text-accent"
      : confidence >= 60
      ? "text-primary"
      : "text-destructive";

  // Prefer the ResizeObserver-measured canvas size — it reads actual CSS pixels
  // from the DOM and is immune to any react-pdf internal rounding or scaling.
  // Fall back to the computed value when the canvas hasn't painted yet.
  const renderedW = measuredPageSize?.w ?? (nativeSize ? nativeSize.w * scale : null);
  const renderedH = measuredPageSize?.h ?? (nativeSize ? nativeSize.h * scale : null);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
      {/* Top bar */}
      {(() => {
        const allSignsSorted = allSigns;
        const currentIdx = allSignsSorted.findIndex((s) => s.id === activeSign.id);
        const hasPrev = currentIdx > 0;
        const hasNext = currentIdx >= 0 && currentIdx < allSignsSorted.length - 1;
        const goPrev = () => { if (hasPrev) setActiveSign(allSignsSorted[currentIdx - 1]); };
        const goNext = () => { if (hasNext) setActiveSign(allSignsSorted[currentIdx + 1]); };
        return (
      <div className="flex-none flex items-center justify-between px-4 py-3 bg-card border-b border-border shadow-lg">
        {/* Prev / Next sign navigation */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            disabled={!hasPrev}
            onClick={goPrev}
            title="Previous sign"
            className="p-1.5 rounded hover:bg-secondary disabled:opacity-25 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-mono text-muted-foreground select-none min-w-[52px] text-center">
            {currentIdx >= 0 ? `${currentIdx + 1} / ${allSignsSorted.length}` : "—"}
          </span>
          <button
            disabled={!hasNext}
            onClick={goNext}
            title="Next sign"
            className="p-1.5 rounded hover:bg-secondary disabled:opacity-25 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-border mx-1" />
        </div>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <FileText className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-display font-semibold text-foreground leading-none truncate">
              {file?.originalName ?? "Unknown file"}
            </p>
            {activeSign.sheetNumber && (
              <p className="text-xs text-muted-foreground font-mono mt-0.5">
                Sheet {activeSign.sheetNumber}
                {activeSign.signIdentifier ? ` • ${activeSign.signIdentifier}` : ""}
              </p>
            )}
          </div>
          <div className={`text-xs font-mono font-semibold px-2 py-0.5 rounded border ${confColor} bg-current/10 border-current/20`}>
            {confidence}% confidence
          </div>
          {activeSign.manuallyAdded && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded" style={{ color: "#a855f7", borderColor: "#a855f755", background: "#a855f710" }}>
              <Plus className="w-3 h-3" />
              Manually Added
            </span>
          )}
          {activeSign.userVerified && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded" style={{ color: "#22c55e", borderColor: "#22c55e55", background: "#22c55e10" }}>
              <CheckCircle className="w-3 h-3" />
              Verified
            </span>
          )}
          {(activeSign.placementSource === "user_confirmed" || activeSign.placementSource === "gemini_vision") && (
            <button
              title="Click to clear AI placement and re-run visual locate"
              onClick={async () => {
                try {
                  const r = await apiFetch(`/api/extracted-signs/${activeSign.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ xPos: null, yPos: null, placementSource: null }),
                  });
                  if (!r.ok) return;
                  const d = await r.json() as { sign: ExtractedSign };
                  setLocalSigns((prev) => prev.map((s) => s.id === activeSign.id ? d.sign : s));
                  setActiveSign(d.sign);
                  // Allow visual-locate to re-run for this page
                  if (file) {
                    visualLocateQueriedRef.current.delete(`${file.id}:${pageNumber}`);
                  }
                  setVisualLocateFailed((prev) => { const n = new Set(prev); n.delete(activeSign.id); return n; });
                  setVisualCandidates((prev) => { const n = new Map(prev); n.delete(activeSign.id); return n; });
                } catch (err) {
                  console.error("[visual-locate] reset failed:", err);
                }
              }}
              className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider border px-2 py-0.5 rounded transition-opacity hover:opacity-70"
              style={{ color: "#06b6d4", borderColor: "#06b6d455", background: "#06b6d410" }}
            >
              <Sparkles className="w-3 h-3" />
              AI Placed · Reset
            </button>
          )}
          {activeSign.reviewFlag && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-primary border border-primary/30 bg-primary/10 px-2 py-0.5 rounded">
              <AlertTriangle className="w-3 h-3" />
              Flagged
            </span>
          )}
          {/* Location found/not-found pill */}
          {textSearchStatus === "found" && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-accent border border-accent/30 bg-accent/10 px-2 py-0.5 rounded">
              <MapPin className="w-3 h-3" />
              Located on page
            </span>
          )}
          {textSearchStatus === "not-found" && (
            <span className="flex items-center gap-1 text-[10px] font-display font-bold uppercase tracking-wider text-destructive border border-destructive/30 bg-destructive/10 px-2 py-0.5 rounded">
              <AlertTriangle className="w-3 h-3" />
              Not found on this page
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
        );
      })()}

      {/* Two-panel body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: PDF Viewer */}
        <div className="flex-1 flex flex-col bg-secondary/30 border-r border-border min-w-0">
          {/* PDF toolbar */}
          <div className="flex-none flex items-center gap-3 px-4 py-2 bg-card border-b border-border">
            <button
              aria-label="Previous page"
              disabled={pageNumber <= 1}
              onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-muted-foreground min-w-[80px] text-center">
              {numPages ? `${pageNumber} / ${numPages}` : "—"}
            </span>
            <button
              aria-label="Next page"
              disabled={numPages === null || pageNumber >= numPages}
              onClick={() => setPageNumber((p) => (numPages ? Math.min(numPages, p + 1) : p))}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={() => setScale((s) => Math.max(0.4, s - 0.15))}
              disabled={scale <= 0.4}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-muted-foreground w-12 text-center">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => setScale((s) => Math.min(2.5, s + 0.15))}
              disabled={scale >= 2.5}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            {activeSign.pageNumber ? (
              <button
                onClick={() => setPageNumber(activeSign.pageNumber!)}
                className="text-xs font-mono px-2 py-0.5 rounded transition-colors"
                style={{
                  backgroundColor: "#22c55e22",
                  color: "#22c55e",
                  border: "1px solid #22c55e55",
                }}
                title="Jump to AI-detected sign page"
              >
                ● Go to pg {activeSign.pageNumber}
              </button>
            ) : activeSign.sheetNumber ? (
              <span className="text-xs text-muted-foreground">
                Sheet <span className="font-mono text-foreground">{activeSign.sheetNumber}</span>
              </span>
            ) : null}

            {/* Visual-locate loading indicator */}
            {visualLocating && (
              <span className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded" style={{ color: "#06b6d4", background: "#06b6d410", border: "1px solid #06b6d455" }}>
                <Loader2 className="w-3 h-3 animate-spin" />
                AI locating...
              </span>
            )}
            {!visualLocating && visualCandidates.size > 0 && (
              <span className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded" style={{ color: "#06b6d4", background: "#06b6d410", border: "1px solid #06b6d455" }}>
                <Sparkles className="w-3 h-3" />
                AI located — confirm or pick alternative
              </span>
            )}

            {/* Overlay toggle + draw mode — pushed to right */}
            <div className="ml-auto flex items-center gap-2">
              {/* Debug overlay: shows all extracted phrase bboxes */}
              {serverPhrases && (
                <button
                  onClick={() => setDebugMode((v) => !v)}
                  className="flex items-center gap-1 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
                  style={debugMode ? {
                    background: "#f59e0b20",
                    color: "#f59e0b",
                    borderColor: "#f59e0b55",
                  } : {
                    background: "transparent",
                    color: "var(--muted-foreground)",
                    borderColor: "var(--border)",
                  }}
                  title="Toggle debug overlay — shows all extracted text bounding boxes"
                >
                  ⬡ debug
                </button>
              )}
              {textMarkers.length > 0 && (
                <button
                  onClick={() => setShowOverlay((v) => !v)}
                  className="flex items-center gap-1.5 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
                  style={showOverlay ? {
                    background: "#22c55e20",
                    color: "#22c55e",
                    borderColor: "#22c55e55",
                  } : {
                    background: "transparent",
                    color: "var(--muted-foreground)",
                    borderColor: "var(--border)",
                  }}
                  title={showOverlay ? "Hide markers" : "Show markers"}
                >
                  {showOverlay ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  {textMarkers.length} marker{textMarkers.length !== 1 ? "s" : ""}
                </button>
              )}
              {/* Draw mode toggle */}
              {pdfReady && (
                <button
                  onClick={() => setDrawMode((v) => !v)}
                  className="flex items-center gap-1.5 text-[10px] font-display font-semibold uppercase tracking-wide px-2 py-1 rounded transition-colors border"
                  style={drawMode ? {
                    background: "#a855f720",
                    color: "#a855f7",
                    borderColor: "#a855f755",
                  } : {
                    background: "transparent",
                    color: "var(--muted-foreground)",
                    borderColor: "var(--border)",
                  }}
                  title={drawMode ? "Exit draw mode" : "Enter draw mode: click to add markers, X to delete"}
                >
                  {drawMode ? <PenLine className="w-3 h-3" /> : <MousePointer className="w-3 h-3" />}
                  {drawMode ? "Draw" : "Edit Markers"}
                </button>
              )}
            </div>

            {/* Signs on current page chips — click to switch active sign */}
            {signsOnCurrentPage.length > 0 && (
              <div className="flex items-center gap-1.5 ml-2 overflow-x-auto max-w-[320px]">
                {signsOnCurrentPage.map((s) => {
                  const isActive = s.id === activeSign.id;
                  return (
                    <button
                      key={s.id}
                      title={`${s.signType ?? "Sign"} — ${s.location ?? ""}\nClick to edit this sign`}
                      onClick={() => setActiveSign(s)}
                      className="flex-shrink-0 flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap transition-all"
                      style={{
                        backgroundColor: isActive ? "#22c55e" : "#22c55e18",
                        color: isActive ? "#fff" : "#22c55e",
                        border: `1px solid ${isActive ? "#22c55e" : "#22c55e55"}`,
                        fontWeight: isActive ? 700 : 500,
                        boxShadow: isActive ? "0 0 8px #22c55e55" : "none",
                        cursor: "pointer",
                      }}
                    >
                      {isActive && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-white flex-shrink-0" />
                      )}
                      {s.signIdentifier ?? s.signType?.slice(0, 8) ?? "SIGN"}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* PDF canvas + overlay */}
          <div ref={pdfContainerRef} className="flex-1 overflow-auto p-4 flex justify-center items-start">
            {rawPdfApiUrl && !pdfReady && !pdfLoadError && (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            )}
            {pdfLoadError && !pdfReady && (
              <div className="flex flex-col items-center justify-center h-64 text-destructive gap-2">
                <AlertTriangle className="w-8 h-8" />
                <p className="text-sm">Failed to load PDF</p>
                <p className="text-xs opacity-70">{pdfLoadError}</p>
              </div>
            )}
            {pdfReady ? (
              <Document
                file={pdfFile}
                onLoadSuccess={({ numPages }) => {
                  setNumPages(numPages);
                  setPdfError(null);
                }}
                onLoadError={(err) => setPdfError(err.message)}
                loading={
                  <div className="flex items-center justify-center h-64">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                  </div>
                }
                error={
                  <div className="flex flex-col items-center justify-center h-64 text-destructive gap-2">
                    <AlertTriangle className="w-8 h-8" />
                    <p className="text-sm">Failed to load PDF</p>
                    {pdfError && <p className="text-xs opacity-70">{pdfError}</p>}
                  </div>
                }
              >
                {/* Wrap page + overlay in a relative container */}
                <div ref={pageWrapRef} className="relative shadow-2xl inline-block">
                  <Page
                    pageNumber={pageNumber}
                    scale={scale}
                    renderTextLayer={true}
                    renderAnnotationLayer={true}
                  />

                  {/* Sign schedule page notice — only show when no markers found AND page is classified as schedule */}
                  {isSignSchedulePage && textMarkers.length === 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: 8,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 10,
                        pointerEvents: "none",
                      }}
                      className="px-3 py-1.5 rounded-full bg-accent/90 text-background text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap"
                    >
                      Sign Schedule Page — use Edit Markers to place manually
                    </div>
                  )}

                  {/* SVG marker overlay — visual only, above react-pdf text layer */}
                  {showOverlay && renderedW && renderedH && (textMarkers.length > 0 || (debugMode && serverPhrases)) && (
                    <svg
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: renderedW,
                        height: renderedH,
                        overflow: "visible",
                        pointerEvents: "none",
                        zIndex: 5,
                      }}
                      viewBox={`0 0 ${renderedW} ${renderedH}`}
                    >
                      {/* Debug overlay (anchor-lock path):
                            - all phrases: faint blue rect
                            - matched phrase: green bbox + blue dot (anchor) + red dot (final, overlaps blue for locked markers)
                            - labels get -LOCK suffix to confirm anchor-lock path is active */}
                      {debugMode && serverPhrases && serverPhrases.phrases.map((p, i) => {
                        const px0 = p.x0 * renderedW;
                        const py0 = p.y0 * renderedH;
                        const pw  = (p.x1 - p.x0) * renderedW;
                        const ph  = (p.y1 - p.y0) * renderedH;
                        // Phrase bbox center = anchor position (blue dot)
                        const pcx = (p.x0 + p.x1) / 2 * renderedW;
                        const pcy = (p.y0 + p.y1) / 2 * renderedH;

                        const matchedMarker = textMarkers.find((m) => m.matchedPhrase === p);
                        const isMatched = !!matchedMarker;

                        // Final marker position (red dot) in px — overlaps blue for anchor-locked markers
                        const mfx = matchedMarker ? matchedMarker.x * renderedW : null;
                        const mfy = matchedMarker ? matchedMarker.y * renderedH : null;

                        return (
                          <g key={`dbg-${i}`}>
                            {/* Phrase bounding box */}
                            <rect
                              x={px0} y={py0} width={pw} height={Math.max(ph, 2)}
                              fill={isMatched ? "#22c55e18" : "#3b82f608"}
                              stroke={isMatched ? "#22c55e" : "#3b82f6"}
                              strokeWidth={isMatched ? 1.5 : 0.5}
                              opacity={0.8}
                            />
                            {isMatched ? (
                              <>
                                {/* Red dot = final marker position (drawn first so blue overlaps it for locked markers) */}
                                {mfx != null && mfy != null && (
                                  <circle cx={mfx} cy={mfy} r={4}
                                    fill="#ef4444" opacity={0.85} />
                                )}
                                {/* Blue dot = anchor (phrase center); overlaps red dot exactly for anchor-locked markers */}
                                <circle cx={pcx} cy={pcy} r={3}
                                  fill="#3b82f6" opacity={0.9} />
                                {/* Text label above phrase with -LOCK suffix */}
                                <text x={pcx} y={py0 - 2}
                                  textAnchor="middle" fill="#22c55e"
                                  fontSize={7} fontFamily="monospace"
                                  style={{ userSelect: "none" }}
                                >
                                  {p.text.slice(0, 16)}-LOCK
                                </text>
                              </>
                            ) : (
                              /* Faint center dot for unmatched phrases */
                              <circle cx={pcx} cy={pcy} r={1.5}
                                fill="#3b82f6" opacity={0.4} />
                            )}
                          </g>
                        );
                      })}
                      {/* Debug: rejected candidate phrases drawn as yellow boxes so you can
                            compare them against the chosen green box for each marker */}
                      {debugMode && textMarkers.flatMap((m) =>
                        (m.rejectedCandidates ?? []).map((p, ri) => {
                          const px0 = p.x0 * renderedW;
                          const py0 = p.y0 * renderedH;
                          const pw  = (p.x1 - p.x0) * renderedW;
                          const ph  = (p.y1 - p.y0) * renderedH;
                          const pcx = (p.x0 + p.x1) / 2 * renderedW;
                          return (
                            <g key={`rej-${m.signId}-${ri}`}>
                              <rect
                                x={px0} y={py0} width={pw} height={Math.max(ph, 2)}
                                fill="#eab30812" stroke="#eab308" strokeWidth={1}
                                strokeDasharray="3 2" opacity={0.9}
                              />
                              <text
                                x={pcx} y={py0 - 2}
                                textAnchor="middle" fill="#eab308"
                                fontSize={6} fontFamily="monospace"
                                style={{ userSelect: "none" }}
                              >
                                {p.text.slice(0, 14)}-REJ
                              </text>
                            </g>
                          );
                        })
                      )}

                      {textMarkers.map((m) => {
                        const cx = m.x * renderedW;
                        const cy = m.y * renderedH;
                        const r = m.isCurrent ? 18 : 12;
                        const isHovered = m.signId === hoveredMarkerId;
                        const lowConfidence = m.placementScore < 0.7 && !m.isCurrent;
                        return (
                          <g key={m.signId}>
                            {/* Outer glow ring for active sign */}
                            {m.isCurrent && (
                              <circle
                                cx={cx} cy={cy} r={r + 6}
                                fill="none" stroke={m.color}
                                strokeWidth={1.5} strokeDasharray="4 3"
                                opacity={0.7}
                              />
                            )}
                            {/* Dashed ring for low-confidence placement */}
                            {lowConfidence && (
                              <circle
                                cx={cx} cy={cy} r={r + 5}
                                fill="none" stroke={m.color}
                                strokeWidth={1} strokeDasharray="3 3"
                                opacity={0.45}
                              />
                            )}
                            {/* Hover ring */}
                            {isHovered && !m.isCurrent && (
                              <circle
                                cx={cx} cy={cy} r={r + 5}
                                fill="none" stroke={m.color}
                                strokeWidth={1} opacity={0.5}
                              />
                            )}
                            {/* Filled circle — semi-transparent for low-confidence */}
                            <circle
                              cx={cx} cy={cy} r={r}
                              fill={`${m.color}${lowConfidence ? "22" : "33"}`}
                              stroke={m.color}
                              strokeWidth={m.isCurrent ? 2.5 : 1.5}
                              strokeDasharray={lowConfidence ? "4 2" : undefined}
                              opacity={lowConfidence ? 0.7 : 1}
                            />
                            {/* Pin dot */}
                            <circle cx={cx} cy={cy} r={3} fill={m.color} opacity={lowConfidence ? 0.6 : 1} />
                            {/* Label */}
                            <text
                              x={cx} y={cy - r - 5}
                              textAnchor="middle" fill={m.color}
                              fontSize={m.isCurrent ? 10 : 8}
                              fontWeight="bold" fontFamily="monospace"
                              style={{ userSelect: "none" }}
                              opacity={lowConfidence ? 0.7 : 1}
                            >
                              {debugMode && m.phraseCenter ? `${m.label}-LOCK` : m.label}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  )}

                  {/* Delete X buttons — shown in draw mode when hovering a marker */}
                  {drawMode && showOverlay && renderedW && renderedH && textMarkers.map((m) => {
                    if (m.signId !== hoveredMarkerId) return null;
                    const cx = m.x * renderedW!;
                    const cy = m.y * renderedH!;
                    const r = m.isCurrent ? 18 : 12;
                    return (
                      <button
                        key={`del-${m.signId}`}
                        title="Delete this marker"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSign(m.signId);
                        }}
                        style={{
                          position: "absolute",
                          left: cx + r - 2,
                          top: cy - r - 2,
                          zIndex: 20,
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          background: "#ef4444",
                          color: "#fff",
                          border: "2px solid #fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          padding: 0,
                          pointerEvents: "all",
                        }}
                      >
                        <Trash2 style={{ width: 9, height: 9 }} />
                      </button>
                    );
                  })}

                  {/* AI-placed badge ON the marker — shown for the active sign with AI placement.
                      Positioned below the marker dot; clicking it clears placement and re-runs visual-locate. */}
                  {showOverlay && !drawMode && renderedW && renderedH && (() => {
                    const currentMarker = textMarkers.find(
                      (m) => m.signId === activeSign.id && m.isCurrent,
                    );
                    if (!currentMarker) return null;
                    if (!activeSign.placementSource) return null;
                    const cx = currentMarker.x * renderedW;
                    const cy = currentMarker.y * renderedH;
                    const r = 18; // active marker radius
                    return (
                      <button
                        key={`ai-badge-${activeSign.id}`}
                        title={`AI placed (${activeSign.placementSource === "gemini_vision" ? "auto" : "user confirmed"}) — click to reset and re-run`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const resp = await apiFetch(`/api/extracted-signs/${activeSign.id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ xPos: null, yPos: null, placementSource: null }),
                            });
                            if (!resp.ok) return;
                            const d = await resp.json() as { sign: ExtractedSign };
                            setLocalSigns((prev) => prev.map((s) => s.id === activeSign.id ? d.sign : s));
                            setActiveSign(d.sign);
                            if (file) {
                              visualLocateQueriedRef.current.delete(`${file.id}:${pageNumber}`);
                            }
                            setVisualLocateFailed((prev) => { const n = new Set(prev); n.delete(activeSign.id); return n; });
                            setVisualCandidates((prev) => { const n = new Map(prev); n.delete(activeSign.id); return n; });
                          } catch (err) {
                            console.error("[visual-locate] marker badge reset failed:", err);
                          }
                        }}
                        style={{
                          position: "absolute",
                          left: cx - 28,
                          top: cy + r + 4,
                          zIndex: 20,
                          height: 18,
                          paddingInline: 6,
                          borderRadius: 4,
                          background: "#06b6d4",
                          color: "#fff",
                          border: "none",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 3,
                          cursor: "pointer",
                          fontSize: 9,
                          fontWeight: "bold",
                          fontFamily: "monospace",
                          letterSpacing: "0.05em",
                          pointerEvents: "all",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ✦ AI · Reset
                      </button>
                    );
                  })()}

                  {/* Visual candidate dots — alternative positions shown when Gemini returns 2-3 candidates.
                      Top candidate (#1) is always auto-applied; these dots are alternatives (#2, #3).
                      Clicking any dot overrides the auto-placed position and stores "user_confirmed". */}
                  {showOverlay && !drawMode && renderedW && renderedH && (
                    Array.from(visualCandidates.entries()).flatMap(([signId, altCandidates]) =>
                      altCandidates.map((c, altIdx) => {
                        const cx = c.x * renderedW;
                        const cy = c.y * renderedH;
                        const dotNumber = altIdx + 2; // starts at 2 (top candidate #1 already applied)
                        return (
                          <button
                            key={`vc-${signId}-${altIdx}`}
                            title={`AI alternative ${dotNumber}: ${c.description ?? ""}\nConfidence: ${Math.round((c.confidence ?? 0) * 100)}%\nClick to use this position instead`}
                            onClick={() => confirmVisualPlacement(signId, c)}
                            style={{
                              position: "absolute",
                              left: cx - 16,
                              top: cy - 16,
                              width: 32,
                              height: 32,
                              zIndex: 15,
                              cursor: "pointer",
                              borderRadius: "50%",
                              border: `2px solid #06b6d4`,
                              background: "#06b6d422",
                              color: "#06b6d4",
                              fontFamily: "monospace",
                              fontWeight: "bold",
                              fontSize: 11,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              pointerEvents: "all",
                            }}
                          >
                            {dotNumber}
                          </button>
                        );
                      })
                    )
                  )}

                  {/* Draw mode hint when hovering empty space */}
                  {drawMode && !hoveredMarkerId && renderedW && renderedH && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 8,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 10,
                        pointerEvents: "none",
                        background: "#a855f720",
                        color: "#a855f7",
                        border: "1px solid #a855f755",
                      }}
                      className="px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-lg whitespace-nowrap flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      Click to add a sign marker · hover to delete
                    </div>
                  )}

                  {/* Adding sign spinner */}
                  {addingSign && (
                    <div style={{ position: "absolute", inset: 0, zIndex: 15, display: "flex", alignItems: "center", justifyContent: "center", background: "#00000033" }}>
                      <Loader2 className="w-8 h-8 text-white animate-spin" />
                    </div>
                  )}

                  {/* Transparent click-capture overlay — handles view mode (select) and
                      draw mode (create / select). Also tracks hover for delete X. */}
                  {renderedW && renderedH && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: renderedW,
                        height: renderedH,
                        zIndex: 6,
                        cursor: drawMode
                          ? (hoveredMarkerId ? "pointer" : "crosshair")
                          : (textMarkers.length > 0 ? "pointer" : "default"),
                      }}
                      onMouseMove={(e) => {
                        if (!renderedW || !renderedH) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const nx = (e.clientX - rect.left) / renderedW;
                        const ny = (e.clientY - rect.top) / renderedH;
                        let best: TextMarker | null = null;
                        let bestDist = Infinity;
                        for (const m of textMarkers) {
                          const d = Math.hypot(m.x - nx, m.y - ny);
                          if (d < bestDist) { bestDist = d; best = m; }
                        }
                        setHoveredMarkerId(best && bestDist < 0.06 ? best.signId : null);
                      }}
                      onMouseLeave={() => setHoveredMarkerId(null)}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const nx = (e.clientX - rect.left) / renderedW!;
                        const ny = (e.clientY - rect.top) / renderedH!;

                        if (drawMode) {
                          if (hoveredMarkerId) {
                            // Select the hovered marker (don't create a new one)
                            const found = allSigns.find((s) => s.id === hoveredMarkerId);
                            if (found) setActiveSign(found);
                          } else {
                            // Create new sign at click position
                            handleCreateSign(nx, ny);
                          }
                          return;
                        }

                        // View mode: select nearest sign
                        if (textMarkers.length === 0) return;
                        let best: TextMarker | null = null;
                        let bestDist = Infinity;
                        for (const m of textMarkers) {
                          const d = Math.hypot(m.x - nx, m.y - ny);
                          if (d < bestDist) { bestDist = d; best = m; }
                        }
                        if (best && bestDist < 0.20) {
                          const found = allSigns.find((s) => s.id === best!.signId);
                          if (found) setActiveSign(found);
                        }
                      }}
                    />
                  )}
                </div>
              </Document>
            ) : (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
                <FileText className="w-12 h-12 opacity-30" />
                <p className="text-sm">No source file linked to this sign entry</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Edit form */}
        <div className="w-[380px] flex-shrink-0 flex flex-col bg-background overflow-hidden">
          <div className="flex-none px-5 py-3 border-b border-border bg-card">
            <h2 className="text-sm font-display font-bold uppercase tracking-wider text-foreground">
              Edit Sign Data
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Correct any fields extracted by AI
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {/* Location source status banner — inside scroll so it doesn't compress the form */}
            {textSearchStatus === "not-found" && (
              <div className="flex items-start gap-2 text-xs bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2.5 text-destructive">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Location not found on this page.</span>
                  <br />
                  The text &ldquo;{activeSign.location ?? activeSign.messageContent ?? "?"}&rdquo; was not found
                  in this page&rsquo;s text layer. This sign may have been attributed to the wrong
                  page by the AI. Verify the location and correct it if needed.
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Sheet Number"
                value={form.sheetNumber}
                onChange={(v) => handleField("sheetNumber", v)}
                placeholder="A-101"
              />
              <Field
                label="Sign ID / Ref"
                value={form.signIdentifier}
                onChange={(v) => handleField("signIdentifier", v)}
                placeholder="S-01"
              />
            </div>

            <Field
              label="Sign Type"
              value={form.signType}
              onChange={(v) => handleField("signType", v)}
              placeholder="e.g. Illuminated Cabinet Sign"
            />

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Quantity"
                value={form.quantity}
                onChange={(v) => handleField("quantity", v)}
                placeholder="1"
                type="number"
              />
              <Field
                label="Detail Reference"
                value={form.detailReference}
                onChange={(v) => handleField("detailReference", v)}
                placeholder="D-01"
              />
            </div>

            <Field
              label="Location"
              value={form.location}
              onChange={(v) => handleField("location", v)}
              placeholder="e.g. North elevation, above main entrance"
              multiline
            />

            <Field
              label="Dimensions"
              value={form.dimensions}
              onChange={(v) => handleField("dimensions", v)}
              placeholder='e.g. 48" × 24"'
            />

            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Mounting Type"
                value={form.mountingType}
                onChange={(v) => handleField("mountingType", v)}
                placeholder="e.g. Wall mounted"
              />
              <Field
                label="Illumination"
                value={form.illumination}
                onChange={(v) => handleField("illumination", v)}
                placeholder="e.g. LED backlit"
              />
            </div>

            <Field
              label="Finish / Color"
              value={form.finishColor}
              onChange={(v) => handleField("finishColor", v)}
              placeholder="e.g. Matte black, white face"
            />

            <Field
              label="Materials"
              value={form.materials}
              onChange={(v) => handleField("materials", v)}
              placeholder="e.g. Aluminum, acrylic face"
            />

            <Field
              label="Message / Copy"
              value={form.messageContent}
              onChange={(v) => handleField("messageContent", v)}
              placeholder="Text displayed on the sign"
              multiline
            />

            <Field
              label="Notes"
              value={form.notes}
              onChange={(v) => handleField("notes", v)}
              placeholder="Any additional notes or clarifications"
              multiline
            />

            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={form.reviewFlag}
                  onChange={(e) => handleField("reviewFlag", e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-secondary rounded-full peer-checked:bg-primary transition-colors"></div>
                <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-background rounded-full shadow transition-transform peer-checked:translate-x-4"></div>
              </div>
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                Flag for review
              </span>
            </label>
          </div>

          {/* Footer */}
          <div className="flex-none px-5 py-4 border-t border-border bg-card space-y-2">
            {saveError && (
              <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
                {saveError}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 text-sm font-display font-semibold uppercase tracking-wide rounded-lg bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-display font-semibold uppercase tracking-wide rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-[0_0_15px_rgba(255,170,0,0.15)] disabled:opacity-40 active:scale-95"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Changes
              </button>
            </div>
            <button
              onClick={() => handleDeleteSign(activeSign.id)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-display font-semibold uppercase tracking-wide rounded-lg text-destructive border border-destructive/20 hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete This Sign Entry
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  type?: string;
}) {
  const baseClass =
    "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors font-mono";

  return (
    <div>
      <label className="block text-[10px] font-display font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
        {label}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={`${baseClass} resize-none`}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={baseClass}
        />
      )}
    </div>
  );
}
