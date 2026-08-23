# Stdio

Stdio is a business management application for interior studios and architecture studios.
Sole builds it. The product covers quotes, variation orders, invoices, purchase orders and
timesheets. It reports the budget against the actual cost.

Stdio runs as a web application and as a native macOS application.

## Prerequisites

| Tool       | Version    | Purpose                          |
| ---------- | ---------- | -------------------------------- |
| Node.js    | 20.9 or higher | The web app and the tools    |
| pnpm       | 9.15.4     | The package manager              |
| PostgreSQL | 16 or higher | The database                   |
| Rust       | 1.77.2 or higher | The macOS app only         |
| Xcode      | Latest     | The macOS app only               |

Install pnpm one time with Corepack:

```bash
corepack enable pnpm
```

If `corepack enable pnpm` reports a permission error, install the shim in your home directory:

```bash
corepack enable --install-directory "$HOME/.local/bin" pnpm
```

## The two commands

Install every dependency:

```bash
pnpm install
```

Start the web app on <http://localhost:3000>:

```bash
pnpm dev
```

## Every command

| Command               | Result                                                     |
| --------------------- | ---------------------------------------------------------- |
| `pnpm install`        | Installs every dependency for every package.                |
| `pnpm dev`            | Starts the web app on <http://localhost:3000>.              |
| `pnpm build`          | Builds every package.                                       |
| `pnpm lint`           | Runs the linter and the format check. It changes no file.   |
| `pnpm format`         | Applies the format and the safe lint fixes.                 |
| `pnpm typecheck`      | Checks the types in every package.                          |
| `pnpm test`           | Runs the tests in every package.                            |
| `pnpm verify`         | Runs the lint, the types, the tests and the build in order. |
| `pnpm gate`           | Installs, migrates, seeds, verifies and builds in one command. |
| `pnpm db:generate`    | Writes a new SQL migration from the schema.                 |
| `pnpm db:migrate`     | Applies the migrations to the database.                     |
| `pnpm db:seed`        | Seeds one test studio into the database.                    |
| `pnpm desktop:dev`    | Starts the macOS app. It needs Rust.                        |
| `pnpm desktop:bundle` | Builds the macOS bundle. It needs Rust and Xcode.           |

## The repository layout

```
apps/
  web/        The Next.js web application.
  desktop/    The Tauri v2 shell for macOS.
packages/
  core/       The domain logic. It holds the money rules.
  db/         The Drizzle schema, the client and the migrations.
docs/
  adr/        The architecture decision records.
```

## The server trees

Two repositories hold the server code. ADR 0003 records the full decision.

| Repository | Role |
| ---------- | ---- |
| `baskarajati/Stdio_Server` | This monorepo: `apps/server`, `packages/core`, `packages/db`. The future home of every endpoint. |
| `baskarajati/BusinessApp-DS-sol19` | The legacy Next.js server tree. It runs the tax surface today. Branch `main` is protected and CI-gated. |

Do not copy tax code from one tree into the other without a cutover issue.

## The API contract

The API contract is `contracts/openapi/native-v1.yaml`. It is a verbatim
vendor copy from the `Stdio_Native` repository, branch `origin/main`. The
`Stdio_Native` repository is the source of truth. Do not edit the contract
file in this repository. A contract change lands on `Stdio_Native` first,
then it is vendored into this repository.

## The database

Copy `.env.example` to `.env` and set `DATABASE_URL`.

Run the one-time local bootstrap. It creates the `stdio` role and the
`stdio_dev` database. The `stdio` role is not a superuser: Row-Level Security
does not apply to superusers.

```bash
cp .env.example .env
psql -h localhost -d postgres -f packages/db/scripts/bootstrap-dev.sql
pnpm db:migrate
```

SOL-23 added the multi-tenant schema: studios, clients, projects, quotations,
variation orders, invoices, purchase orders, timesheet entries and their child
rows. Every table carries `studio_id`, and every table is protected by a
Postgres Row-Level Security policy.

Seed one test studio:

```bash
pnpm db:seed
```

## The money rule

Stdio never stores a money amount in a floating point number. A float loses
cents on an invoice. The wire and arithmetic type is an integer count of minor
units. `packages/core/src/money.ts` holds the rules, and
`packages/core/src/money-decimal.ts` holds the conversion to the database
type. The database column type is `numeric(20,2)`. The JSON transport type is
a string.

Read the tests in `packages/core/src/money.test.ts` and
`packages/core/src/money-decimal.test.ts` before you change those files. A
money change needs a test first.

## The stack

Read `docs/adr/0001-stack.md` for the choice and the reason for each part.

## Before you push

```bash
pnpm gate
```

The pipeline runs the same reproducible command. It expects the local database
bootstrap above to have been completed. A red build does not reach the production branch.
