import { ChromaClient, type Collection } from "chromadb";
import { logger } from "./logger";

export const COLLECTION_NAMES = [
  "federal_codes",
  "state_codes",
  "city_codes",
  "sign_glossary",
  "plan_guides",
  "customer_standards",
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];

const COLLECTION_DESCRIPTIONS: Record<CollectionName, string> = {
  federal_codes: "Federal sign codes, ADA regulations, and MUTCD standards",
  state_codes: "State-level sign codes and accessibility standards by state",
  city_codes: "City and local jurisdiction sign ordinances and permit requirements",
  sign_glossary: "Sign industry terminology, materials, and technical definitions",
  plan_guides: "Guides for reading architectural plans, sign schedules, and construction documents",
  customer_standards: "Customer-specific brand standards and sign requirements",
};

// ChromaDB server URL. Start the server with persistent storage pointing to <workspace>/data/chroma:
//   pip install chromadb
//   chroma run --path <workspace>/data/chroma --host localhost --port 8000
// Then set CHROMA_SERVER_URL if using a non-default host/port.
const CHROMA_SERVER_URL = process.env.CHROMA_SERVER_URL ?? "http://localhost:8000";

let _client: ChromaClient | null = null;

export function getChromaClient(): ChromaClient {
  if (!_client) {
    _client = new ChromaClient({ path: CHROMA_SERVER_URL });
  }
  return _client;
}

export async function getCollection(name: CollectionName): Promise<Collection | null> {
  try {
    const client = getChromaClient();
    const collection = await client.getOrCreateCollection({
      name,
      metadata: {
        description: COLLECTION_DESCRIPTIONS[name],
        created_by: "sign-takeoff-portal",
      },
    });
    return collection;
  } catch (err) {
    logger.warn(
      { err, collection: name, chromaUrl: CHROMA_SERVER_URL },
      "ChromaDB collection unavailable — is the ChromaDB server running?"
    );
    return null;
  }
}

export async function initializeCollections(): Promise<void> {
  logger.info({ chromaUrl: CHROMA_SERVER_URL }, "Initializing ChromaDB collections");
  let successCount = 0;
  for (const name of COLLECTION_NAMES) {
    const col = await getCollection(name);
    if (col) successCount++;
  }
  if (successCount === COLLECTION_NAMES.length) {
    logger.info({ count: successCount }, "All ChromaDB collections initialized");
  } else {
    logger.warn(
      { successCount, total: COLLECTION_NAMES.length },
      "Some ChromaDB collections could not be initialized — RAG features will be limited"
    );
  }
}

export async function checkChromaHealth(): Promise<boolean> {
  try {
    const client = getChromaClient();
    await client.heartbeat();
    return true;
  } catch {
    return false;
  }
}
