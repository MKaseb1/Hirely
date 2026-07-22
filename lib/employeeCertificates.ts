import { db, inClause } from "./db";
import { embedTexts, EMBEDDING_DIM } from "./embedding";

export async function getEmployeeCombinedCorpusMap(targetEmployeeIds?: number[]): Promise<Record<number, string>> {
  if (targetEmployeeIds && targetEmployeeIds.length === 0) {
    return {};
  }

  const idFilter = targetEmployeeIds ? inClause(targetEmployeeIds) : null;
  const whereClause = idFilter ? `WHERE "employeeId" IN ${idFilter.sql}` : "";
  const params = idFilter ? idFilter.params : [];

  const certificates = db
    .prepare(
      `SELECT "employeeId", "certName", "issuer", "issueDate", "expiryDate" FROM "Certificate" ${whereClause} ORDER BY "employeeId" ASC, "certName" ASC`
    )
    .all(...params) as {
    employeeId: number;
    certName: string;
    issuer: string;
    issueDate: string;
    expiryDate: string | null;
  }[];

  const experiences = db
    .prepare(
      `SELECT "employeeId", "jobTitle", "company", "description" FROM "Experience" ${whereClause} ORDER BY "employeeId" ASC`
    )
    .all(...params) as {
    employeeId: number;
    jobTitle: string;
    company: string;
    description: string | null;
  }[];

  const skills = db
    .prepare(
      `SELECT "employeeId", "category", "name", "proficiency" FROM "Skill" ${whereClause} ORDER BY "employeeId" ASC, "name" ASC`
    )
    .all(...params) as {
    employeeId: number;
    category: string;
    name: string;
    proficiency: number;
  }[];

  const employeeDataMap = new Map<number, { certs: string[]; experiences: string[]; skills: string[] }>();

  const getOrInit = (empId: number) => {
    if (!employeeDataMap.has(empId)) {
      employeeDataMap.set(empId, { certs: [], experiences: [], skills: [] });
    }
    return employeeDataMap.get(empId)!;
  };

  for (const cert of certificates) {
    const parts = [cert.certName, cert.issuer, cert.issueDate, cert.expiryDate]
      .filter((value): value is string => Boolean(value));

    if (parts.length > 0) {
      getOrInit(cert.employeeId).certs.push(parts.join(" - "));
    }
  }

  for (const exp of experiences) {
    const empId = Number(exp.employeeId);
    const parts = [exp.jobTitle, exp.company, exp.description]
      .filter((value): value is string => Boolean(value));

    if (parts.length > 0) {
      getOrInit(empId).experiences.push(parts.join(" - "));
    }
  }

  for (const skill of skills) {
    const empId = Number(skill.employeeId);
    const skillTextParts = [skill.category, skill.name, skill.proficiency ? `proficiency ${skill.proficiency}` : undefined]
      .filter((value): value is string => Boolean(value));

    if (skillTextParts.length > 0) {
      getOrInit(empId).skills.push(skillTextParts.join(" - "));
    }
  }

  const result: Record<number, string> = {};

  for (const [employeeId, data] of Array.from(employeeDataMap.entries())) {
    const summarySegments: string[] = [];

    if (data.certs.length > 0) summarySegments.push(`Certificates: ${data.certs.join(", ")}`);
    if (data.experiences.length > 0) summarySegments.push(`Experience: ${data.experiences.join(", ")}`);
    if (data.skills.length > 0) summarySegments.push(`Skills: ${data.skills.join(", ")}`);

    if (summarySegments.length > 0) {
      result[employeeId] = summarySegments.join(" | ");
    }
  }

  return result;
}

// Called after every employee create/update so the next sync picks up the
// change. UPDATE-first then INSERT pattern works with vec0 virtual tables
// (no ON CONFLICT support). A zero-vector placeholder is used for dirty
// rows — vec0 requires a non-NULL vector on INSERT.
const ZERO_VEC = Buffer.alloc(EMBEDDING_DIM * 4);

export function markEmployeeEmbeddingDirty(employeeId: number): void {
  const updated = db
    .prepare(`UPDATE "EmployeeEmbeddingVec" SET "isdirty" = 1 WHERE employee_id = ?`)
    .run(BigInt(employeeId));
  if (updated.changes === 0) {
    db.prepare(
      `INSERT INTO "EmployeeEmbeddingVec" (employee_id, isdirty, embedding, allexperience) VALUES (?, 1, ?, '')`
    ).run(BigInt(employeeId), ZERO_VEC);
  }
}

export async function populateEmployeeEmbeddingsFromCertificates(): Promise<number> {
  const employeeIds = (db.prepare(`SELECT "id" FROM "Employee" ORDER BY "id" ASC`).all() as { id: number }[]).map((e) => e.id);

  const existingRows = db.prepare(`SELECT "employee_id" FROM "EmployeeEmbeddingVec"`).all() as { employee_id: bigint }[];
  const existingIds = new Set(existingRows.map((row) => Number(row.employee_id)));
  const missingEmployeeIds = employeeIds.filter((employeeId) => !existingIds.has(employeeId));

  if (missingEmployeeIds.length > 0) {
    const insertMissing = db.prepare(
      `INSERT INTO "EmployeeEmbeddingVec" (employee_id, isdirty, embedding, allexperience) VALUES (?, 1, ?, '')`
    );
    for (const employeeId of missingEmployeeIds) {
      insertMissing.run(BigInt(employeeId), ZERO_VEC);
    }
  }

  const allDirtyRecords = db.prepare(`SELECT "employee_id" FROM "EmployeeEmbeddingVec" WHERE "isdirty" = 1`).all() as {
    employee_id: bigint;
  }[];

  const dirtyIds =
    allDirtyRecords.length > 0
      ? allDirtyRecords.map((r) => Number(r.employee_id))
      : employeeIds;

  if (dirtyIds.length === 0) return 0;

  const textMap = await getEmployeeCombinedCorpusMap(dirtyIds);
  let processedCount = 0;

  const updateStmt = db.prepare(
    `UPDATE "EmployeeEmbeddingVec" SET "allexperience" = ?, "embedding" = ?, "isdirty" = 0 WHERE "employee_id" = ?`
  );

  const batchMap: { employeeId: number; text: string }[] = [];
  for (const employeeId of dirtyIds) {
    const text = textMap[employeeId];
    if (!text) {
      updateStmt.run("", ZERO_VEC, BigInt(employeeId));
      continue;
    }
    batchMap.push({ employeeId, text });
  }

  if (batchMap.length === 0) return 0;

  const texts = batchMap.map((e) => e.text);
  const embeddings = await embedTexts(texts);

  for (let i = 0; i < batchMap.length; i++) {
    const { employeeId, text } = batchMap[i];
    const embedding = embeddings[i];
    if (!embedding || embedding.length === 0) continue;
    const vecBuf = Buffer.from(new Float32Array(embedding).buffer);
    updateStmt.run(text, vecBuf, BigInt(employeeId));
    processedCount += 1;
  }

  return processedCount;
}