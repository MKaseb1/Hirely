-- Drop the old EmployeeEmbedding table (stored embeddings as JSON text)
DROP TABLE IF EXISTS "EmployeeEmbedding";

-- Create vec0 virtual table for vector search via sqlite-vec.
-- employee_id: links to Employee.id (handled manually, no FK on virtual tables)
-- isdirty:     1 = needs re-embedding, 0 = up to date
-- embedding:   768-dim float vector with cosine distance metric
-- allexperience: text corpus for BM25 search (auxiliary = not indexed, available in SELECT)
CREATE VIRTUAL TABLE "EmployeeEmbeddingVec" USING vec0(
  employee_id INTEGER PRIMARY KEY,
  isdirty INTEGER,
  embedding FLOAT[768] distance_metric=cosine,
  +allexperience TEXT
);
