import { closeDb, getDb } from "./db.js";
import { backfillMissingEmbeddings } from "./embedding.js";

function parseBatchSize(raw: string | undefined): number {
  if (!raw) return 100;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.error("Batch size must be a positive integer.");
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const batchSize = parseBatchSize(process.argv[2]);
  const db = getDb();
  const result = await backfillMissingEmbeddings(db, { batchSize });

  console.log(`Embedding backfill complete.`);
  console.log(`scanned=${result.scanned}`);
  console.log(`updated=${result.updated}`);
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
