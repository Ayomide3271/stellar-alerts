# Stellar Alerts: Local Setup & Freelancer Quick Start

This guide provides a comprehensive overview of how to set up Stellar Alerts on your local machine, configure the necessary services, and complete the alert flow as a freelancer. 

## 1. Required Services

To run Stellar Alerts locally, ensure you have the following installed:
- **Node.js** (v18 or higher recommended)
- **Docker** and **Docker Compose** (for PostgreSQL and Redis)
- **Stellar Freighter Wallet** browser extension (for wallet connection)
- **Telegram App** (to receive test alerts)

## 2. Environment Variables

The project uses a monorepo structure. You need to configure environment variables for both the `api` and `web` applications.

### API Environment Variables
Create a file at `apps/api/.env` and populate it with the required keys (you can copy from `apps/api/.env.example`):
```env
DATABASE_URL="postgresql://user:password@localhost:5432/stellar_alerts?schema=public"
REDIS_URL="redis://localhost:6379"
TELEGRAM_BOT_TOKEN="your-telegram-bot-token" # Get this from @BotFather on Telegram
JWT_SECRET="super-secret-jwt-key"
DID_CHALLENGE_TTL_SECONDS="300"
MASTER_ENCRYPTION_KEY="generate-a-random-32+character-secret"
MASTER_ENCRYPTION_KEY_VERSION="1"
MASTER_ENCRYPTION_OLD_KEYS="{}"
```
*(Optional features like Twilio WhatsApp require additional tokens.)*

### Web Environment Variables
Create a file at `apps/web/.env` and populate it with the required keys (you can copy from `apps/web/.env.example`):
```env
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-nextauth-secret
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
NEXT_IGNORE_INCORRECT_LOCKFILE=1
```

## 3. Starting the App

1. **Start Services:** Boot up the PostgreSQL and Redis containers.
   ```bash
   docker compose up -d
   ```
2. **Push Database Schema:** Sync the Prisma schema with the database.
   ```bash
   npm run db:push
   ```
3. **Launch Monorepo:** Start the Fastify API, worker, and Next.js frontend.
   ```bash
   npx turbo dev
   ```

The frontend will be available at `http://localhost:3000` and the API at `http://localhost:3001`.

## 4. Postman Collection

The repository ships a Postman collection covering every Fastify route mounted by `apps/api/src/app.ts` (including its plugins):

- `stellar_alerts.postman_collection.json` (repository root)
- `apps/api/stellar_alerts.postman_collection.json` (identical copy for the API workspace)

### Import and configure

1. Start the API on `http://localhost:3001`.
2. In Postman, choose **Import** and select either collection file.
3. Open the collection variables, set `baseUrl` if your API runs elsewhere, and leave `{{jwtToken}}` empty until you sign in.

### Get a token

Every protected request sends `Authorization: Bearer {{jwtToken}}`.

- **Magic link:** run **Authentication → Magic Link → Request Magic Link**. In development the response includes a `token`; the request's test script saves it as `{{magicToken}}`. Then run **Verify Magic Link**, which saves the session token to `{{jwtToken}}` and the rotating token to `{{refreshToken}}`.
- **SEP-10:** run **Authentication → SEP-10 → Get SEP-10 Challenge**, sign the returned envelope with Freighter (or any Stellar SDK), paste the signed XDR into **Verify SEP-10 Challenge**, and the test script saves the session tokens.

`POST /auth/refresh` rotates the refresh token and updates both collection variables. If you sign in outside Postman, paste the access token directly into `{{jwtToken}}`.

### Variables and request order

- IDs are captured automatically: **Add Wallet** saves `{{walletId}}`, **Create Webhook** saves `{{webhookId}}`, **Create Alert Rule** saves `{{alertRuleId}}`, **Create Export Job** saves `{{exportId}}`, **Analyze Transaction** saves `{{simulationId}}`, and **Generate Telegram Sync Code** saves `{{telegramSyncCode}}`.
- **List** requests also store the first returned id, so a folder can be explored without copy/paste.
- **Get Export Job** splits the signed `download.url` into `{{exportExpires}}` and `{{exportSig}}` for **Download Export File**.
- Wallet cursor status is **Wallets & Ingestion → Get Wallet Ingestion Status** (`GET /wallets/:id/ingestion-status`). Paginated list requests document their `limit`/`cursor` query parameters; set `{{cursor}}` from a response's `pagination.nextCursor`.
- Mutating wallet and webhook requests send an `Idempotency-Key` header of `{{$guid}}` because those routes support replay protection.

### Callbacks that need real provider credentials

These requests intentionally use empty placeholders because the provider generates the signature:

- **Telegram Mini App:** set `{{telegramInitData}}` for the `X-Telegram-Init-Data` header (the value must contain `hash=`).
- **Slack:** `{{slackSignature}}`, `{{slackTimestamp}}`, and `{{slackVerificationToken}}` must match the signed slash-command payload and Slack's 5-minute replay window.
- **Discord:** `{{discordSignature}}` and `{{discordTimestamp}}` must sign the exact raw interaction body. A bare `type: 1` PING with fake headers returns 401 by design.
- **SSE:** `GET /events` holds the connection open, so Postman shows it as pending; this is expected.

### Validate with Postman CLI (Newman)

```bash
# Parse and run a public folder against a running API
npx newman run stellar_alerts.postman_collection.json \
  --folder "Health & Realtime" \
  --env-var baseUrl=http://localhost:3001

# Full collection (requires a signed-in jwtToken and a running API + Postgres + Redis)
npx newman run stellar_alerts.postman_collection.json \
  --env-var baseUrl=http://localhost:3001 \
  --env-var jwtToken="<paste-access-token>"
```

The collection JSON is also validated in CI-friendly form with `node -e "JSON.parse(require('fs').readFileSync('stellar_alerts.postman_collection.json','utf8'))"`.

## 5. Freelancer Alert Quick Start

Follow this flow to connect your wallet, link Telegram, and verify the alerts pipeline.

### Step A: Wallet Connection
1. Navigate to the web app (`http://localhost:3000`).
2. Follow the onboarding wizard or click "Sign In".
3. Use the **Stellar Freighter Wallet** to authenticate via `did:pkh:stellar`. The app securely verifies your public key signature.

### Step B: Telegram Linking
1. In the dashboard, navigate to the **Settings** or **Onboarding** flow.
2. Select **Telegram** as your notification channel.
3. You will be provided with a link to start a conversation with the bot (e.g., `t.me/YourBotName`).
4. Send the verification code or `/start` to the bot to link your account.

### Step C: Test Alerts
1. Register an Alert Rule (e.g., monitor for any incoming payments to your Freighter wallet on Testnet).
2. Use the provided test script to fund the wallet and simulate an incoming transaction:
   ```bash
   npx tsx --env-file=apps/api/.env apps/api/scripts/seed-and-trigger-payment.ts
   ```
3. The ingestion worker will detect the payment and enqueue a job.
4. You should receive a Telegram notification shortly after!

## 6. Troubleshooting

- **Database Errors / "Relation does not exist":** Ensure your Docker container is running and that you've pushed the schema using `npm run db:push`.
- **Wallet Connection Fails:** Ensure the Freighter extension is unlocked and configured to the correct network (Testnet/Mainnet). Check your browser console for `did:pkh:stellar` challenge errors.
- **Alerts Not Delivered:** 
  - Ensure the `TELEGRAM_BOT_TOKEN` is correct.
  - Check the worker terminal output for Redis connection issues or BullMQ errors.
  - Review the Dead-Letter Queue in the dashboard (`/dead-letters`) for terminal delivery failures.
- **Invalid Checksum / Base32 Errors:** The system strictly enforces valid StrKey base32 encoding for all G... public keys. Ensure you are copying the full, correct address.
