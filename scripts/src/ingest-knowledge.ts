/**
 * Ingest knowledge files into ChromaDB collections.
 *
 * Usage:
 *   pnpm run ingest-knowledge                   # Ingest all collections
 *   pnpm run ingest-knowledge federal_codes     # Ingest specific collection
 *   pnpm run ingest-knowledge -- --dry-run      # Preview without storing
 *
 * Requirements:
 *   - ChromaDB server running at CHROMA_SERVER_URL (default: http://localhost:8000)
 *     Start with: chroma run --path ../../data/chroma
 *   - GOOGLE_AI_API_KEY set for embedding generation
 *     Get one at: https://makersuite.google.com/app/apikey
 */

import path from "path";
import { fileURLToPath } from "url";
import { ChromaClient } from "chromadb";
import { embedBatch } from "./lib/embeddings.js";
import { chunkText } from "./lib/chunker.js";
import { findKnowledgeFiles, loadKnowledgeFile } from "./lib/knowledge-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../..");
const KNOWLEDGE_DIR = path.join(WORKSPACE_ROOT, "knowledge");

const COLLECTION_NAMES = [
  "federal_codes",
  "state_codes",
  "city_codes",
  "sign_glossary",
  "plan_guides",
  "customer_standards",
] as const;

type CollectionName = (typeof COLLECTION_NAMES)[number];

const CHROMA_SERVER_URL = process.env.CHROMA_SERVER_URL ?? "http://localhost:8000";

async function ingestCollection(
  client: ChromaClient,
  collectionName: CollectionName,
  dryRun: boolean
): Promise<{ filesProcessed: number; chunksAdded: number; errors: string[] }> {
  const dirPath = path.join(KNOWLEDGE_DIR, collectionName);
  const files = await findKnowledgeFiles(dirPath);
  const errors: string[] = [];
  let filesProcessed = 0;
  let chunksAdded = 0;

  if (files.length === 0) {
    console.log(`  ℹ  No content files found in ${collectionName}/`);
    return { filesProcessed, chunksAdded, errors };
  }

  let collection = null;
  if (!dryRun) {
    try {
      collection = await client.getOrCreateCollection({
        name: collectionName,
        metadata: { created_by: "sign-takeoff-portal" },
      });
    } catch (err) {
      const msg = `Could not connect to ChromaDB collection "${collectionName}": ${String(err)}`;
      console.error(`  ✗ ${msg}`);
      errors.push(msg);
      return { filesProcessed, chunksAdded, errors };
    }
  }

  for (const filePath of files) {
    const kf = await loadKnowledgeFile(filePath, KNOWLEDGE_DIR);

    if (!kf.isValid) {
      console.log(`  ✗ Skipping ${kf.relativePath} — validation errors:`);
      for (const err of kf.validationErrors) {
        console.log(`      • ${err}`);
      }
      errors.push(...kf.validationErrors);
      continue;
    }

    const chunks = chunkText(kf.body);
    console.log(`  → ${kf.relativePath} — ${chunks.length} chunk(s)`);

    if (dryRun) {
      console.log(`     [DRY RUN] Would embed ${chunks.length} chunks`);
      filesProcessed++;
      chunksAdded += chunks.length;
      continue;
    }

    let embeddings: number[][];
    try {
      embeddings = await embedBatch(chunks.map((c) => c.text));
    } catch (err) {
      const msg = `Embedding failed for ${kf.relativePath}: ${String(err)}`;
      console.error(`  ✗ ${msg}`);
      errors.push(msg);
      continue;
    }

    const ids: string[] = [];
    const documents: string[] = [];
    const embeddingsList: number[][] = [];
    const metadatas: Record<string, string | number>[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${kf.relativePath.replace(/[^a-zA-Z0-9]/g, "_")}_chunk_${i}`;
      ids.push(chunkId);
      documents.push(chunks[i].text);
      embeddingsList.push(embeddings[i]);
      metadatas.push({
        source_file: kf.relativePath,
        jurisdiction: kf.metadata.jurisdiction,
        doc_type: kf.metadata.doc_type,
        section: kf.metadata.section,
        effective_date: kf.metadata.effective_date,
        status: kf.metadata.status,
        chunk_index: i,
      });
    }

    try {
      await collection!.upsert({ ids, documents, embeddings: embeddingsList, metadatas });
      filesProcessed++;
      chunksAdded += chunks.length;
      console.log(`     ✓ Ingested ${chunks.length} chunks`);
    } catch (err) {
      const msg = `Failed to upsert ${kf.relativePath}: ${String(err)}`;
      console.error(`  ✗ ${msg}`);
      errors.push(msg);
    }
  }

  return { filesProcessed, chunksAdded, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const targetCollection = args.find(
    (a) => !a.startsWith("--") && COLLECTION_NAMES.includes(a as CollectionName)
  ) as CollectionName | undefined;

  console.log(`\n${"=".repeat(60)}`);
  console.log("Sign Takeoff Portal — Knowledge Ingestion");
  console.log("=".repeat(60));
  console.log(`Mode         : ${dryRun ? "DRY RUN (no data will be stored)" : "LIVE"}`);
  console.log(`ChromaDB URL : ${CHROMA_SERVER_URL}`);
  console.log(`Knowledge dir: ${KNOWLEDGE_DIR}`);
  console.log(`Collection   : ${targetCollection ?? "all"}`);
  console.log("=".repeat(60) + "\n");

  if (!process.env.GOOGLE_AI_API_KEY && !dryRun) {
    console.error(
      "ERROR: GOOGLE_AI_API_KEY is not set.\n" +
      "Embeddings require a Google AI API key.\n" +
      "Get one at: https://makersuite.google.com/app/apikey\n" +
      "Set it with: export GOOGLE_AI_API_KEY=your_key_here\n" +
      "Or use --dry-run to preview without generating embeddings."
    );
    process.exit(1);
  }

  const client = new ChromaClient({ path: CHROMA_SERVER_URL });

  if (!dryRun) {
    try {
      await client.heartbeat();
      console.log("✓ ChromaDB server is reachable\n");
    } catch {
      console.error(
        `ERROR: Cannot connect to ChromaDB at ${CHROMA_SERVER_URL}\n` +
        "Start ChromaDB with:\n" +
        "  pip install chromadb\n" +
        `  chroma run --path ${WORKSPACE_ROOT}/data/chroma --host localhost --port 8000\n`
      );
      process.exit(1);
    }
  }

  const collectionsToProcess = targetCollection
    ? [targetCollection]
    : [...COLLECTION_NAMES];

  let totalFiles = 0;
  let totalChunks = 0;
  const allErrors: string[] = [];

  for (const collectionName of collectionsToProcess) {
    console.log(`\n📁 Processing collection: ${collectionName}`);
    const { filesProcessed, chunksAdded, errors } = await ingestCollection(
      client,
      collectionName,
      dryRun
    );
    totalFiles += filesProcessed;
    totalChunks += chunksAdded;
    allErrors.push(...errors);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Ingestion Summary");
  console.log("=".repeat(60));
  console.log(`Files processed  : ${totalFiles}`);
  console.log(`Chunks added     : ${totalChunks}`);
  console.log(`Errors           : ${allErrors.length}`);

  if (allErrors.length > 0) {
    console.log("\nErrors encountered:");
    for (const err of allErrors) {
      console.log(`  • ${err}`);
    }
    process.exit(1);
  } else {
    console.log(
      `\n✓ ${dryRun ? "Dry run complete" : "Ingestion complete"}. ${totalChunks} chunks ${dryRun ? "would be" : "were"} indexed.\n`
    );
  }
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
