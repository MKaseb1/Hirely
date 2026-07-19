# Hirely

An internal HR tool for Elsewedy Electric that validates and manages employee data, and matches existing employees to new job openings before the company hires externally. It's built to visually and structurally match the company's real internal product ("Radar.ai" / Wedy.AI suite) as a design and tech reference — but it's an independent codebase, not an extension of it.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.2 (App Router, Turbopack) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Database | SQLite, accessed directly via `better-sqlite3` — **no ORM at runtime** (see "Database access" below). Prisma stays as a **local, dev-only** tool for designing schema changes and generating migration SQL; it's never imported by application code and isn't a production dependency. Vector search powered by `sqlite-vec` (native extension, auto-loaded by `lib/db.ts`). |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` password hashing, tokens kept in httpOnly cookies |
| Email (OTP delivery) | Gmail SMTP via `nodemailer` |
| AI extraction | Google Gemini (`@google/genai`) — `gemini-flash-latest` for full-record extraction, `gemini-flash-lite-latest` for single-field questions, `gemini-embedding-2` for job-matching embeddings |
| Icons | FontAwesome |
| Chat rendering | `react-markdown` |
| Charts | `recharts` |

> ⚠️ This project runs on a version of Next.js newer than most training data — API conventions (route handler params, dynamic route typing, etc.) may differ from what you'd expect. See `AGENTS.md` for the note about checking `node_modules/next/dist/docs/` before writing routing code.

---

## How the pieces fit together

```
public/Hirely_Landing_Page.html    →  served at "/" via a next.config.ts rewrite; auth-aware (swaps
                                       Sign in/Sign up for app links when a session is already active)
app/login, app/register            →  auth screens (outside the authenticated shell)
app/app/*                          →  everything behind login
  ├─ app/app/page.tsx              →  Dashboard
  ├─ app/app/records/page.tsx      →  Records
  ├─ app/app/chatbot/page.tsx      →  Chatbot
  ├─ app/app/matching/page.tsx     →  Job Matching
  ├─ app/app/admin/page.tsx        →  Root admin console
  ├─ app/app/employee/page.tsx     →  Employee self-service: My Profile
  └─ app/app/employee/assistant/   →  Employee self-service: Assistant (scoped chatbot)
app/api/auth/*                     →  register / verify-code / resend-code / login / refresh / me / magic-login
app/api/chatbot/*                  →  extract / commit / employee/[id] / import-excel
app/api/employee/me                →  the self-service view's own-record fetch (no employeeId param —
                                       always resolves to the caller's own linked record)
app/api/templates/*                →  single-employee / batch — blank Excel template downloads
app/api/export/*                   →  employee/[id] / batch — filled Excel exports
app/api/import/batch/*             →  batch sheet parse+preview / commit
app/api/job-matching/*             →  match / populate (sync embeddings)
app/api/admin/*                    →  approvals/[userId] (promote to admin), support-requests/[id] (root-only)
lib/db.ts                          →  the SQLite connection + migration runner (see below) — the one
                                       thing every other lib/* data-access file imports
lib/embedding.ts                   →  Gemini embedding (gemini-embedding-2, 3072-dim) — used by
                                       job matching and embedding sync
lib/roles.ts                       →  the shared Role = "employee" | "admin" | "root" union type
lib/requireAuth.ts                 →  cookie/JWT auth guards, incl. requireCallerContext (role + linked
                                       employeeId, the primitive every role-aware guard/route is built on)
lib/employees.ts, lib/users.ts,
lib/supportRequests.ts             →  hand-written data-access layer (raw SQL via lib/db.ts)
lib/jobMatching.ts                 →  BM25 + semantic (embedding) hybrid search, RRF-fused
lib/pdfExtract.ts                  →  PDF text extraction (wraps pdf-parse) for job description upload
lib/employeeCertificates.ts        →  builds each employee's text corpus and syncs their embedding
lib/*                              →  everything else — shared business logic (see below)
lib/excelImport/*                  →  Excel parsing, classification, and Excel-generation for import/export
prisma/*                           →  schema.prisma + migrations (dev-only schema design tool) + seed script
context/AuthContext.tsx            →  client-side session state + authFetch
components/employee/*              →  EmployeeSelfServiceView (profile + tabs) and ScopedAssistant (chat)
```

### Data model (`prisma/schema.prisma`)

`schema.prisma` is kept purely as a **local dev tool**: it's how you design a schema change and generate the next migration SQL file with `npx prisma migrate dev`. Nothing in the running app imports the generated Prisma client — see "Database access" below for how the app actually talks to SQLite.

- **`User`** — a login account. Email + hashed password, an OTP verification code + expiry, a hashed refresh token, plus `role` (`"employee"` default | `"admin"` | `"root"`) and a legacy `approved` column (see "Onboarding & roles" below — every account is approved from the moment it exists now, there's no gate left to check).
- **`SupportRequest`** — a message from any logged-in user to the root admin: `type` (issue/request/other), subject, message, `status` (open/resolved). `submittedById` is nullable with `onDelete: SetNull` so a removed account's request history survives; `submittedByEmail` keeps a readable snapshot regardless.
- **`Employee`** — the actual HR record being managed: name, phone, birth date, nationality, marital status, email, work location, gender, national ID, military status — plus (added for Excel import) `companyID`, `hiringDate`, `position`, `age`, `yearsExpPrev`, `yearsExpElsewedy`, `totalExperience`. All optional except `fullName`, since the whole point of this project is tracking *incomplete* profiles. `nationalId` and `companyID` are both nullable-unique. `userId` is a nullable-unique 1:1 link back to the `User` who owns this record (see "Onboarding & roles" below) — `onDelete: SetNull`, so the HR record survives even if the login account is ever removed.
- **`Experience`, `Education`, `Certificate`, `Skill`, `PerformanceReview`** — one-to-many child tables off `Employee`, cascade-deleted with the parent (enforced via `PRAGMA foreign_keys = ON` in `lib/db.ts` — see below). `Certificate.rawText` holds the original Excel source line when a certificate came from import, for admin traceability. `PerformanceReview.score` is stored as a 0–1 fraction (the UI shows/edits it as a 0–100 percentage).
- **`ReviewFlag`** — a value the batch importer couldn't confidently accept and wrote anyway, surfaced on the Dashboard for an admin to fix or consciously accept, rather than silently dropped.
- **`EmployeeEmbeddingVec`** — a `vec0` virtual table (sqlite-vec extension) with one row per employee: `employee_id` (INTEGER PK), `isdirty` (INTEGER, `1` = needs re-embedding, `0` = up to date), `embedding` (`FLOAT[3072]` with cosine distance metric — raw binary BLOB, 12,288 bytes per vector), and `+allexperience` (auxiliary TEXT column holding the concatenated text corpus built from the employee's certificates, experience, and skills). The `embedding` column is stored as raw `Float32` bytes (not JSON text) and is read back via `Buffer` → `Float32Array` reconstruction. Backs the Job Matching feature.

### Database access (raw SQL, no ORM at runtime)

Production infra policy disallows an ORM on the server, so the running app talks to the same SQLite file directly through `better-sqlite3` — the same driver Prisma's adapter used internally anyway, just without the query engine on top.

- **`lib/db.ts`** — opens the SQLite file (`DATABASE_URL`), runs `PRAGMA foreign_keys = ON` (SQLite disables this per-connection by default; without it, `onDelete: Cascade`/`SetNull` are silently unenforced), loads the `sqlite-vec` native extension (`resolveVecPath()` resolves the platform-specific `.dll`/`.so`/`.dylib` from `node_modules/sqlite-vec-<platform>-<arch>/`), and auto-applies any `prisma/migrations/*/migration.sql` not yet recorded in its own `_migrations` tracking table — on an existing database it bootstraps that table from Prisma's own `_prisma_migrations` ledger first. This means **deploying is just "ship the code"** — no `prisma migrate deploy`, no Prisma CLI needed on the server at all. It also exports `inClause(values)` (an `IN (...)` placeholder generator, replacing `Prisma.join`) and `runInTransaction(fn)`.
- **`lib/employees.ts`, `lib/users.ts`, `lib/supportRequests.ts`** — hand-written query/mutation functions per table, following the same pattern as the rest of the codebase: no query-building abstraction, just the specific SQL each caller actually needs. `lib/employees.ts` additionally has `createEmployeeWithRelations`/`updateEmployeeWithRelations`, which replace Prisma's nested `{ create }`/`{ deleteMany, create }` writes with explicit multi-statement transactions.
- Booleans are stored as SQLite `0`/`1` and converted to/from real `boolean`s at the edge (`lib/users.ts`'s `mapUser`); dates are stored as ISO-8601 `TEXT` and converted to/from real `Date` objects the same way.
- A unique-constraint violation surfaces as a `SqliteError` with `code === "SQLITE_CONSTRAINT_UNIQUE"` and a message that already names the column (e.g. `"UNIQUE constraint failed: Employee.companyID"`) — simpler than the old Prisma-era workaround, which had to string-match the whole `meta` blob because the better-sqlite3 adapter left `meta.target` undefined.

**Inspecting the database** (no `@prisma/client` at runtime doesn't mean no tooling):
- **`npx prisma studio`** still works — it's a separate CLI tool that connects straight to the SQLite file via `schema.prisma`'s datasource config, entirely independent of whether application code imports the generated client. This is still the easiest way to browse/edit rows visually.
- For a quick scripted check, `better-sqlite3` is already a project dependency — a one-off Node script is often faster than opening Studio:
  ```bash
  node -e "
  const Database = require('better-sqlite3');
  const db = new Database('dev.db', { readonly: true });
  console.log(db.prepare('SELECT id, fullName, email FROM Employee LIMIT 5').all());
  "
  ```
  (Path is whatever `DATABASE_URL` in `.env` points at — `./dev.db` in local dev. Drop `{ readonly: true }` if you actually need to write.)

### Authentication

`register → (email OTP) → verify-code → login → access token (15m) + refresh token (7d, hashed at rest) → refresh → me`

- Tokens live in httpOnly cookies (access token, 15m, path `/`; refresh token, 7d hashed-at-rest, path `/api/auth`) — never readable by client-side JS, and never held in `AuthContext` state at all.
- `AuthContext.authFetch()` is the client's authenticated fetch wrapper: cookies are attached automatically by the browser, and on a `401` it transparently calls `/api/auth/refresh` and retries once.
- On the server, `lib/requireAuth.ts` exports `requireUserId(request)` (reads the cookie from the raw request) and `requireUserIdFromServerCookies()` (via `next/headers`, for Server Components) — the shared helpers every protected route/page calls before doing anything else.
- Email delivery for the OTP code goes through Gmail SMTP (`lib/mailer.ts`), not a third-party transactional email API — that switch was made because the alternative's free tier only delivers to the account owner's own address.
- Both the Login and Register screens have a "Need help?" link (a real one — see Root admin approval below) that opens the same support-request modal used elsewhere in the app.

### Dashboard

A Server Component (`app/app/page.tsx` + `lib/employeeStats.ts`) that computes live data-completeness statistics straight from the database — nothing is fabricated or mocked. `lib/tabConfig.ts` is the single source of truth for which fields exist and which are required, so the Dashboard, Records, and Chatbot all agree on the same field list.

`components/dashboard/DashboardView.tsx` (client, for the accordion's expand/collapse state) renders:
- **Stat cards** — total employees, overall completion, records needing review.
- **Job Matching** — job openings count, matched %, and employee-profile sync status (`X/Y profiles synced`), with a "Go to Job Matching" link. Openings/matched are placeholders (`0`) until the job-openings feature itself is built.
- **Record status** — a segmented bar splitting employees into complete / needs-review / incomplete, by count of missing basic-info fields.
- **Flagged for review** — real `ReviewFlag` rows the batch importer couldn't confidently accept, each with an Edit link that deep-links straight into that employee's edit form (`/app/records?edit=<id>&flagId=<id>`) and auto-resolves the flag on save.
- **Top issues** — the 5 worst fields across *every* tab (basic info, experience, education, certificates, skills) ranked by gap %, each with a real missing/total count. Clicking one expands and scrolls to that tab in the Tab health overview below.
- **Tab health overview** — an accordion (click a row to expand it in place) with per-tab detail: a missing-field bar chart for Basic Info, coverage + field-completeness for Experience/Education/Certificates, and per-category coverage/average-proficiency for Skills.

### Records

A searchable, paginated table of every employee (`app/app/records/page.tsx` + `components/records/RecordsView.tsx`) with a tabbed detail modal for drilling into one person's full profile — the modal has an "Export to Excel" button (single-employee template, filled). The toolbar also has "Import batch" (see Excel import below), "Export all"/"Export filtered", a free-text search box, and department/gender/nationality filter dropdowns.

### Chatbot — the main body of work so far

Natural-language Create/Update/Read of employee records. **Delete is intentionally not built yet.**

- **`lib/gemini.ts`** — calls Gemini with a structured JSON schema (so the model can't return free-form prose) and a system instruction that scopes it strictly to employee-record CRUD. Two entry points: `extractEmployeeData` (full message, every field) and `extractSingleField` (one field at a time, cheaper model, used during guided data collection).
- **`lib/chatbotResolve.ts`** — figures out *which* employee (if any) a message is about: by numeric ID, by National ID, or by exact name match. Returns a `create` / `update` / `disambiguate` (write) or `found` / `notFound` / `disambiguate` (read) verdict. When a name search turns up more than one person, the UI shows a picker rather than guessing.
- **`lib/chatbotValidate.ts`** — the deterministic layer beneath the LLM. Real structural checks, not just "is this a string": Egyptian mobile phone format, a proper email shape, real calendar dates (including written-out dates like "June 7th, 2000", normalized to `YYYY-MM-DD`), and Egyptian National ID structure (century digit + embedded YYMMDD birth date must be a real date — governorate code and the final checksum digit are deliberately *not* verified, since neither algorithm is confidently known here). This same validation now runs at **both** the extraction step and again immediately before the database write, so bad data can't get in through a request that skips the guided flow.
- **`app/api/chatbot/extract/route.ts`** — two modes: a fresh message (full extraction + resolution), or answering one specific question during guided new-hire data collection (with a "skip" escape hatch per field).
- **`app/api/chatbot/commit/route.ts`** — the *only* place that writes to the `Employee` table, and only after the admin explicitly clicks Confirm in the UI. Also marks the employee's `EmployeeEmbeddingVec` row dirty on every create/update, so Job Matching picks up the change on its next sync.
- **`app/api/chatbot/employee/[id]/route.ts`** — a plain, no-LLM-involved fetch of one employee's full record, used after picking someone from a disambiguation list.
- All chatbot routes require a valid access token (`requireUserId`), and the client sends it via `authFetch`.
- **`components/chatbot/ChatbotView.tsx`** — the UI: welcome screen, avatar/bubble chat layout, a confirmation card per response type (create/update/disambiguate/needs-info/invalid-field/lookup-result/etc.), and a deterministic client-side memory of who was last discussed (`lastEmployee`) so a follow-up like "his phone number" resolves correctly without needing to trust the LLM to infer it from raw history text alone.
- **`EmployeeForm`** has a 5th relation section beyond Experience/Education/Certificates/Skills: **Performance Reviews** (quarter/year/score), editable and reviewable like the others — score is entered/shown as a 0–100% but stored as a 0–1 fraction, converted right before submit.

### Job Matching

Given a free-text job description, ranks existing employees by fit — the long-term goal this whole project was built toward.

- **`lib/employeeCertificates.ts`** — builds each employee's text corpus (certificates + experience + skills, concatenated into one summary string) and, via `populateEmployeeEmbeddingsFromCertificates()`, syncs any employee whose row is missing or flagged `isdirty` — generating a fresh Gemini embedding (`gemini-embedding-2`, 3072 dimensions) only for those, not the whole table every time. Embeddings are stored as raw `Float32` bytes (`Buffer`) in the `EmployeeEmbeddingVec` vec0 virtual table; reading them back reconstructs a `Float32Array` via `Buffer` → `ArrayBuffer` view.
- **`lib/jobMatching.ts`** — hybrid search: a from-scratch BM25Okapi implementation (keyword relevance) combined with cosine similarity over the cached 3072-dim embeddings (semantic relevance), fused via Reciprocal Rank Fusion (RRF). Returns the top N employees (a plain count, not a percentage) — no raw BM25/semantic/RRF scores are surfaced to the UI, just the ranked list. The UI-facing relevance score is derived purely from semantic cosine similarity, scaled up slightly and capped at 0.95 for display as a percentage.
- **`app/api/job-matching/route.ts`** — `POST { jobDescription, topN }`, validates `topN` is a positive integer (rejects `0`, negative, or non-integer values with a 400 — a JS `Array.slice(0, negativeN)` quirk used to make a negative `topN` return almost the entire table instead of erroring).
- **`app/api/job-matching/populate/route.ts`** — triggers the embedding sync on demand (API-only; the UI button was removed — see "Known limitations").
- **`app/api/job-matching/extract-pdf/route.ts`** — accepts a PDF file via FormData, extracts text via `lib/pdfExtract.ts` (wraps `pdf-parse`), returns `{ text }` to pre-fill the job description textarea.
- **`app/app/matching/page.tsx`** + **`components/matching/MatchingView.tsx`** — job description textarea with a "Upload PDF" button (pre-fills from an uploaded PDF), a "Show top N employees" count input, and Find Matches button, results as ranked cards (top 3 visually highlighted).
- **Not yet built**: the actual "job openings" concept (titles, requirements as structured data) — today you paste a description ad hoc each time. Structured/hybrid matching approaches were scoped but deferred; see the git history around the feature's introduction for that design discussion.

### Excel import & export

Two import paths, both landing in `EmployeeForm` (single) or a review table (batch) for the admin to confirm before anything is written — nothing from Excel reaches the database unreviewed.

**Single-employee** — a specially-formatted "Talent Profile" `.xls`/`.xlsx` (one employee per file, not a simple table):
- `lib/excelImport/singleEmployeeParser.ts` — locates every section (basic info, performance appraisal, experience history, training record) **by label text, not fixed row/column position**, so the layout can shift between real files without breaking.
- `lib/excelImport/classifyTraining.ts` — the template's free-text "Training Historical Record" lines (a mix of formal degrees and professional certificates, inconsistently formatted) are classified into `education` vs `certificate` entries via one batched Gemini call.
- `lib/excelImport/mapToFormData.ts` — maps the parsed + classified data into `EmployeeForm`'s pre-fill shape. The template also writes the *first* education entry's field-of-study/year into dedicated "Graduation"/"Graduation year" cells (in addition to that same entry's degree/institution/year appearing as a free-text training line) — this file merges those two readings back into one entry rather than producing two half-blank ones.
- `lib/excelImport/singleEmployeeTemplate.ts` — the reverse direction: an ExcelJS builder that generates either a blank template (styling — grey section headers, bold labels, borders — mirrors the real ElSewedy template) or a filled export for one employee. Exports round-trip cleanly back through the parser for Basic Info, Experience, Education, Certificates, and Performance Reviews.
- **Known gap**: Skills are not part of this template at all — exporting an employee to edit in Excel and re-importing loses their technical/language skills (deferred; the batch template already handles skills correctly, this is single-employee-specific).
- **Chatbot UI**: a paperclip icon + an "Import from Excel" welcome quick-action open a multi-file picker; drag-and-drop across the whole chat panel also works. Each file gets parsed server-side (`POST /api/chatbot/import-excel`), shows live status in a chat card (Parsing… → Ready / error), then successfully-parsed files open `EmployeeForm` one at a time ("Reviewing 2 of 3") — canceling one advances to the next rather than aborting the batch, and a summary message reports the final created/skipped counts.
- Template download: `GET /api/templates/single-employee`. Export: `GET /api/export/employee/[id]` (button in the Records detail modal).

**Batch (tabular)** — one row per employee. Scalar `Employee` fields get one column each; the one-to-many relations (Experience, Education, Certificates, Skills, Performance) get a fixed number of *numbered slot* columns per relation instead of one row per entry (e.g. "Experience 1 - Job Title" … "Experience 2 - Job Title"; performance gets exactly 4 slots, one per quarter). A blank slot is simply skipped:
- `lib/excelImport/batchColumns.ts` — the shared column list AND relation-slot scheme (field ↔ label ↔ type, slot counts per relation), used by the template, parser, and export so all three can't drift apart.
- `lib/excelImport/batchParser.ts` (SheetJS) — reconstructs each relation's numbered slots back into an entry array per row. Reads cells directly via `XLSX.utils.decode_range`/`encode_cell` rather than `sheet_to_json`, because `sheet_to_json`'s date handling was found (during testing) to shift date cells by the system's local UTC offset.
- `lib/excelImport/batchTemplate.ts` (ExcelJS, template/export) — `performanceReviews.score` is shown/entered as a 0–100 percentage in the sheet, converted to the 0–1 fraction the DB stores on both read and write.
- Relation entries are validated with the exact same per-relation validators (`lib/chatbotValidate.ts`'s `RELATION_VALIDATORS`) the chatbot and single-employee flows already use — a bad individual entry drops just that entry (with a warning), it does not invalidate the whole row the way a bad scalar field does.
- A row that collides on a unique field (`nationalId`/`companyID`) has the colliding field stripped and flagged (`ReviewFlag`) rather than failing outright, with a bounded retry since a row can collide on both fields at once.
- **Records UI**: "Import batch" opens a modal — upload → preview table (each row shows Ready or its specific validation error, in-file duplicate National ID/Company ID caught before commit, plus any relation-entry warnings) → select rows → import. A row that fails scalar validation can't be selected; there's no inline cell-editing yet, so a bad row means fix-it-in-the-sheet-and-re-upload. Commit is per-row, so one collision doesn't abort the rest — the response reports created count and per-row failures.
- "Export all" / "Export filtered" (respects the Records search box and the department/gender/nationality filters) download every relation too, via `GET /api/export/batch?search=&department=&gender=&nationality=`. Template: `GET /api/templates/batch`. Parse+preview: `POST /api/import/batch`. Commit: `POST /api/import/batch/commit`.

### Landing page

Static HTML (`public/Hirely_Landing_Page.html`), served at `/` via a Next.js rewrite rather than a React page — animated hero mockup (layered "ghost" cards, a periodic scan-sweep, a looping data-reveal sequence), scroll-triggered reveals, and a barely-there ambient background texture shared visually with the in-app chatbot. On load it calls `/api/auth/me`; if a session is already active it swaps the header/hero Sign in and Sign Up buttons for real links into the app (Dashboard, Records, Chatbot, Job Matching, and Admin if the user is root) plus a single "Go to Dashboard" CTA, instead of showing sign-in prompts to someone who's already signed in.

### Branding & page metadata

`components/shared/Logo.tsx` wraps the Wedy.AI wordmark/mark (`public/images/wedy-mark.png`) at a caller-specified height, used everywhere the app previously showed a `faFire` gradient badge — the sidebar, login/register screens, and the chatbot welcome screen. `app/icon.png` is the app favicon; `public/images/wedy-mark.png` doubles as the landing page's favicon.

Every route sets its own `<title>` via a Metadata export, composed through `app/layout.tsx`'s title template (`"%s · Hirely"`) rather than each page hardcoding the full string: `/login` → "Sign In · Hirely", `/register` → "Create Account · Hirely", `/app` → "Dashboard · Hirely", `/app/records` → "Records · Hirely", `/app/chatbot` → "Chatbot · Hirely", `/app/matching` → "Job Matching · Hirely", `/app/admin` → "Admin · Hirely", `/app/employee` → "My Profile · Hirely".

### Onboarding & roles

Three roles: **`employee`** (the default for every fresh signup), **`admin`** (a promoted employee), **`root`** (the single env-configured superuser). There used to be a fourth implicit state — "registered but pending root approval" — that gated *every* new signup; it's gone. Registering now always produces a fully usable account.

- **Register → OTP → straight into the Employee self-service view.** `app/api/auth/register/route.ts` creates the `User` row **and** a blank, linked `Employee` row in the same transaction (`Employee.userId` → that `User.id`, `fullName: ""`, `email` pre-filled from the account email) — see "Employee self-service view" below. No approval step, no waiting screen: `role: "employee"`, `approved: true` from the moment the row exists (see the migration that changed both column defaults). If the verification email fails to send, both rows are rolled back together, not just the `User` row.
- **The root identity is env-configured, not seeded.** `ADMIN_EMAIL` / `ADMIN_PASS` in `.env` are the only privileged account. `lib/rootAdmin.ts`'s `ensureRootAdminFromEnv()` upserts a `User` row matching those values — `role: "root"`, `approved: true` — every time that email attempts to log in, so rotating the password or changing the email takes effect on the next login attempt with no restart, no seed script, and no direct DB edit. The register route refuses signups for that email (`isRootEmail()`).
- **Becoming an admin is something root does *to* an employee, never something you request at signup** — and it's reversible. `POST /api/admin/approvals/[userId]` promotes an employee to admin; `DELETE` on the same route demotes an admin back to employee. Both are one-way, non-destructive, no confirmation dialog — a demoted admin's linked `Employee` row is untouched, they just lose admin access (and, per the exclusion rule below, reappear in company-wide employee views automatically).
- **Role-based routing.** `lib/requireAuth.ts`'s `requireCallerContext`/`requireCallerContextFromServerCookies` resolve not just "is this a valid login" but the caller's `role` and (for employees) their linked `employeeId` in one call — the shared primitive every guard below is built on. `app/app/layout.tsx`'s client-side effect and each Server Component page (`/app`, `/app/records`) redirect an `employee`-role caller to `/app/employee`, and redirect anyone else away from `/app/employee` back to `/app`. Post-login/register redirects (`app/login/page.tsx`, `app/register/page.tsx`) send an employee straight to `/app/employee` instead of the admin `/app` shell. `Sidebar.tsx` renders a short employee-only nav (My Profile) instead of the full admin one.
- **An admin/root's own linked `Employee` record is excluded from every company-wide employee view** — Records, Dashboard stats, batch export, and Job Matching's candidate pool. Once someone is staff, they're not a tracked HR record to search/page through anymore. This is a live `LEFT JOIN "User" ... WHERE "User"."id" IS NULL OR "User"."role" = 'employee'` condition in `lib/employees.ts`'s `getAllEmployees`/`getFilteredEmployees` and a matching condition in `lib/jobMatching.ts`'s own candidate query — not a stored flag, so demoting an admin makes their record reappear everywhere automatically, no extra bookkeeping. (Single-employee lookup/export by a known id is deliberately left unfiltered — that's not a listing being polluted.)
- **Support request form** — `components/shared/SupportRequestModal.tsx`, submitted through `POST /api/support-requests` (no auth required). Reachable from the sidebar's "Report an issue" item and the Login/Register screens' "Need help?" link.

### Admin console (`/app/admin/*`)

Split into three routes, each independently paginated (client-side, same slice pattern `RecordsView.tsx` already uses) rather than one long-scroll page — `components/admin/AdminSubNav.tsx` renders the tab bar all three share:
- **`/app/admin`** — Promote to Admin: every `role: "employee"` user (`lib/users.ts`'s `findEmployeeUsers()`), one Promote button each.
- **`/app/admin/admins`** — Admins: every `role: "admin"` user (`findAdminUsers()`), one Demote button each.
- **`/app/admin/support-requests`** — every submission, newest-open-first, with type icon (Issue/Request/Other), submitter email, message, and a Mark resolved/Reopen toggle (`PATCH /api/admin/support-requests/[id]`).

Shared building blocks: `components/admin/usePagination.ts` (the slice math), `components/admin/PaginationControls.tsx` (Previous/Next + "Page X of Y"), `components/admin/UserRoleActionList.tsx` (the row markup both role-flip lists share, parameterized by action label/color/icon/handler).

### Employee self-service view

An `employee`-role user's own two pages, both in the Sidebar's employee nav rather than an in-page tab switcher (so navigating between them works the same way it does for every other role): **My Profile** (`/app/employee`, `EmployeeSelfServiceView.tsx`) and **Assistant** (`/app/employee/assistant`, `EmployeeAssistantView.tsx`). Their own HR record, and nothing else — there's no list, search, or pagination here (unlike Records), just one record, fetched via `GET /api/employee/me` rather than any company-wide query. Both pages share `components/employee/useEmployeeProfile.ts`, a hook holding the profile fetch + the edit-form modal's state, since a chat-driven update on the Assistant page opens the exact same modal in place rather than navigating to the profile page first.

- **My Profile** — a read-only summary + an **Edit profile** button that opens `EmployeeForm` (`components/shared/EmployeeForm.tsx`) exactly as-is, reused unmodified from the admin Records flow. Submitting posts to the same `POST /api/chatbot/commit` route Records' edit form uses.
- **The authorization fix that makes this safe**: `commit/route.ts` (and `GET /api/chatbot/employee/[id]`) resolve the caller's role via `requireCallerContext` and, for an `employee`-role caller, **force** `action` to `"update"` and **overwrite** whatever `employeeId` the client sent with the caller's own linked id — never trusting the request body for that role. Without this, any authenticated employee could pass an arbitrary `employeeId` (devtools, curl) and edit someone else's record, since the underlying write functions (`updateEmployeeWithRelations`) have no ownership concept of their own. `admin`/`root` behavior through this same route is completely unchanged.
- **Assistant** — a scoped chatbot (`components/employee/ScopedAssistant.tsx`), visually similar to the admin `ChatbotView.tsx` but a fraction of the size: `app/api/chatbot/extract/route.ts` skips `lib/chatbotResolve.ts` entirely for an employee caller (that module always searches the *whole* `Employee` table by name/ID) and hardcodes resolution to the caller's own record — so there's no disambiguation, no create flow, no Excel import; the only actions it can ever return are `update`, `info`, or `unsupported`.
  - **An `update` extraction is never committed straight from the chat** — it's handed off (`onRequestEdit` prop) to the real `EmployeeForm` modal, pre-filled with the extracted change merged on top of the current profile, so a chat-driven edit goes through the *exact* same full validation (required fields, enum dropdowns, date/format checks) the "Edit profile" button gets, not a lighter server-only check. Relation fields (e.g. "add a certificate for X") are appended onto the employee's existing entries before the form opens — since `EmployeeForm` always saves via a full `replaceRelations: true` resubmit, using the chat's data as-is for a relation key would otherwise wipe out every entry that wasn't just mentioned.
  - **Own system instruction, not the admin's reused verbatim** — `lib/gemini.ts`'s `extractSelfServiceEmployeeData()` (sharing the same schema/model as `extractEmployeeData`, only the system instruction differs) explicitly tells the model it's talking to one specific employee and that first-person phrasing ("do I have any certificates?", "what's my phone number?") is a normal, answerable question about *them* — the admin instruction is written entirely from a third-party-lookup perspective ("is there an employee named X") and has no concept of "I", which used to make first-person questions fall through to a generic "I can only help with..." decline instead of actually being answered.
  - **Explicit scope rejection, not a silent wrong answer** — if a message names a different, specific person (`extracted.identifierHint` doesn't match the caller's own id/name/national ID), `extract/route.ts` returns an explained decline rather than quietly answering about the caller instead. Before this, asking "is there an employee called Mohamed?" while logged in as a different employee returned *that caller's own* profile card with no indication anything was wrong.
  - **Conversation history was a real bug, now fixed** — `ScopedAssistant.tsx` used to send `history: []` on every message (hardcoded, not a deliberate simplification), so the model had zero memory of anything said earlier in the same conversation. It now builds real history from prior turns the same way `ChatbotView.tsx`'s `buildHistory`/`summarizeForHistory` already did.
  - **`info` answers now honor `requestedFields`** — asking about a relation (`certificates`, `experience`, etc.) renders that relation's actual entries, not just the same basic-info card regardless of what was asked (mirrors `ChatbotView.tsx`'s `RelationDetail` rendering, at a smaller scale).
- **Removing one relation entry** (a stale certificate, an old skill) needed **no new backend code** — it already falls out of the edit form's existing replace-all-relations mechanism (`replaceRelations: true`), now reachable by an employee scoped to their own id. Whole-profile self-delete isn't built (by design — out of scope for this feature).
- **Certificate upload** (`components/employee/CertificateUpload.tsx`) — an employee can upload a picture or PDF of a certificate instead of typing it in manually. `POST /api/employee/certificates/upload` (employee-role only, `runtime = "nodejs"`) accepts an `image/*` or `application/pdf` file (10 MB cap), calls `lib/gemini.ts`'s `extractCertificateFromFile()` — the first **multimodal** Gemini call in this codebase (an `inlineData: { mimeType, data: base64 }` part, everywhere else sends text-only `contents`) — to parse `certName`/`issuer`/`issueDate`/`expiryDate`, and saves the original file under a local `data/certificates/<employeeId>/<uuid>-<name>` folder (`.gitignore` already had a bare `data` entry anticipating exactly this; **not** `public/`, since that would make HR documents fetchable by anyone with the URL). The route does **not** write the `Certificate` row itself — it returns the parsed fields for the employee to review/edit (same "AI extracts, human confirms" shape the chatbot and Excel import already use), and the confirm step reuses the existing `POST /api/chatbot/commit` (additive, `replaceRelations: false`). `GET /api/certificates/[certificateId]/attachment` serves the saved file back — employees can only fetch their own, admin/root can fetch any — and Records' certificate detail (`RecordsView.tsx`) shows a "View attachment" link wherever one exists.
  - **A real round-trip bug found and fixed while wiring this up**: `Certificate.attachmentPath` was silently dropped the moment anyone saved through the *generic* `EmployeeForm` (e.g. an admin editing that employee, or the employee using their own "Edit profile" button) — `EmployeeForm`'s relation reader/writer only round-trips fields explicitly listed in its `RELATION_UI` config, and `attachmentPath` wasn't one, so a `replaceRelations: true` save silently orphaned the file from its DB row. Fixed by adding it as a `type: 'hidden'` field (renders nothing, but reads/writes through the form's existing generic loop) plus adding it to `lib/chatbotValidate.ts`'s `RELATION_FIELDS.certificates.optional` list (the validator was building a fresh object from only its known fields and dropping anything else, same root cause).

### Hover / transition polish

Interactive elements across the app (nav links, stat cards, table rows, buttons, filter selects, the batch-import modal) use `transition-colors`/`transition-all` plus a hover state, rather than being static until clicked. Two patterns recur because of two specific gotchas hit while building this:
- **State-driven hover, not Tailwind `hover:`, when an element also has an inline conditional `style`** — React silently reverts DOM mutations on the next render, and Tailwind `hover:` classes lose to an inline `style` prop on the same property. Anywhere background/color already depends on `style={{ ... }}` (the sidebar's active nav link, tab switchers), hover is tracked as component state instead.
- **Hover handlers on a wrapping `<span>`, not directly on `<Link>`**, where `next/link` needs a custom hover effect — `next/link` attaches its own `onMouseEnter` internally for prefetching, which intercepts a handler passed directly to it.

---

## Getting started

```bash
npm install
```

Create a `.env` file with:

| Variable | What it's for |
|---|---|
| `DATABASE_URL` | SQLite connection string, e.g. `file:./dev.db` |
| `JWT_SECRET` | Signs and verifies access/refresh tokens |
| `GEMINI_API_KEY` | Google Gemini API key for chatbot extraction and job-matching embeddings |
| `GMAIL_USER` | The Gmail address OTP emails are sent from |
| `GMAIL_APP_PASSWORD` | A Google Account **App Password** (not your real password) — Google Account → Security → 2-Step Verification → App Passwords |
| `ADMIN_EMAIL` | The root admin's email — the one account that can approve pending admins and triage support requests |
| `ADMIN_PASS` | The root admin's password — re-hashed into the DB on every login attempt for that email, so changing it takes effect immediately |

Then:

```bash
npm run dev                # creates the SQLite file and auto-applies every migration on first run
npx prisma db seed         # optional — load ~20 realistic mock employees (dev-tooling only, no runtime Prisma)
```

`npx prisma migrate dev` is only needed when you're actually changing `prisma/schema.prisma` and want to generate the next migration file — not for a fresh clone, since `npm run dev` applies whatever migrations already exist automatically (see "Database access" above).

Other scripts: `npm run build`, `npm run start`, `npm run lint`.

---

## Known limitations / not yet built

- **Delete** for admins isn't implemented — planned with a soft-delete (`deletedAt`) column and explicit double-confirmation, but deferred until Create/Update/Read are fully solid. (An employee *can* remove a single relation entry — a stale certificate, an old skill — from their own record via the self-service view; see "Employee self-service view" above. There's still no whole-profile delete for anyone.)
- **No password-reset flow** — only register → verify → login → refresh exist.
- **No rate limiting or account lockout** on login attempts or OTP guesses.
- **No audit trail** — nothing records who changed which employee field or when.
- **Chat history isn't persisted** — it's client-side React state; a page refresh loses the conversation (including the `lastEmployee` memory).
- **Relation sub-fields aren't validated** — the experience/education/certificate/skill arrays' own fields (e.g. a job's start/end date) can still reach the database malformed or missing, even though the scalar employee fields are now validated at both the extraction step and the write boundary.
- **Job Matching has no "job openings" concept yet** — a job description is pasted ad hoc each search rather than saved/reused.
- **Single-employee Excel export/import doesn't carry Skills** — a known, deferred gap (batch import/export already handles skills correctly).
- **Batch import has no inline row-editing** — a row that fails validation must be fixed in the source spreadsheet and re-uploaded; the review table can't edit cells directly.
- **Batch import has no volume/pagination handling** — an intentional deferral for very large sheets, revisit if it becomes a real problem.
- **No way to trigger an embedding sync from the UI anymore** — the "Sync Embeddings" button was removed from `components/matching/MatchingView.tsx`; embeddings are now synced via a standalone CLI script (`npx tsx scripts/run-embeddings.ts`) or the `POST /api/job-matching/populate` API route. No cron/scheduled job has been set up yet.

---

## Planned work (next up)

Captured here (rather than only in chat) so a fresh session can pick this up without re-deriving context.

### Done since the last update

- The Employee self-service view + onboarding overhaul (employee-only signups, `User`↔`Employee` link, promote-to-admin) described throughout this README is built, migrated, and verified live — including the authorization fix in `commit`/`employee/[id]` routes and a real spoofed-`employeeId` test confirming it's actually enforced, not just UI-hidden.
- **Demote** (admin → employee) shipped alongside Promote — see "Onboarding & roles" above. The old "root removes a user account" gap is *partially* closed (demote exists now); there's still no way to remove an account entirely, see "Still open" below.
- The admin console was split into three paginated subpages (Promote / Admins / Support Requests) — see "Admin console" above.
- An admin/root's own linked `Employee` record is now excluded from Records, Dashboard, batch export, and Job Matching — verified live (promote → disappears everywhere; demote → reappears everywhere).
- Certificate upload (image/PDF → Gemini-parsed fields + saved file) shipped — see "Employee self-service view" above, including a real `EmployeeForm` round-trip bug it surfaced and fixed (`attachmentPath` was being silently dropped on any generic-form save).

See "Onboarding & roles", "Admin console", and "Employee self-service view" above for the current-state description; this section only tracks what's still open.

### Still open

- **Sync Embeddings automation** — the API route (`POST /api/job-matching/populate`) still exists and works, and a standalone CLI script (`npx tsx scripts/run-embeddings.ts`) replaced the removed UI button. No cron/scheduled job has been set up yet — a new/updated employee's embedding stays stale until someone runs the script by hand. Explicitly deferred (by user decision) until real automation exists — don't just restore the button as a stopgap without also deciding on the automation.
- **Structured Matching's skills/education gap** — `lib/jobMatching.ts`'s `extractJobRequirements()` hard-filters on `nationality`/`gender`/`totalExperience`/`yearsExpElsewedy` before the BM25+embedding rerank, but there's no structured hard-filtering yet on skills, certifications, or education level (degree/field of study) — those were part of the original structured-matching brainstorm but are currently only handled by the free-text BM25+embedding layer. Worth deciding whether to extend the schema, or treat the current four-field version as good enough.
- **Root can't remove a user account entirely** — demote (admin → employee) exists, but there's still no way to delete a `User` row outright (the old hard-delete Decline endpoint was removed along with the pending-approval flow it belonged to). Not requested, not built.
- **Certificate attachments have no delete/replace UI** — an employee can upload a new certificate but can't yet remove an old attachment or its file from disk independently (removing the whole certificate entry via the edit form's replace-all-relations mechanism works, but the orphaned file stays on disk — not cleaned up).
