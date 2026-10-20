# Contributing to Stellar Alerts

Thank you for your interest in contributing to Stellar Alerts! We welcome contributions to help build a seamless, real-time alert and tracking system for freelancers and businesses on the Stellar network.

Please read and follow our [Code of Conduct](../CODE_OF_CONDUCT.md) — by participating in this project you agree to abide by its terms.

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- **Node.js**: v20.0.0 or higher
- **npm**: v9.0.0 or higher
- **Docker**: For running local PostgreSQL 16 & Redis 7 services (`docker compose up -d`)

---

### 2. Installation & Workspace Setup

Clone the repository and install dependencies across all workspaces:

```bash
git clone https://github.com/stellar-alerts-labs/stellar-alerts.git
cd stellar-alerts
npm install
```

---

### 3. Environment Configuration

1. Copy `.env.example` to `apps/api/.env`:
   ```bash
   cp apps/api/.env.example apps/api/.env
   ```
2. Update `apps/api/.env` with your local database URL and JWT secret:
   ```env
   DATABASE_URL="postgresql://postgres:postgrespassword@localhost:5432/stellar_alerts?schema=public&connection_limit=20&pool_timeout=10"
   JWT_SECRET="your-super-secret-jwt-key"
   PORT="3001"
   REDIS_HOST="localhost"
   REDIS_PORT="6379"
   ```

3. Tune the database connection pool through `DATABASE_URL` query parameters:

   | Parameter | Default | Meaning |
   |---|---|---|
   | `connection_limit` | `20` | Maximum connections held open by the pool |
   | `pool_timeout` | `10` | Seconds a query waits for a free connection before failing |
   | `idle_timeout` | `30` | Seconds an unused connection is kept before being released |

   Set `READ_REPLICA_URL` to send read-only queries (wallet and payment
   listings) to a PostgreSQL read replica. Without it those queries run against
   the primary.

---

### 4. Database Setup & Docker Stack

Start local database and Redis services using Docker Compose:

```bash
docker compose up -d
npm run db:push
```

To open Prisma Studio and inspect database records in your browser:

```bash
npm run db:studio
```

---

### 5. Running Tests & Typechecks

CI runs one supported Node version (pinned in [`.nvmrc`](.nvmrc), Node 20) and
typechecks/builds **every** workspace — `apps/api`, `apps/web`,
`packages/shared`, and `packages/cli`. Run the same contract before opening a PR:

```bash
npm run typecheck   # turbo typecheck across all workspaces
npm run build       # turbo build across all workspaces
npm run test:api    # API Vitest suite
npm run test --workspace=web
npm run test --workspace=stellar-alerts-cli
```

To scope a command to a single workspace, use its path:
`npm run typecheck --workspace=apps/web`. See
[`docs/ci.md`](docs/ci.md) for how the CI matrix is wired.

Validate the documented environment variable names and run the focused tests
for the contribution checks with:

```bash
npm run check:env-examples
npm run test:contributor-checks
```

The pre-commit hook runs the environment validation automatically and scans
staged additions for common token, private-key, and sensitive-assignment
formats. You can run the same secret check directly with:

```bash
npm run check:secrets -- --staged
```

The pre-commit entry point is `scripts/scan-staged-secrets.mjs` (also available
as `npm run check:secrets:staged`). It runs before expensive generation and
again after generated files are staged. A failure prints locations and detector
names, never the secret itself. Remove the literal, use an environment variable,
and **stage the corrected file again**; editing only the working tree does not
remove a secret from the index. If it was already shared, revoke/rotate it.

For reviewed, intentionally synthetic fixtures only, `git commit --no-verify`
bypasses local hooks. It does not bypass CI scanning. Prefer constructing fixture
keys from fragments so no complete secret-like value is committed.

Stellar seeds use the base32 pattern `S[A-Z2-7]{55}`; public `G...` keys and
malformed lengths are not flagged. JWT secret/signing-key assignments are checked
even when their literal values contain no digits. Documented placeholders and
environment references remain allowed. This is a focused pattern check, not a
guarantee that arbitrary or obfuscated credentials will be detected.


The secret scanner inspects only added text lines in the staged diff (or in
each commit from the base-to-head range used in CI). It reports the detector
type, file, and line number without printing the matching value. It
intentionally skips existing repository contents, deleted lines, and binary
files, and its focused patterns
do not replace a full secret-management review.

---

### 6. OpenAPI Schema Compatibility

PRs are automatically checked for **breaking OpenAPI schema changes** against
`main` (removed paths/schemas/properties, narrowed responses, newly required
fields, changed types, removed enum values). The
`OpenAPI Breaking-Change Detection` CI job blocks the merge when one is
detected.

Run the same check locally before pushing:

```bash
npm run openapi:check:breaking
```

If your change intentionally breaks the API contract, bump the OpenAPI
`info.version` in `apps/api/src/openapi.config.ts`, run `npm run
generate:types`, commit the regenerated files, and document the migration —
see [docs/openapi-breaking-changes.md](docs/openapi-breaking-changes.md).

---

### 7. Running the Development Application

Launch the full monorepo stack using Turborepo:

```bash
npx turbo dev
```

Or launch components individually from the project root:

| Command | Action |
|---|---|
| `npm run dev:api` | Starts the Fastify API server on http://localhost:3001 |
| `npm run dev:worker` | Starts the Stellar Horizon SSE Ingestion Worker process |
| `npm run dev:web` | Starts the Next.js Frontend Dashboard on http://localhost:3000 |

---

## Production TypeScript `any` Policy

Production TypeScript under `apps/*/src` and `packages/*/src` must not introduce new explicit `any` types or casts. Tests, generated sources, and declaration files are excluded. Existing occurrences are recorded in an owned baseline so they can be removed incrementally without blocking unrelated work.

Run the policy and its focused tests before opening a PR:

```bash
npm run quality:any
npm run test:quality
```

When removing an existing occurrence, run `npm run quality:any:update` and commit the smaller baseline. The update command refuses to expand the baseline. If an exception is unavoidable, run `npm run quality:any` to obtain its fingerprint, then add it to the baseline manually with an accountable owner and a compatibility rationale; reviewers must approve that exception. CI rejects new occurrences, undocumented exceptions, changed fingerprints, and stale allowances.

---

## 🛠️ Development Workflow & Guidelines

1. **Branch Naming**:
   - Features: `feat/feature-name`
   - Bugfixes: `fix/bug-description`
   - Documentation: `docs/topic-name`

2. **Commit Messages**:
   We follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat(api): add notification webhook service`
   - `fix(worker): handle network timeout on horizon query`
   - `docs: update setup guide in CONTRIBUTING.md`

3. **Architecture Decisions (ADRs)**:
   Before changing ingestion, queueing, or notification delivery, read the
   relevant ADR. These record the decision as implemented, the tradeoffs
   accepted, and known gaps between design and code — each claim is cited to a
   `file:line` you can verify.

   | Area | ADR |
   |---|---|
   | Ingestion | [0001 — Horizon paging-token cursors with bounded backfill](docs/adr/0001-horizon-cursor-ingestion.md) |
   | Queueing | [0002 — BullMQ on Redis for the payment-alert queue and DLQ](docs/adr/0002-bullmq-payment-alert-queue.md) |
   | Notification delivery | [0003 — Content-addressed delivery keys and idempotency](docs/adr/0003-notification-delivery-idempotency.md) |

   Index and format: [`docs/adr/README.md`](docs/adr/README.md). If your change
   supersedes a decision, add a new ADR and mark the old one Superseded rather
   than editing its rationale.

4. **Testing with Stellar Testnet**:
   - Always test blockchain operations against **Stellar Testnet**.
   - Fund test public keys using [Stellar Friendbot](https://friendbot.stellar.org).
   - Never use real Stellar mainnet secret keys or funds during development!

---

## 🤝 Submitting Pull Requests

> [!IMPORTANT]
> **Target Branch Policy**: All contributor pull requests must target the `contribution` branch. Direct pull requests targeting `main` are automatically closed by our CI automation. Production releases are merged periodically from `contribution` into `main` by repository maintainers.

1. Branch from `contribution` (`git checkout -b feat/my-feature origin/contribution`).
2. Push your feature branch to your fork.
3. Open a Pull Request targeting **base: `contribution`** (not `main`).
4. Fill out the included [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md).
5. Ensure all automated CI checks pass. Maintainers will review and merge into `contribution`.

---

## 📜 Code of Conduct

This project and everyone participating in it is governed by the [Stellar Alerts Code of Conduct](../CODE_OF_CONDUCT.md). By contributing, you agree to uphold these standards.

To report a violation, please use one of the channels listed in the [Reporting Guidelines](../CODE_OF_CONDUCT.md#reporting-guidelines) section of the Code of Conduct.

---

## 💬 Need Help? Join Community Chat

Have questions or want to discuss an issue before working on it? Join our Telegram maintainers & contributors chat:

👉 **[Join Stellar Alerts Telegram Group](https://t.me/+uElHrnWMb180MWM0)**
