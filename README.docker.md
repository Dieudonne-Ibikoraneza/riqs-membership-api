# Backend container

The image runs the compiled Node.js API as a non-root user. Database, Supabase,
SMTP, JWT, and other secrets are supplied at runtime through `backend/.env`;
they are intentionally excluded from the Docker build context.

Build and run locally:

```bash
docker compose up --build -d
docker compose ps
curl http://localhost:5000/health
```

The API is exposed on `API_PORT` (default `5000`). The database is external, so
the `DATABASE_URL` in `.env` must be reachable from the container.

Apply Prisma migrations separately before starting production traffic:

```bash
docker compose run --rm api npx prisma migrate deploy
```

For an existing non-empty database that has no Prisma migration history, use
the approved baseline procedure first; do not run `migrate deploy` blindly.
