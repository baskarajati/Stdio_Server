# ADR 0003 — The homes of the server trees

- **Status:** Accepted
- **Date:** 2026-08-23
- **Issue:** SOL-112
- **Author:** The Backend Engineer

## The decision

Two git repositories hold the Stdio server code.

| Repository | Role |
| ---------- | ---- |
| `baskarajati/Stdio_Server` | The canonical home of the pnpm monorepo: `apps/server`, `packages/core`, `packages/db`. SOL-110 fixed this. |
| `baskarajati/BusinessApp-DS-sol19` | The canonical home of the legacy Next.js server tree. It runs the tax surface today. SOL-112 fixed this. |

The founder chose the second home on SOL-112. The options were a legacy
branch inside `Stdio_Server` or a separate private repository. The separate
repository won because CI runs automatically on a push to `main`, and the
tree stays private. The branch-in-`Stdio_Server` option had no CI for a
non-`main` branch.

## The facts of the new home

- The repository is private. It was created on 2026-08-23.
- The branch `main` carries the full history of the local branch
  `backend/sol-19-contract-expansion`. Its first commit is the SOL-25 tax
  surface HEAD `178ff776`.
- Commit `e5eb8dc7` follows on `main`. It fixes the CI gate only: the bare
  `npx tsc --noEmit` command exhausted the default 2 GB Node heap on the
  runner. The step now runs with `NODE_OPTIONS=--max-old-space-size=4096`,
  matching the local gate.
- CI runs `.github/workflows/ci.yml` on a push or a pull request to `main`:
  `npm ci`, `prisma generate`, `prisma migrate deploy`, `tsc --noEmit`,
  `eslint`, the test suite, and the build.
- Every push to `main` runs the CI gate. The acceptance rule for the tree
  is a green `CI / check` on the latest `main`.
- GitHub-side blocking of direct pushes needs GitHub Pro or an organization
  plan; the account is on GitHub Free. The block is recorded policy today
  (SOL-112), with enforcement as a known follow-up.

## What this ADR does not decide

- The cutover of the tax surface into the `Stdio_Server` monorepo. It
  happens only when the monorepo server implements the tax endpoints and
  the owner approves the cutover.
- The future of `BusinessApp-DS-sol19` after a cutover.
- The deployment target of the legacy tree.
