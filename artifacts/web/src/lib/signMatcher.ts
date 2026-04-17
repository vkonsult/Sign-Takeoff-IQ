/**
 * Shared sign location matching utility.
 *
 * Extracted from SignReviewModal.tsx so that FloorPlanViewer.tsx and the
 * edit modal always use the same multi-pass algorithm, guaranteeing that
 * the floor-plan view and the modal show the sign marker at the same position.
 *
 * Exports:
 *   - findSignLocationFromPhrases  (primary matcher — multi-pass)
 *   - PdfPhrase                    (phrase shape from the words API)
 */

import type { ExtractedSign } from "@/types/sign";

/** Phrase extracted server-side from the PDF text layer (normalised bbox). */
export interface PdfPhrase {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function normId(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]/g, "");
}

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

const SIGN_ABBREV_CANON: Record<string, string> = {
  ELEV: "ELEVATOR",
  ELEVATOR: "ELEVATOR",
  STAIR: "STAIRWELL",
  STAIRWELL: "STAIRWELL",
  STR: "STAIRWELL",
  MECH: "MECHANICAL",
  MECHANICAL: "MECHANICAL",
  EQUIP: "EQUIPMENT",
  EQUIPMENT: "EQUIPMENT",
  STOR: "STORAGE",
  STORAGE: "STORAGE",
  UTIL: "UTILITY",
  UTILITY: "UTILITY",
  MAINT: "MAINTENANCE",
  MAINTENANCE: "MAINTENANCE",
  ELEC: "ELECTRICAL",
  ELECTRICAL: "ELECTRICAL",
  TELECOM: "TELECOMMUNICATIONS",
  TELECOMMUNICATIONS: "TELECOMMUNICATIONS",
  COMM: "COMMUNICATIONS",
  COMMUNICATIONS: "COMMUNICATIONS",
  CORR: "CORRIDOR",
  CORRIDOR: "CORRIDOR",
  JAN: "JANITOR",
  JANITOR: "JANITOR",
  VEST: "VESTIBULE",
  VESTIBULE: "VESTIBULE",
  CONF: "CONFERENCE",
  CONFERENCE: "CONFERENCE",
  COLLAB: "COLLABORATION",
  COLLABORATION: "COLLABORATION",
  RECEPT: "RECEPTION",
  RECEPTION: "RECEPTION",
  LAUND: "LAUNDRY",
  LAUNDRY: "LAUNDRY",
  PKG: "PARKING",
  PARKING: "PARKING",
  GYM: "GYMNASIUM",
  GYMNASIUM: "GYMNASIUM",
  MGMT: "MANAGEMENT",
  MANAGEMENT: "MANAGEMENT",
  LOBBY: "LOBBY",
  LOUNGE: "LOUNGE",
  OFFICE: "OFFICE",
  OFC: "OFFICE",
  RESTROOM: "RESTROOM",
  WRR: "RESTROOM",
  MRR: "RESTROOM",
  RR: "RESTROOM",
  TOILET: "RESTROOM",
  BATH: "BATHROOM",
  BATHROOM: "BATHROOM",
  BREAK: "BREAKROOM",
  BREAKROOM: "BREAKROOM",
  BREAKOUT: "BREAKOUT",
  COPY: "COPYROOM",
  COPYROOM: "COPYROOM",
  SERVER: "SERVERROOM",
  SERVERROOM: "SERVERROOM",
  CLASS: "CLASSROOM",
  CLASSROOM: "CLASSROOM",
  LIB: "LIBRARY",
  LIBRARY: "LIBRARY",
  CAFE: "CAFETERIA",
  CAFET: "CAFETERIA",
  CAFETERIA: "CAFETERIA",
  LAB: "LABORATORY",
  LABORATORY: "LABORATORY",
  ADMIN: "ADMINISTRATION",
  ADMINISTRATION: "ADMINISTRATION",
  AUD: "AUDITORIUM",
  AUDITORIUM: "AUDITORIUM",
  PREK: "PREKINDERGARTEN",
  PREKINDERGARTEN: "PREKINDERGARTEN",
  MEDIA: "MEDIACENTER",
  MEDIACENTER: "MEDIACENTER",
  NURSE: "NURSEOFFICE",
  NURSEOFFICE: "NURSEOFFICE",
  COUNS: "COUNSELOR",
  COUNSELOR: "COUNSELOR",
  ART: "ARTROOM",
  ARTROOM: "ARTROOM",
  MUSIC: "MUSICROOM",
  MUSICROOM: "MUSICROOM",
  SCI: "SCIENCELABORATORY",
  SCIENCELABORATORY: "SCIENCELABORATORY",
  CHEM: "CHEMISTRYLABORATORY",
  CHEMISTRYLABORATORY: "CHEMISTRYLABORATORY",
  COMP: "COMPUTERLAB",
  COMPUTERLAB: "COMPUTERLAB",
  TECH: "TECHNOLOGY",
  TECHNOLOGY: "TECHNOLOGY",
};

function canonToken(tok: string): string {
  const upper = tok.toUpperCase();
  const canon = SIGN_ABBREV_CANON[upper];
  return canon ? canon.toLowerCase() : tok.toLowerCase();
}

function levenshtein(s: string, t: string): number {
  const m = s.length, n = t.length;
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

function levenshteinSim(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function bestTokenMatch(qtok: string, phraseTokens: string[]): number {
  let best = 0;
  const qcanon = canonToken(qtok);
  for (const ptok of phraseTokens) {
    if (qtok === ptok) return 1;
    const [shorter, longer] = qtok.length <= ptok.length ? [qtok, ptok] : [ptok, qtok];
    if (longer.startsWith(shorter)) {
      best = Math.max(best, shorter.length / longer.length);
    }
    if (qcanon === canonToken(ptok)) {
      best = Math.max(best, 0.95);
      continue;
    }
    best = Math.max(best, levenshteinSim(qtok, ptok));
  }
  return best;
}

export function phraseMatchScore(phraseText: string, query: string): number {
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
  if (words.length === 0) return true;

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
  if (words.length === 0) return 1;

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
        break;
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
  roomBonus: number;
  clusterScore: number;
  totalScore: number;
}

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
      const totalScore =
        roomTokens.length > 0
          ? roomBonus * 0.60 + clusterScore * 0.30 + c.score * 0.10
          : clusterScore * 0.65 + c.score * 0.35;
      return { phrase: c.phrase, x: c.x, y: c.y, phraseScore: c.score, roomBonus, clusterScore, totalScore };
    })
    .sort((a, b) => b.totalScore - a.totalScore);
}

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

export function parseLocationParts(
  location: string,
): { typeToken: string | null; numberToken: string | null } {
  const ROOM_NUM_RE = /\b(?:[A-Za-z]{1,2}\d{2,4}[A-Za-z]?|\d{2,4}[A-Za-z]{1,2})\b/g;
  const numberMatches = location.match(ROOM_NUM_RE) ?? [];
  const numberToken = numberMatches.length > 0 ? numberMatches[0]! : null;
  const typeRaw = location.replace(ROOM_NUM_RE, " ").replace(/\s+/g, " ").trim();
  const typeToken = typeRaw.length >= 2 ? typeRaw : null;
  return { typeToken, numberToken };
}

const RESIDENTIAL_UNIT_TYPE_RE = /^\s*(?:UNIT|SUITE|APT|APARTMENT|FLAT|CONDO|STUDIO|TOWNHOUSE|TH|PH|PENTHOUSE)\b/i;

export function isResidentialUnitLocation(location: string): boolean {
  const { typeToken, numberToken } = parseLocationParts(location);
  if (!typeToken || !numberToken) return false;
  return RESIDENTIAL_UNIT_TYPE_RE.test(typeToken);
}

export function findPairedClusterMatch(
  drawingPhrases: PdfPhrase[],
  typeToken: string,
  numberToken: string,
  signId: string | undefined,
): { x: number; y: number; matched: string; score: number; phrase: PdfPhrase; rejectedCandidates: PdfPhrase[] } | null | "ambiguous" {
  const CLUSTER_RADIUS = 0.05;
  const TYPE_MATCH_THRESHOLD = 0.70;

  const typeCands = drawingPhrases.filter(
    (p) => phraseMatchScore(p.text, typeToken) >= TYPE_MATCH_THRESHOLD,
  );

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

  pairs.sort((a, b) => a.dist - b.dist);
  const winner = pairs[0]!;
  const second = pairs[1];

  if (second !== undefined && second.dist - winner.dist < 0.02) {
    console.log(
      `  → AMBIGUOUS: winner dist=${winner.dist.toFixed(3)} vs second dist=${second.dist.toFixed(3)}`,
    );
    return "ambiguous";
  }

  const anchor = {
    x: (winner.numPhrase.x0 + winner.numPhrase.x1) / 2,
    y: (winner.numPhrase.y0 + winner.numPhrase.y1) / 2,
  };
  console.log(
    `  → WINNER: "${winner.typePhrase.text}" + "${winner.numPhrase.text}" ` +
    `anchor=(${anchor.x.toFixed(3)},${anchor.y.toFixed(3)}) score=0.95`,
  );

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
export function findSignLocationFromPhrases(
  phrases: PdfPhrase[],
  sign: ExtractedSign,
): { x: number; y: number; matched: string; score: number; phrase: PdfPhrase; rejectedCandidates?: PdfPhrase[] } | null {

  const drawingPhrases = phrases.filter((p) => {
    const cy = (p.y0 + p.y1) / 2;
    return cy >= 0.04 && cy <= 0.96 && p.text.trim().length >= 2;
  });

  let spatialXMin = 0;
  let spatialXMax = 1;
  if (sign.location) {
    const locUp = sign.location.toUpperCase();
    if (/\bB\d{3}[A-Z]?\b/.test(locUp)) spatialXMin = 0.45;
    else if (/\bA\d{3}[A-Z]?\b/.test(locUp)) spatialXMax = 0.55;
  }
  const hasSpatialBias = spatialXMin > 0 || spatialXMax < 1;
  const phraseInRange = (p: PdfPhrase) => {
    const px = (p.x0 + p.x1) / 2;
    return px >= spatialXMin && px <= spatialXMax;
  };
  const sdp = hasSpatialBias ? drawingPhrases.filter(phraseInRange) : drawingPhrases;
  const sap = hasSpatialBias ? phrases.filter(phraseInRange) : phrases;

  // ── Pre-Pass A: verbatim signIdentifier in drawing phrases only ──────────
  if (sign.signIdentifier && sign.signIdentifier.trim().length >= 2) {
    const idVerbatim = sign.signIdentifier.trim().toUpperCase();
    for (const p of sdp) {
      if (p.text.trim().toUpperCase().includes(idVerbatim)) {
        return {
          x: (p.x0 + p.x1) / 2,
          y: (p.y0 + p.y1) / 2,
          matched: p.text,
          score: 1.0,
          phrase: p,
        };
      }
    }
  }

  // ── Pre-Pass B: token-overlap scorer ─────────────────────────────────────
  if (sign.location && sign.location.trim().length >= 2) {
    const locTokensRaw = sign.location.trim().toUpperCase().split(/\s+/).filter((t) => t.length >= 2);
    if (locTokensRaw.length > 0) {
      const locTokensCanon = locTokensRaw.map(canonToken);
      let bestOverlapScore = 0;
      let bestOverlapPhrase: PdfPhrase | null = null;
      for (const p of sdp) {
        const phraseTokens = p.text.trim().toUpperCase().split(/\s+/).filter((t) => t.length >= 2);
        if (phraseTokens.length === 0) continue;
        const phraseTokensCanon = phraseTokens.map(canonToken);
        const union = new Set([...locTokensCanon, ...phraseTokensCanon]);
        const intersection = locTokensCanon.filter((t) => phraseTokensCanon.includes(t));
        const score = intersection.length / union.size;
        if (score > bestOverlapScore) {
          bestOverlapScore = score;
          bestOverlapPhrase = p;
        }
      }
      if (bestOverlapScore >= 0.4 && bestOverlapPhrase) {
        console.log(
          `[MATCH] ${sign.signIdentifier ?? "?"} Pre-B token-overlap→"${bestOverlapPhrase.text}" score=${bestOverlapScore.toFixed(2)}`,
        );
        return {
          x: (bestOverlapPhrase.x0 + bestOverlapPhrase.x1) / 2,
          y: (bestOverlapPhrase.y0 + bestOverlapPhrase.y1) / 2,
          matched: bestOverlapPhrase.text,
          score: bestOverlapScore,
          phrase: bestOverlapPhrase,
        };
      }
    }
  }

  // ── Pre-Pass C: room-number regex extractor ───────────────────────────────
  if (sign.location && sign.location.trim().length >= 2) {
    const roomNumRegex = /\b(?:[A-Z]{1,2}-\d{2,4}|[A-Z]?\d{3}[A-Z]?)\b/g;
    const roomNums = (sign.location.trim().toUpperCase().match(roomNumRegex) ?? []);
    for (const roomNum of roomNums) {
      for (const p of sdp) {
        const phraseUp = p.text.trim().toUpperCase();
        const phraseRooms: string[] = phraseUp.match(roomNumRegex) ?? [];
        if (phraseRooms.includes(roomNum)) {
          console.log(
            `[MATCH] ${sign.signIdentifier ?? "?"} Pre-C room-num→"${p.text}" room=${roomNum}`,
          );
          return {
            x: (p.x0 + p.x1) / 2,
            y: (p.y0 + p.y1) / 2,
            matched: p.text,
            score: 0.85,
            phrase: p,
          };
        }
      }
    }
  }

  // ── Pass 0: exact identifier ───────────────────────────────────────────────
  if (sign.signIdentifier && sign.signIdentifier.length >= 3) {
    const idNorm = normId(sign.signIdentifier);
    if (idNorm.length >= 3) {
      const idHits: { x: number; y: number; phrase: PdfPhrase }[] = [];
      for (const p of sap) {
        if (exactBoundaryMatch(normId(p.text), idNorm)) {
          idHits.push({ x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2, phrase: p });
        }
      }
      if (idHits.length === 1) {
        return { x: idHits[0]!.x, y: idHits[0]!.y, matched: sign.signIdentifier, score: 1.0, phrase: idHits[0]!.phrase };
      }
      if (idHits.length > 1 && sign.location) {
        const NEIGHBOR_RADIUS = 0.12;
        const scored = idHits.map((hit) => {
          const neighbors = sap.filter((p) => {
            const px = (p.x0 + p.x1) / 2;
            const py = (p.y0 + p.y1) / 2;
            return Math.hypot(px - hit.x, py - hit.y) <= NEIGHBOR_RADIUS;
          });
          const neighborText = neighbors.map((p) => p.text).join(" ");
          const score = phraseMatchScore(neighborText, sign.location!);
          return { ...hit, neighborScore: score };
        });
        scored.sort((a, b) => b.neighborScore - a.neighborScore);
        const best = scored[0]!;
        const second = scored[1];
        if (!second || best.neighborScore - second.neighborScore >= 0.15) {
          return { x: best.x, y: best.y, matched: sign.signIdentifier, score: 0.95, phrase: best.phrase };
        }
      }
    }
  }

  const locationSource = [sign.location, sign.messageContent].filter(Boolean).join(" ");

  // ── Pass 0.5: paired-cluster match ────────────────────────────────────────
  if (sign.location) {
    const { typeToken, numberToken } = parseLocationParts(sign.location);
    if (typeToken && numberToken) {
      const clusterResult = findPairedClusterMatch(
        sdp,
        typeToken,
        numberToken,
        sign.signIdentifier ?? undefined,
      );
      if (clusterResult === "ambiguous") return null;
      if (clusterResult !== null) return clusterResult;
      // cluster search found no pair — fall through to Pass 1, 2, 3
    }
  }

  // ── Pass 1: full-phrase location string match ──────────────────────────────
  const PASS1_THRESHOLD = 0.65;
  if (sign.location) {
    let bestScore = 0;
    const candidates: { score: number; phrase: PdfPhrase; x: number; y: number }[] = [];

    for (const p of sdp) {
      const score = phraseMatchScore(p.text, sign.location);
      if (score >= PASS1_THRESHOLD) {
        candidates.push({ score, phrase: p, x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2 });
        if (score > bestScore) bestScore = score;
      }
    }

    if (candidates.length > 0) {
      const ranked1 = rankCandidates(candidates, sdp, sign.location ?? locationSource, "");
      const top1 = ranked1[0]!;
      const second1 = ranked1[1];

      const ambiguous1 = second1 !== undefined
        && (top1.totalScore - second1.totalScore) < 0.12
        && top1.totalScore < 0.75;

      if (ambiguous1) {
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

      for (const p of sdp) {
        if (roomMatch(normId(p.text), tokenNorm)) {
          hits.push({ x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2, phrase: p });
        }
      }

      if (hits.length === 0) continue;

      const floorPlanHits = hits.filter((h) =>
        hasContextNearHitInPhrases(sdp, locationSource, tokenNorm, h.x, h.y),
      );
      if (floorPlanHits.length === 0) continue;

      const pass2Cands = floorPlanHits.map((h) => ({ score: 0.75, phrase: h.phrase, x: h.x, y: h.y }));
      const ranked2 = rankCandidates(pass2Cands, sdp, locationSource, tokenNorm);
      const top2 = ranked2[0]!;
      const second2 = ranked2[1];

      const ambiguous2 = second2 !== undefined
        && (top2.totalScore - second2.totalScore) < 0.12
        && top2.totalScore < 0.75;

      if (ambiguous2) {
        console.log(
          `[MATCH] ${sign.signIdentifier ?? "?"} P2-AMBIGUOUS on "${token}": ` +
          `top="${top2.phrase.text}" ${top2.totalScore.toFixed(2)} vs ` +
          `"${second2.phrase.text}" ${second2.totalScore.toFixed(2)}`,
        );
        continue;
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
    for (const p of sdp) {
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
