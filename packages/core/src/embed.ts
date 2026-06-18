import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * Embedding dimensionality of all-MiniLM-L6-v2. Must match the vec0 table width.
 */
export const EMBED_DIM = 384;

/**
 * Default local embedding model. Runs fully on-device via ONNX (transformers.js),
 * no API key, no network after the first download.
 */
export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Point transformers.js at a local cache directory so downloaded models are
 * reused and never leave the machine.
 */
export function configureModelCache(dir: string): void {
  env.cacheDir = dir;
  // We always allow remote download on first run, then cache locally.
  env.allowLocalModels = true;
}

/**
 * Lazily load (and cache) the feature-extraction pipeline. The first call
 * downloads ~30MB; subsequent calls are instant.
 */
export async function getEmbedder(
  model: string = DEFAULT_MODEL,
): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', model);
  }
  return embedderPromise;
}

/**
 * Embed a single string into a normalized 384-dim Float32Array.
 * Mean-pooled + L2-normalized so that L2 distance approximates cosine distance.
 */
export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  // `output.data` may be a typed-array view with a byteOffset / shared buffer;
  // copy into a fresh, contiguous Float32Array so the underlying buffer is
  // exactly EMBED_DIM * 4 bytes (required for the sqlite-vec BLOB binding).
  const data = output.data as ArrayLike<number>;
  if (data.length !== EMBED_DIM) {
    throw new Error(
      `Embedding dim mismatch: got ${data.length}, expected ${EMBED_DIM}`,
    );
  }
  return Float32Array.from(data);
}

/**
 * Convert a Float32 embedding into the raw little-endian byte BLOB that
 * sqlite-vec expects for a `float[N]` column.
 */
export function embeddingToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}
