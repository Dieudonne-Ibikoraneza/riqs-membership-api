import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Setup Prisma Client with pg adapter
const dbUrl = process.env.DATABASE_URL;
const isLocal = dbUrl?.includes('localhost') || dbUrl?.includes('127.0.0.1');

const pool = new Pool({ 
  connectionString: dbUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});
const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });

// Keep supabaseAdmin export if it's used elsewhere (like file uploads)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
