import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const EMBEDDING_DIM = 3072;

const BATCH_SIZE = 100;

export async function embedText(text: string): Promise<number[]> {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const response = await ai.models.embedContent({
    model: "gemini-embedding-2",
    contents: text,
  });
  return response.embeddings?.[0]?.values ?? [];
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const chunk = texts.slice(i, i + BATCH_SIZE);
    const response = await ai.models.embedContent({
      model: "gemini-embedding-2",
      contents: chunk,
    });
    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== chunk.length) {
      console.warn(
        `[embedTexts] Batch length mismatch in chunk [${i}..${i + chunk.length - 1}]: ` +
        `expected ${chunk.length} embeddings, got ${embeddings.length}. ` +
        `Trailing items will be skipped and remain dirty.`
      );
    }
    for (let j = 0; j < chunk.length; j++) {
      results.push(embeddings[j]?.values ?? []);
    }
  }

  return results;
}
