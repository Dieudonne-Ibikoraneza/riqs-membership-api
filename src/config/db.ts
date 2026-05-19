import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env variables from .env.local
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const dbUrl = process.env.DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!dbUrl || !supabaseUrl || !supabaseServiceKey) {
  console.error("Critical Error: Missing Database or Supabase configuration keys.");
  process.exit(1);
}

// 1. PostgreSQL Connection Pool (for transactional raw queries, audit trails, and financial ledgers)
export const pool = new Pool({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

// Verify connectivity on bootstrap
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('[Database Pool] Connection Failed:', err.message);
  } else {
    console.log('[Database Pool] Successfully connected to Supabase PostgreSQL cluster.');
  }
});

// 2. Supabase Service-Role Client (handles storage, private files, and auth bypasses backend-side)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
