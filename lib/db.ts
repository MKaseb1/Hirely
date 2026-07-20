// lib/db.ts
//
// Production infra policy disallows an ORM on the server, so this talks to
// the SQLite file directly through better-sqlite3 — no query engine, no
// generated client. Every route/lib file imports `db` from here and writes
// its own SQL.
//
// The prisma/ folder still exists as a LOCAL, DEV-ONLY tool for designing
// schema changes (`prisma migrate dev` generates the next migration.sql) —
// nothing here ever shells out to Prisma, and the CLI/client packages are
// dev-only dependencies, never installed in production.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Sentinel to confirm THIS file is executing, not a stale cached version.
console.log("[db.ts] loaded", Date.now());


function resolveDbPath(): string {
  const url = process.env.DATABASE_URL || "file:./dev.db";
  const filePath = url.replace(/^file:/, "");
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

// Resolve the sqlite-vec native extension path using createRequire, which
// avoids Turbopack's broken import.meta.resolve entirely.
function resolveVecPath(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ext = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
  const pkg = ["sqlite-vec", platform, arch].join("-");
  const vec0 = ["vec0", ext].join("");
  return path.join(process.cwd(), "node_modules", pkg, vec0);
}

// SQLite disables foreign-key enforcement per connection unless told
// otherwise — Prisma's better-sqlite3 adapter never turned this on either,
// so cascade/set-null rules declared in the migrations (e.g.
// SupportRequest.submittedById ON DELETE SET NULL) were never actually
// enforced by the database. Turning it on here doesn't touch existing rows
// retroactively; it only makes future writes honor the constraints the
// schema already declares.
function createConnection(): Database.Database {
  const conn = new Database(resolveDbPath());
  conn.pragma("foreign_keys = ON");
  conn.loadExtension(resolveVecPath());
  applyMigrations(conn);
  return conn;
}

// Applies any prisma/migrations/* folder not yet recorded, in lexical
// (timestamp-prefixed) order, so shipping to prod is just "ship the code"
// — no Prisma CLI on the server.
function applyMigrations(conn: Database.Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS "_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TEXT NOT NULL)`);

  // Bootstrap from the old Prisma migration ledger if this database was
  // originally created by `prisma migrate dev` — those migrations already
  // shaped the tables, so record them here once rather than trying (and
  // failing) to re-run a CREATE TABLE for something that already exists.
  const hasPrismaLedger = conn
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`)
    .get();
  if (hasPrismaLedger) {
    const alreadyApplied = conn
      .prepare(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
      .all() as { migration_name: string }[];
    const seedOne = conn.prepare(`INSERT OR IGNORE INTO "_migrations" ("name", "appliedAt") VALUES (?, ?)`);
    conn.transaction(() => {
      for (const row of alreadyApplied) seedOne.run(row.migration_name, new Date().toISOString());
    })();
  }

  const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
  if (!fs.existsSync(migrationsDir)) return;

  const applied = new Set(
    conn.prepare(`SELECT "name" FROM "_migrations"`).all().map((row) => (row as { name: string }).name)
  );

  const folders = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const folder of folders) {
    if (applied.has(folder)) continue;
    const sqlPath = path.join(migrationsDir, folder, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue;

    const sql = fs.readFileSync(sqlPath, "utf-8");
    const applyOne = conn.transaction(() => {
      conn.exec(sql);
      conn.prepare(`INSERT INTO "_migrations" ("name", "appliedAt") VALUES (?, ?)`).run(folder, new Date().toISOString());
    });
    applyOne();
  }
}

// Hot-reload guard: without it, Next.js dev's module reloads would open a
// new better-sqlite3 handle on every edit and eventually hit
// "database is locked".
const globalForDb = globalThis as unknown as { __db?: Database.Database };

export const db: Database.Database = globalForDb.__db ?? createConnection();
if (process.env.NODE_ENV !== "production") globalForDb.__db = db;

// Turns an array into ("?,?,?", [values]) for a `column IN (...)` clause
// — better-sqlite3 has no array-splat helper.
export function inClause(values: readonly (string | number)[]): { sql: string; params: (string | number)[] } {
  if (values.length === 0) return { sql: "(NULL)", params: [] };
  return { sql: `(${values.map(() => "?").join(",")})`, params: [...values] };
}

// better-sqlite3 transactions are synchronous — this just wraps the
// pattern in a named helper for readability.
export function runInTransaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

export function isUniqueConstraintError(error: unknown, column: string): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message.toLowerCase().includes(column.toLowerCase())
  );
}
