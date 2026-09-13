import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Setup Prisma Client with pg adapter
const dbUrl = process.env.DATABASE_URL;
// Self-hosted Postgres (see database/ at the repo root) is reached over plain TCP on the
// same server/private network — no TLS needed, unlike the old Supabase connection this
// replaced. `isLocal` here really means "not requiring SSL", covering both the container's
// own 127.0.0.1 and the `host.docker.internal` hostname the backend container uses to reach
// it (see backend/docker-compose.yml's extra_hosts entry).
const isLocal = dbUrl?.includes('localhost') || dbUrl?.includes('127.0.0.1') || dbUrl?.includes('host.docker.internal');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});
const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });
