-- Recreate EmployeeEmbeddingVec with 3072-dim vectors for Gemini embedding model.
-- vec0 virtual tables cannot be altered in-place, so drop and recreate.

DROP TABLE IF EXISTS "EmployeeEmbeddingVec";

CREATE VIRTUAL TABLE "EmployeeEmbeddingVec" USING vec0(
  employee_id INTEGER PRIMARY KEY,
  isdirty INTEGER,
  embedding FLOAT[3072] distance_metric=cosine,
  +allexperience TEXT
);
