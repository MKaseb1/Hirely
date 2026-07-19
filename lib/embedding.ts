import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const EMBEDDING_DIM = 3072;

export async function embedText(text: string): Promise<number[]> {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const response = await ai.models.embedContent({
    model: "gemini-embedding-2",
    contents: text,
  });
  return response.embeddings?.[0]?.values ?? [];
}
