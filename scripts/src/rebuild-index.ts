/**
 * Rebuild ChromaDB index for one or all collections.
 * Wipes the collection and re-ingests all source files from the knowledge directory.
 *
 * Usage:
 *   pnpm run rebuild-index federal_codes     # Rebuild specific collection
 *   pnpm run rebuild-index                   # Rebuild ALL collections (destructive!)
 *   pnpm run rebuild-index -- --dry-run      # Preview without changes
 *
 * WARNING: This operation DELETES all existing vectors in the collection(s)
 * before re-ingesting. This cannot be undone. Ensure source files are up-to-date
 * before rebuilding.
 *
 * Requirements:
 *   - ChromaDB server running at CHROMA_SERVER_URL (default: http://localhost:8000)
 *   - GOOGLE_AI_API_KEY set for embedding generation
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

async function rebuildCollection(
  client: ChromaClient,
  collectionName: CollectionName,
  dryRun: boolean
): Promise<{ chunksAdded: number; errors: string[] }> {
  const errors: string[] = [];
  let chunksAdded = 0;

  const dirPath = path.join(KNOWLEDGE_DIR, collectionName);
  const files = await findKnowledgeFiles(dirPath);

  if (files.length === 0) {
    console.log(`  ℹ  No content files found in ${collectionName}/ — skipping`);
    return { chunksAdded, errors };
  }

  if (!dryRun) {
    try {
      console.log(`  🗑  Deleting existing collection: ${collectionName}`);
      await client.deleteCollection({ name: collectionName });
    } catch {
      // Collection may not exist yet — that's fine
      console.log(`  ℹ  Collection ${collectionName} did not exist — creating fresh`);
    }

    try {
      await client.createCollection({
        name: collectionName,
        metadata: {
          created_by: "sign-takeoff-portal",
          rebuilt_at: new Date().toISOString(),
        },
      });
      console.log(`  ✓  Created fresh collection: ${collectionName}`);
    } catch (err) {
      const msg = `Failed to create collection ${collectionName}: ${String(err)}`;
      console.error(`  ✗ ${msg}`);
      errors.push(msg);
      return { chunksAdded, errors };
    }
  }

  const collection = dryRun ? null : await client.getCollection({ name: collectionName });

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
      console.log(`     [DRY RUN] Would embed and add ${chunks.length} chunks`);
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

    const ids = chunks.map(
      (_, i) => `${kf.relativePath.replace(/[^a-zA-Z0-9]/g, "_")}_chunk_${i}`
    );
    const metadatas = chunks.map((_, i) => ({
      source_file: kf.relativePath,
      jurisdiction: kf.metadata.jurisdiction,
      doc_type: kf.metadata.doc_type,
      section: kf.metadata.section,
      effective_date: kf.metadata.effective_date,
      status: kf.metadata.status,
      chunk_index: i,
    }));

    try {
      await collection!.add({
        ids,
        documents: chunks.map((c) => c.text),
        embeddings,
        metadatas,
      });
      chunksAdded += chunks.length;
      console.log(`     ✓ Added ${chunks.length} chunks`);
    } catch (err) {
      const msg = `Failed to add chunks for ${kf.relativePath}: ${String(err)}`;
      console.error(`  ✗ ${msg}`);
      errors.push(msg);
    }
  }

  return { chunksAdded, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const targetCollection = args.find(
    (a) => !a.startsWith("--") && COLLECTION_NAMES.includes(a as CollectionName)
  ) as CollectionName | undefined;

  console.log(`\n${"=".repeat(60)}`);
  console.log("Sign Takeoff Portal — Rebuild Knowledge Index");
  console.log("=".repeat(60));
  console.log(`Mode         : ${dryRun ? "DRY RUN" : "LIVE (DESTRUCTIVE — will delete existing vectors)"}`);
  console.log(`ChromaDB URL : ${CHROMA_SERVER_URL}`);
  console.log(`Collection   : ${targetCollection ?? "ALL COLLECTIONS"}`);
  console.log("=".repeat(60));

  if (!dryRun) {
    const scope = targetCollection
      ? `the "${targetCollection}" collection`
      : "ALL collections (federal_codes, state_codes, city_codes, sign_glossary, plan_guides, customer_standards)";
    console.log(`\nWARNING: This will DELETE and rebuild ${scope}.`);
    console.log("Press Ctrl+C within 5 seconds to cancel...\n");
    await new Promise((resolve) => setTimeout(resolve, 5000));
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

    if (!process.env.GOOGLE_AI_API_KEY) {
      console.error(
        "ERROR: GOOGLE_AI_API_KEY is not set.\n" +
        "Get one at: https://makersuite.google.com/app/apikey\n"
      );
      process.exit(1);
    }
  }

  const collectionsToRebuild = targetCollection
    ? [targetCollection]
    : [...COLLECTION_NAMES];

  let totalChunks = 0;
  const allErrors: string[] = [];

  for (const collectionName of collectionsToRebuild) {
    console.log(`\n📁 Rebuilding collection: ${collectionName}`);
    const { chunksAdded, errors } = await rebuildCollection(client, collectionName, dryRun);
    totalChunks += chunksAdded;
    allErrors.push(...errors);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Rebuild Summary");
  console.log("=".repeat(60));
  console.log(`Collections rebuilt  : ${collectionsToRebuild.length}`);
  console.log(`Chunks indexed       : ${totalChunks}`);
  console.log(`Errors               : ${allErrors.length}`);

  if (allErrors.length > 0) {
    console.log("\nErrors:");
    for (const err of allErrors) {
      console.log(`  • ${err}`);
    }
    process.exit(1);
  } else {
    console.log(
      `\n✓ ${dryRun ? "Dry run complete" : "Rebuild complete"}. ${totalChunks} chunks ${dryRun ? "would be" : "were"} indexed.\n`
    );
  }
}

main().catch((err) => {
  console.error("Rebuild failed:", err);
  process.exit(1);
});
