# ADR 0001 — The Stdio stack

- **Status:** Accepted
- **Date:** 2026-08-21
- **Issue:** SOL-2
- **Author:** The Founding Engineer

## The decision

Sole confirms the recommended stack. Sole changes three parts. Every choice is below with the
gain and the loss.

## Confirmed

### One TypeScript monorepo

**Choice:** One repository holds the web app, the macOS app and the shared packages.

**Reason:** The web app and the macOS app share the same screens and the same money rules. Two
repositories force a version match between them. One repository removes that work.

### React and Next.js for the web app

**Choice:** Next.js 16.3.1 with the App Router. React 19.2.8.

**Reason:** Next.js gives the server rendering, the routing and the API routes in one tool.
Stdio needs server-side data access for the money paths. A client-only app would put the
pricing logic in the browser. That is not safe.

**The loss:** Next.js ties Stdio to a Vercel-shaped deployment or to a Node server. A pure
static site would be cheaper to host. Stdio needs a server, so this loss does not apply.

### Tauri v2 for the macOS app

**Choice:** Tauri 2.11.4. The shell loads the web app.

**Reason:** Tauri reuses the web code. A Swift app needs a second codebase for every screen.
That doubles the work and it doubles the bugs. Tauri also gives real macOS windows and a small
binary. Electron ships a full Chromium and reaches about 150 MB. Tauri uses the system WebView
and reaches about 10 MB.

**The loss:** Tauri needs a Rust toolchain on the build machine. The WebView is Safari on
macOS, not Chromium. A Safari-only rendering bug will not appear in Chrome during development.
The test plan must include Safari.

### PostgreSQL for the database

**Choice:** PostgreSQL 16 or higher.

**Reason:** Stdio is multi-tenant. Postgres has Row Level Security. That gives a tenant barrier
in the database, below the application code. An application bug then cannot leak one studio's
data to another studio. Postgres also has exact `numeric` and `bigint` types for money.

## Changed from the recommendation

### Change 1 — Drizzle ORM, not Prisma

The recommendation said "a typed migration tool". Sole chooses Drizzle ORM 0.45.2 with
drizzle-kit 0.31.10.

**The gain:** Drizzle generates plain SQL migration files. A human can read them and edit them.
Stdio needs Row Level Security policies and check constraints in the migrations. Prisma hides
the SQL and it does not model RLS. Drizzle also has no separate query engine binary, so the
build stays small and reproducible.

**The loss:** Drizzle has a smaller community than Prisma. Drizzle Studio is weaker than Prisma
Studio. The developer writes more SQL by hand.

### Change 2 — Biome, not ESLint and Prettier

The recommendation did not name a linter. Sole chooses Biome 2.5.9.

**The gain:** One tool does the lint and the format. One configuration file replaces three.
Biome runs the whole repository in under 100 ms. ESLint with Prettier takes several seconds and
needs a plugin to stop the two tools from fighting.

**The loss:** Biome has fewer rules than the full ESLint ecosystem. Stdio loses
`eslint-config-next`, which checks some Next.js patterns. Biome covers the React hook rules and
the accessibility rules. Sole accepts this loss and will add ESLint later only if a real bug
escapes.

### Change 3 — TypeScript 5.9.3, not TypeScript 7

TypeScript 7.0.2 is the current release. Sole pins 5.9.3.

**The gain:** Next.js 16 and drizzle-kit both test against TypeScript 5.9. TypeScript 7 is the
new native compiler. Its tooling support is young. The foundation must be stable.

**The loss:** Stdio gives up the faster compile of TypeScript 7. The typecheck takes about 4
seconds today. That is acceptable. Sole will review this choice when Next.js supports
TypeScript 7 in a stable release.

## The other tools

| Tool             | Version | Reason                                                        |
| ---------------- | ------- | ------------------------------------------------------------- |
| pnpm             | 9.15.4  | A strict `node_modules`. It blocks a phantom dependency.       |
| Turborepo        | 2.10.11 | It runs the tasks in the right order and it caches the result. |
| Vitest           | 4.1.11  | The test runner. It reads TypeScript with no extra setup.      |

Sole pins every version exactly. A caret range makes the build change without a commit.

## The money rule

Every money amount is an integer count of minor units. `packages/core/src/money.ts` holds the
rules and 33 tests cover them.

- The type in TypeScript is `bigint`.
- The column type in Postgres is `bigint`.
- The transport type in JSON is a string, because JSON loses a 64-bit integer.
- A split uses `allocateByRatios`. It gives the remainder to the first shares. The shares always
  add back to the original amount.

This rule serves the priority "Never produce a wrong number on an invoice".

## Open question: the Mac shell

The Tauri configuration points `frontendDist` at `http://localhost:3000` today. That works for
development. It does not work for a shipped application.

The shipped macOS app has two options.

1. **The thin shell.** The app loads the deployed web URL. The app is small. The app needs the
   network at all times.
2. **The bundled shell.** The app ships a static export of the web assets and calls the API over
   the network. The app starts faster. The web app must then support a static export.

SOL-5 must decide this. The decision changes how much of the web app can use server rendering.
The Founding Engineer will raise it to the CEO when the Mac build starts.

## What Sole did not choose

- **Windows and Linux builds.** They are out of scope. The `windows_subsystem` line in
  `main.rs` is a Tauri default. It does not mean Sole supports Windows.
- **A mobile application.** It is out of scope.
- **A paid service.** Nothing in this stack needs a paid plan. The hosting choice comes in SOL-4
  and it needs approval from the CEO.
