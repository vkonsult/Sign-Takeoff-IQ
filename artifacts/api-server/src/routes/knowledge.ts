import { Router, type IRouter } from "express";
import fs from "fs/promises";
import path from "path";
import { getCollection, COLLECTION_NAMES, type CollectionName } from "../lib/chroma";
import { generateQueryEmbedding, retrieveWithCitations } from "../lib/retrieval";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const WORKSPACE_ROOT = path.resolve(process.cwd(), "..");
const KNOWLEDGE_DIR = path.join(WORKSPACE_ROOT, "knowledge");

interface KnowledgeChunk {
  id: string;
  text: string;
  metadata: {
    source_file: string;
    jurisdiction: string;
    doc_type: string;
    section: string;
    effective_date: string;
    status: string;
    chunk_index: number;
  };
}

function parseFrontMatter(content: string): {
  metadata: Record<string, string>;
  body: string;
} {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { metadata: {}, body: content };
  }

  const yamlStr = fmMatch[1];
  const body = fmMatch[2].trim();
  const metadata: Record<string, string> = {};

  for (const line of yamlStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) metadata[key] = value;
  }

  return { metadata, body };
}

function chunkText(text: string, chunkSize = 2000, overlap = 200): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks.filter((c) => c.length > 50);
}

async function ingestFile(
  filePath: string,
  collectionName: CollectionName
): Promise<{ chunksAdded: number; errors: string[] }> {
  const errors: string[] = [];

  const content = await fs.readFile(filePath, "utf-8");
  const { metadata, body } = parseFrontMatter(content);

  const REQUIRED_FIELDS = ["jurisdiction", "doc_type", "section", "effective_date", "status"];
  const missing = REQUIRED_FIELDS.filter((f) => !metadata[f]);
  if (missing.length > 0) {
    const msg = `Missing metadata fields in ${filePath}: ${missing.join(", ")}`;
    logger.warn({ filePath, missing }, msg);
    errors.push(msg);
    return { chunksAdded: 0, errors };
  }

  const collection = await getCollection(collectionName);
  if (!collection) {
    const msg = "ChromaDB collection unavailable — is the ChromaDB server running?";
    errors.push(msg);
    return { chunksAdded: 0, errors };
  }

  const chunks = chunkText(body);
  if (chunks.length === 0) {
    errors.push(`No content to ingest from ${filePath}`);
    return { chunksAdded: 0, errors };
  }

  const sourceFile = path.relative(KNOWLEDGE_DIR, filePath);
  let chunksAdded = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `${sourceFile.replace(/[^a-zA-Z0-9]/g, "_")}_chunk_${i}`;
    const embedding = await generateQueryEmbedding(chunks[i]);

    if (!embedding) {
      errors.push(`Failed to embed chunk ${i} of ${sourceFile} — GOOGLE_AI_API_KEY may not be set`);
      continue;
    }

    try {
      await collection.upsert({
        ids: [chunkId],
        documents: [chunks[i]],
        embeddings: [embedding],
        metadatas: [
          {
            source_file: sourceFile,
            jurisdiction: metadata.jurisdiction,
            doc_type: metadata.doc_type,
            section: metadata.section,
            effective_date: metadata.effective_date,
            status: metadata.status,
            chunk_index: i,
          },
        ],
      });
      chunksAdded++;
    } catch (err) {
      errors.push(`Failed to upsert chunk ${i} of ${sourceFile}: ${String(err)}`);
    }
  }

  return { chunksAdded, errors };
}

router.post("/knowledge/ingest", async (req, res) => {
  const { collection, file_path: filePath } = req.body as {
    collection?: string;
    file_path?: string;
  };

  const collectionName = collection as CollectionName | undefined;

  if (collectionName && !COLLECTION_NAMES.includes(collectionName as CollectionName)) {
    res.status(400).json({
      error: `Invalid collection name. Valid collections: ${COLLECTION_NAMES.join(", ")}`,
    });
    return;
  }

  const results: Array<{ file: string; chunksAdded: number; errors: string[] }> = [];
  let totalChunks = 0;

  try {
    if (filePath) {
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(KNOWLEDGE_DIR, filePath);

      const targetCollection =
        collectionName ??
        (COLLECTION_NAMES.find((n) => absPath.includes(n)) as CollectionName | undefined);

      if (!targetCollection) {
        res.status(400).json({
          error:
            "Could not determine collection from file path. Provide 'collection' in request body.",
        });
        return;
      }

      const { chunksAdded, errors } = await ingestFile(absPath, targetCollection);
      results.push({ file: filePath, chunksAdded, errors });
      totalChunks += chunksAdded;
    } else {
      const dirsToProcess = collectionName
        ? [collectionName]
        : [...COLLECTION_NAMES];

      for (const dir of dirsToProcess) {
        const dirPath = path.join(KNOWLEDGE_DIR, dir);
        let files: string[] = [];
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          files = entries
            .filter((e) => e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".txt")))
            .filter((e) => e.name !== "README.md")
            .map((e) => path.join(dirPath, e.name));
        } catch {
          req.log.warn({ dir: dirPath }, "Knowledge directory not found or empty");
        }

        for (const f of files) {
          const { chunksAdded, errors } = await ingestFile(f, dir as CollectionName);
          results.push({ file: path.relative(KNOWLEDGE_DIR, f), chunksAdded, errors });
          totalChunks += chunksAdded;
        }
      }
    }

    req.log.info({ totalChunks, fileCount: results.length }, "Knowledge ingestion complete");

    res.json({
      success: true,
      totalChunksAdded: totalChunks,
      fileCount: results.length,
      results,
    });
  } catch (err) {
    req.log.error({ err }, "Knowledge ingestion failed");
    res.status(500).json({ error: "Knowledge ingestion failed", details: String(err) });
  }
});

router.post("/knowledge/query", async (req, res) => {
  const { text, nResults, jurisdiction, doc_type } = req.body as {
    text?: string;
    nResults?: number;
    jurisdiction?: string;
    doc_type?: CollectionName | CollectionName[];
  };

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "Query 'text' is required" });
    return;
  }

  try {
    const { results, citations } = await retrieveWithCitations({
      text: text.trim(),
      nResults: nResults ?? 5,
      jurisdiction,
      doc_type,
    });

    res.json({
      results: results.map((r) => ({
        id: r.id,
        document: r.document,
        score: r.score,
        metadata: r.metadata,
      })),
      citations,
      totalResults: results.length,
    });
  } catch (err) {
    req.log.error({ err }, "Knowledge query failed");
    res.status(500).json({ error: "Knowledge query failed", details: String(err) });
  }
});

export default router;
