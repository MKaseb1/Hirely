// POST /api/job-matching/populate
//
// Protected API route that re-embeds ALL dirty/missing employee profiles
// using batched Gemini API calls. Intended to be hit by an external scheduler
// (cron / Windows Task Scheduler / etc.) — not called inline from search.
//
// This is the same logic as scripts/run-embeddings.ts but exposed as a
// secured HTTP endpoint for environments where running a script directly
// is impractical (e.g. serverless platforms that can tsx a route but not a
// standalone process).

import { NextRequest, NextResponse } from "next/server";
import { requireRootUserId } from "@/lib/requireAuth";
import { populateEmployeeEmbeddingsFromCertificates } from "@/lib/employeeCertificates";

export async function POST(request: NextRequest) {
  if (!(await requireRootUserId(request))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const startTime = Date.now();
    const processed = await populateEmployeeEmbeddingsFromCertificates();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[embedding-sync] API sync: ${processed} records in ${elapsed}s`);
    return NextResponse.json({ processed, elapsed });
  } catch (error) {
    console.error("Embedding population error:", error);
    return NextResponse.json(
      { error: "Failed to populate embeddings." },
      { status: 500 }
    );
  }
}
