import { pipeline, env, type FeatureExtractionPipeline, type Tensor } from "@huggingface/transformers";

env.cacheDir = "data/models";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

export async function embedTextsBGE(texts: string[]): Promise<number[][]> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", "BAAI/bge-base-en-v1.5") as Promise<FeatureExtractionPipeline>;
  }
  const extractor = await extractorPromise;
  const output = await extractor(texts, { pooling: "mean", normalize: true }) as Tensor;
  const dims = output.dims;
  const embDim = dims[dims.length - 1];
  if (dims[0] !== texts.length) {
    throw new Error(
      `BGE output batch size (${dims[0]}) does not match input count (${texts.length})`
    );
  }
  const flat = Array.from(output.data as Float32Array);
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(flat.slice(i * embDim, (i + 1) * embDim));
  }
  return result;
}
