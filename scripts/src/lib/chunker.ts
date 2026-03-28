export interface TextChunk {
  text: string;
  index: number;
  startChar: number;
  endChar: number;
}

const CHUNK_SIZE_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 200;
const MIN_CHUNK_CHARS = 50;

export function chunkText(
  text: string,
  chunkSize = CHUNK_SIZE_CHARS,
  overlap = CHUNK_OVERLAP_CHARS
): TextChunk[] {
  const cleanText = text.replace(/\n{3,}/g, "\n\n").trim();
  if (cleanText.length <= chunkSize) {
    return cleanText.length >= MIN_CHUNK_CHARS
      ? [{ text: cleanText, index: 0, startChar: 0, endChar: cleanText.length }]
      : [];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < cleanText.length) {
    const end = Math.min(start + chunkSize, cleanText.length);
    let splitAt = end;

    if (end < cleanText.length) {
      const sentenceEnd = findSentenceBoundary(cleanText, end, overlap);
      if (sentenceEnd !== -1) {
        splitAt = sentenceEnd;
      }
    }

    const chunkText = cleanText.slice(start, splitAt).trim();
    if (chunkText.length >= MIN_CHUNK_CHARS) {
      chunks.push({
        text: chunkText,
        index: chunkIndex++,
        startChar: start,
        endChar: splitAt,
      });
    }

    if (splitAt >= cleanText.length) break;
    start = Math.max(splitAt - overlap, start + 1);
  }

  return chunks;
}

function findSentenceBoundary(text: string, near: number, searchRadius: number): number {
  const searchStart = Math.max(0, near - searchRadius);
  const searchEnd = Math.min(text.length, near + searchRadius);
  const region = text.slice(searchStart, searchEnd);

  const sentenceEnders = [". ", ".\n", "! ", "!\n", "? ", "?\n", "\n\n"];
  let bestIdx = -1;

  for (const ender of sentenceEnders) {
    let idx = region.lastIndexOf(ender, near - searchStart);
    if (idx !== -1) {
      const absIdx = searchStart + idx + ender.length;
      if (bestIdx === -1 || Math.abs(absIdx - near) < Math.abs(bestIdx - near)) {
        bestIdx = absIdx;
      }
    }
  }

  return bestIdx;
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
