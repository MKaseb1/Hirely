// lib/roles.ts
//
// User.role is stored as a plain TEXT column — SQLite has no enum type —
// so this union is the only thing giving call sites compile-time
// exhaustiveness instead of bare string literals.

export type Role = "employee" | "admin" | "root";
