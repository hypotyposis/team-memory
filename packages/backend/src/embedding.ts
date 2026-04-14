import type Database from "better-sqlite3";

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_API_BASE = "https://api.openai.com/v1";

interface EmbeddingApiResponse {
  data?: Array<{
    index: number;
    embedding: number[];
  }>;
}

function getEmbeddingApiKey(): string | null {
  const value = process.env.EMBEDDING_API_KEY?.trim() ?? process.env.OPENAI_API_KEY?.trim();
  return value ? value : null;
}

function getEmbeddingApiBase(): string {
  const value = process.env.EMBEDDING_API_BASE?.trim() || DEFAULT_EMBEDDING_API_BASE;
  return value.replace(/\/+$/, "");
}

function getEmbeddingModel(): string {
  const value = process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  return value;
}

export function buildKnowledgeEmbeddingText(claim: string, detail?: string | null): string {
  return detail ? `${claim}\n\n${detail}` : claim;
}

export function encodeEmbedding(vector: number[] | Float32Array | null): Buffer | null {
  if (!vector) return null;
  const floatArray = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(floatArray.buffer.slice(floatArray.byteOffset, floatArray.byteOffset + floatArray.byteLength));
}

export async function embedTexts(texts: string[]): Promise<Array<Float32Array | null>> {
  if (texts.length === 0) return [];

  const apiKey = getEmbeddingApiKey();
  if (!apiKey) {
    return texts.map(() => null);
  }

  try {
    const response = await fetch(`${getEmbeddingApiBase()}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getEmbeddingModel(),
        input: texts,
        encoding_format: "float",
      }),
    });

    if (!response.ok) {
      return texts.map(() => null);
    }

    const payload = (await response.json()) as EmbeddingApiResponse;
    const rows = payload.data ?? [];
    const byIndex = new Map(rows.map((row) => [row.index, Float32Array.from(row.embedding)]));
    return texts.map((_, index) => byIndex.get(index) ?? null);
  } catch {
    return texts.map(() => null);
  }
}

export async function embedKnowledgeItem(claim: string, detail?: string | null): Promise<Buffer | null> {
  const [vector] = await embedTexts([buildKnowledgeEmbeddingText(claim, detail)]);
  return encodeEmbedding(vector);
}

export async function backfillMissingEmbeddings(
  db: { prepare: Database.Database["prepare"]; transaction: Database.Database["transaction"] },
  options: { batchSize?: number } = {},
): Promise<{ updated: number; scanned: number }> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const selectMissing = db.prepare(
    "SELECT id, claim, detail FROM knowledge WHERE embedding IS NULL ORDER BY created_at ASC LIMIT ?",
  );
  const updateEmbedding = db.prepare("UPDATE knowledge SET embedding = ?, updated_at = ? WHERE id = ?");

  let scanned = 0;
  let updated = 0;

  while (true) {
    const rows = selectMissing.all(batchSize) as Array<{ id: string; claim: string; detail: string | null }>;
    if (rows.length === 0) {
      break;
    }

    scanned += rows.length;
    const vectors = await embedTexts(rows.map((row) => buildKnowledgeEmbeddingText(row.claim, row.detail)));
    const now = new Date().toISOString();

    db.transaction(() => {
      rows.forEach((row, index) => {
        const encoded = encodeEmbedding(vectors[index] ?? null);
        if (!encoded) return;
        updateEmbedding.run(encoded, now, row.id);
        updated += 1;
      });
    })();

    if (rows.length < batchSize) {
      break;
    }
  }

  return { updated, scanned };
}
