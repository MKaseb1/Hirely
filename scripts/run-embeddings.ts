// scripts/run-embeddings.ts
//
// Daily-job entry point for re-embedding all dirty/missing employee profiles.
//
// Scheduling (choose one):
//   - Windows Task Scheduler: run `tsx scripts/run-embeddings.ts`
//   - Linux cron: add `0 3 * * * cd /path/to/project && npx tsx scripts/run-embeddings.ts`
//   - Or hit the POST /api/job-matching/populate endpoint via curl/wget from a scheduler
//
// This script processes ALL dirty rows across the entire EmployeeEmbeddingVec
// table, not just candidates from a specific search. Batch API calls are used
// (up to 100 texts per request) instead of one-at-a-time loops.
//
// NOTE: This does NOT run inline during matchTopProfiles — sync-on-read was
// intentionally rejected (see README or the PR description). Dirty/new employees
// will show pendingSyncCount > 0 and score 0 in search results until this
// script runs — that is an accepted tradeoff, not a bug.

import "dotenv/config";
import { populateEmployeeEmbeddingsFromCertificates } from '../lib/employeeCertificates';

async function main() {
  console.log("[embedding-sync] Starting batch embedding sync...");
  const startTime = Date.now();
  try {
    const count = await populateEmployeeEmbeddingsFromCertificates();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[embedding-sync] Done. Processed ${count} dirty/missing records in ${elapsed}s.`);
  } catch (error) {
    console.error("[embedding-sync] Error:", error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();
