import { GoogleGenAI } from "@google/genai";

const EMBEDDING_MODEL = "text-embedding-004";

let _client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GOOGLE_AI_API_KEY environment variable is not set.\n" +
        "To generate embeddings, you need a Google AI API key.\n" +
        "Get one at: https://makersuite.google.com/app/apikey\n" +
        "Then set it: export GOOGLE_AI_API_KEY=your_key_here"
      );
    }
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

export async function embedText(text: string): Promise<number[]> {
  const client = getClient();
  const response = await client.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
  });

  const values = response.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error(`Empty embedding returned for text: "${text.slice(0, 50)}..."`);
  }

  return Array.from(values);
}

export async function embedBatch(
  texts: string[],
  batchSize = 10
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(embedText));
    results.push(...batchResults);

    if (i + batchSize < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return results;
}
