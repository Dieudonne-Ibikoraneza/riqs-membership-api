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
./deploy.sh
./deploy.sh --logs
./deploy.sh --migrate
./deploy.sh --down
```

The migration option is explicit because production databases may require baselining. Equivalent manual commands:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f api
docker compose run --rm api npx prisma migrate deploy
docker compose down
```

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

`src/` contains TypeScript source; `prisma/schema.prisma` and `prisma/migrations/` contain database definitions; `Dockerfile`, `docker-compose.yml`, `deploy.sh`, and `.env.example` contain deployment/configuration assets.
