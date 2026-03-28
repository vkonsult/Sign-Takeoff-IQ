import { GoogleGenAI } from "@google/genai";
import type { Where } from "chromadb";
import { getCollection, type CollectionName, COLLECTION_NAMES } from "./chroma";
import { logger } from "./logger";

const EMBEDDING_MODEL = "text-embedding-004";

export interface RetrievalResult {
  id: string;
  document: string;
  score: number;
  metadata: {
    source_file: string;
    jurisdiction: string;
    doc_type: string;
    section: string;
    effective_date: string;
    status: string;
    chunk_index?: number;
    [key: string]: unknown;
  };
}

export interface RetrievalQuery {
  text: string;
  nResults?: number;
  jurisdiction?: string;
  doc_type?: CollectionName | CollectionName[];
  minScore?: number;
}

function getEmbeddingClient(): GoogleGenAI | null {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    logger.warn(
      "GOOGLE_AI_API_KEY not set — RAG retrieval requires a Google AI API key for embeddings. " +
      "Set GOOGLE_AI_API_KEY in your environment to enable semantic search."
    );
    return null;
  }
  return new GoogleGenAI({ apiKey });
}

export async function generateQueryEmbedding(text: string): Promise<number[] | null> {
  const client = getEmbeddingClient();
  if (!client) return null;

  try {
    const response = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text,
    });
    const values = response.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      logger.warn({ text: text.slice(0, 50) }, "Empty embedding returned from Google AI");
      return null;
    }
    return Array.from(values);
  } catch (err) {
    logger.error({ err }, "Failed to generate query embedding");
    return null;
  }
}

export async function retrieveKnowledge(query: RetrievalQuery): Promise<RetrievalResult[]> {
  const { text, nResults = 5, jurisdiction, doc_type, minScore = 0 } = query;

  const embedding = await generateQueryEmbedding(text);
  if (!embedding) {
    logger.warn("Cannot retrieve knowledge — embedding generation failed");
    return [];
  }

  const collectionsToSearch: CollectionName[] = doc_type
    ? (Array.isArray(doc_type) ? doc_type : [doc_type])
    : [...COLLECTION_NAMES];

  const allResults: RetrievalResult[] = [];

  const whereFilter: Where | undefined = jurisdiction
    ? ({ jurisdiction } as Where)
    : undefined;

  for (const collectionName of collectionsToSearch) {
    const collection = await getCollection(collectionName);
    if (!collection) continue;

    try {
      const queryResult = await collection.query({
        queryEmbeddings: [embedding],
        nResults: Math.ceil(nResults / collectionsToSearch.length) + 2,
        where: whereFilter,
        include: ["documents", "metadatas", "distances"],
      });

      const ids = queryResult.ids[0] ?? [];
      const documents = queryResult.documents[0] ?? [];
      const metadatas = queryResult.metadatas[0] ?? [];
      const distances = queryResult.distances?.[0] ?? [];

      for (let i = 0; i < ids.length; i++) {
        const distance = distances[i] ?? 1;
        const score = 1 - distance;

        if (score < minScore) continue;

        allResults.push({
          id: ids[i],
          document: documents[i] ?? "",
          score,
          metadata: (metadatas[i] ?? {}) as RetrievalResult["metadata"],
        });
      }
    } catch (err) {
      logger.error({ err, collection: collectionName }, "Failed to query ChromaDB collection");
    }
  }

  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, nResults);
}

export async function retrieveWithCitations(
  query: RetrievalQuery
): Promise<{ results: RetrievalResult[]; citations: string[] }> {
  const results = await retrieveKnowledge(query);

  const citations = results
    .filter((r) => r.metadata.source_file)
    .map((r) => {
      const parts: string[] = [];
      if (r.metadata.section) parts.push(r.metadata.section);
      if (r.metadata.source_file) parts.push(`(${r.metadata.source_file})`);
      if (r.metadata.jurisdiction && r.metadata.jurisdiction !== "universal") {
        parts.unshift(r.metadata.jurisdiction);
      }
      return parts.join(" ");
    })
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  return { results, citations };
}
