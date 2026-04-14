export function decodeEmbedding(buffer: Buffer | Uint8Array | null): Float32Array | null {
  if (!buffer) return null;
  const view = buffer instanceof Buffer ? buffer : Buffer.from(buffer);
  if (view.byteLength === 0 || view.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }

  return new Float32Array(
    view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
  );
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
