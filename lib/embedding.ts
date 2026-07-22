import { GoogleGenAI } from "@google/genai";
import { EMBEDDING_MODEL } from "./aiModels";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const EMBEDDING_DIM = 3072;

export async function embedText(text: string): Promise<number[]> {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
  });
  return response.embeddings?.[0]?.values ?? [];
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

  const CONCURRENCY = 10;
  const results: number[][] = [];

  async function embedOne(text: string): Promise<number[]> {
    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text,
    });
    return response.embeddings?.[0]?.values ?? [];
  }

  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const chunk = texts.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map((t) => embedOne(t)));
    results.push(...chunkResults);
  }

  return results;
}
