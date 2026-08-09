#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MIGRATE=false
FOLLOW_LOGS=false
ACTION=up

usage() {
  cat <<'USAGE'
Usage: ./deploy.sh [options]

Options:
  --migrate    Run Prisma migrations after the container starts.
  --logs       Follow API logs after deployment.
  --down       Stop the backend instead of deploying it.
  -h, --help   Show this help.

Migrations are opt-in because an existing production database may require a
Prisma baseline before `migrate deploy` can be used safely.
USAGE
}

while (($#)); do
  case "$1" in
    --migrate) MIGRATE=true ;;
    --logs) FOLLOW_LOGS=true ;;
    --down) ACTION=down ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || { echo "Docker is required but was not found." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required." >&2; exit 1; }

if [[ "$ACTION" == "down" ]]; then
  docker compose down
  exit 0
fi

if [[ ! -f .env ]]; then
  echo "Missing backend/.env. Copy .env.example to .env and fill in the required secrets." >&2
  exit 1
fi

echo "Building and starting the RIQS backend..."
docker compose up --build -d

if [[ "$MIGRATE" == true ]]; then
  echo "Running Prisma migrations..."
  docker compose run --rm api npx prisma migrate deploy
fi

echo
docker compose ps
echo
echo "Health endpoint: http://localhost:${API_PORT:-5000}/health"

if [[ "$FOLLOW_LOGS" == true ]]; then
  exec docker compose logs -f api
fi
