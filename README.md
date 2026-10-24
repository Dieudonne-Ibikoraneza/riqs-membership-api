# RIQS Membership Backend

Standalone Node.js/Express API for authentication, membership applications, review and approval workflows, mentorship progression, APC assessments, payments, documents, email notifications, and WebSockets.

## Requirements

Node.js 22+, npm 10, a PostgreSQL-compatible database, Supabase credentials for storage, SMTP credentials, and Docker Engine/Compose v2 for container deployment.

## Local setup

```bash
cp .env.example .env
npm ci
npx prisma generate
npm run dev
```

The API defaults to `http://localhost:5000`. Health is `GET /health`; interactive API documentation is at `/api-docs`; API routes are under `/api/v1`.

Configure `PORT`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, and SMTP settings in `.env`. Never commit `.env`, database URLs, service-role keys, JWT secrets, or SMTP passwords.

## SMTP

The backend uses Nodemailer and database-backed email templates. Example settings:

```env
SMTP_HOST=mail.rwandaiqs.org
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=noreply-riqs@rwandaiqs.org
SMTP_PASSWORD="your-password"
SMTP_FROM="RIQS Registry <noreply-riqs@rwandaiqs.org>"
```

Quote passwords containing `#`, `;`, or spaces. SMTP `535` errors indicate rejected credentials or a malformed environment value.

## UrubutoPay setup

Set `URUBUTOPAY_BASE_URL` to the BK-confirmed API base URL (including `/api` for the tested staging gateway, but without `/v2` or `/reference/`). Set `URUBUTOPAY_API_KEY` to the key as issued; outbound requests include the `upg:` prefix. Set `URUBUTOPAY_ENVIRONMENT=testing` to send it in `x-api-key`, or `URUBUTOPAY_ENVIRONMENT=live` to send it in `Authorization`. If omitted, the adapter infers Testing from `staging.urubutopay.rw` and Live from `urubutopay.rw`. Explicit settings that contradict the official gateway hostname are rejected. `NODE_ENV` does not select the payment environment. BK must also identify the `URUBUTOPAY_MERCHANT_CODE` and `URUBUTOPAY_SERVICE_CODE` assigned to your account. The [payment-status reference](https://developers.urubutopay.rw/reference/#/Payments/PaymentController_getPaymentStatus_v2) documents the versioned path; the overview authentication table lists support for each header by environment.

Create strong, unique values for `URUBUTOPAY_WEBHOOK_USERNAME`, `URUBUTOPAY_WEBHOOK_PASSWORD`, and `URUBUTOPAY_WEBHOOK_JWT_SECRET` locally. Share only the webhook username/password and your public callback URLs with BK through an approved secure channel; keep the signing secret private. These are for BK's inbound authentication and callback flow, not additional BK-issued API credentials. Do not use the old `PAYMENT_GATEWAY_*` settings for UrubutoPay. Never commit real key material to this repository.

The adapter uses a 30-second request timeout, normalizes local Rwanda phone numbers, and selects `AIRTEL_MONEY` for 072/073 numbers and `MOMO` for 078/079 numbers. `URUBUTOPAY_WALLET_ACCOUNT_ID` is optional unless your merchant owns multiple wallets. Credentials stay in the backend `.env`.

Run `npm test` and `npm run build` for regression checks. Run the read-only curl smoke checks with:

```bash
npm run payments:check
npm run payments:check -- --transaction <existing-transaction-reference>
```

The script loads `.env` without printing credentials. It checks wallet access and transaction lookup; it never initiates a collection. The adapter supports both documented wallet responses (`status: true`) and staging responses (`status: 200`).

Register these public HTTPS endpoints with UrubutoPay:

- Authentication: `/auth/authenticate` (accepts `user_name` and `password`; returns a 24-hour Bearer JWT).
- Payer validation: `/payer/verify`.
- Payment callback: `/v2/webhook/callback`.

The `/api/v1/payments/callback` alias is also available. Configure URLs in UrubutoPay's merchant onboarding; `PAYMENT_CALLBACK_URL` is a legacy setting and is not sent with initiation. Localhost endpoints cannot receive external callbacks.

The member flows cover Processing Fee, First Year Fee, and Annual Renewal. `INITIATED` and `PENDING` remain `Pending_Verification`; they do not confirm payment. Only a successful payment status clears funds. Annual Renewal then awaits CPD review. Duplicate callbacks after clearance do not issue another receipt. Invoice creation, recurring debit execution, and bulk disbursement APIs are outside these membership payment flows.

On 23 October 2026, a staging curl payment of 5 RWF returned `INITIATED`, followed by `PENDING` on status lookup. Wallet access and the backend database connectivity check passed. This verifies initiation and polling; a completed debit and delivery to a public callback URL require separate verification.

## Build and start

```bash
npm run build
npm start
```

The build generates Prisma Client and compiles TypeScript into `dist/`.

## Prisma and migrations

```bash
npx prisma validate
npx prisma generate
npx prisma migrate deploy
```

An existing database with data but no Prisma migration history must be baselined before `migrate deploy`; otherwise Prisma returns `P3005`. Do not run migrations blindly against production. The reviewer-board migration creates `mentorship_reviews`; old applications may validly have zero rows there.

## Docker deployment

The multi-stage image generates Prisma Client, installs production dependencies, includes OpenSSL, runs as a non-root user, and exposes port 5000. The database and Supabase services are external and are supplied through `.env`.

```bash
./scripts/deploy.sh
./scripts/deploy.sh --pull
./scripts/deploy.sh --logs
./scripts/deploy.sh --migrate
./scripts/deploy.sh --down
```

The migration option is explicit because production databases may require baselining. Equivalent manual commands:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f api
docker compose run --rm api npx prisma migrate deploy
docker compose down
```

`--pull` runs `git pull --ff-only` before the Docker build. It stops when the
checkout has uncommitted or divergent changes, protecting local work. The
backend entrypoint keeps the container immutable; migrations remain explicit.

Set `API_PORT` to change the host port while the container remains on 5000. The `/health` endpoint performs a database ping and is used by the Compose health check.

## Workflow and operations

Route middleware enforces Applicant, Mentor, Reviewer, Head Reviewer, Approver, and Admin permissions. Mentorship upgrades pass through mentor recommendation, reviewer-board reviews, Head Reviewer forwarding, and Admin/Approver final handling. Admin and Approver can schedule and grade APC assessments. Cron jobs and Socket.IO start with the API process; logs go to stdout/stderr.

## Troubleshooting

- Container exits: inspect `docker compose logs api` and required environment variables.
- Health returns 503: verify `DATABASE_URL` and database network access.
- Prisma `P3005`: baseline the existing database.
- Missing `mentorship_reviews`: apply the reviewer-board migration.
- SMTP `535`: verify credentials, host/port, mailbox permissions, and quoted passwords.
- CORS errors: verify the frontend API URL and production CORS policy.

## Repository layout

`src/` contains TypeScript source; `prisma/schema.prisma` and `prisma/migrations/` contain database definitions; `Dockerfile`, `docker-compose.yml`, `scripts/deploy.sh`, and `.env.example` contain deployment/configuration assets.
