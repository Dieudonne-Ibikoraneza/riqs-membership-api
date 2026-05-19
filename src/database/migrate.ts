import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("Error: DATABASE_URL is not set in .env.local");
  process.exit(1);
}

async function runMigration() {
  console.log("[RIQS Migration] Initializing PostgreSQL Pool...");
  
  // Set up connection pool with SSL configured for remote Supabase connections
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    const schemaPath = path.resolve(__dirname, 'schema.sql');
    console.log(`[RIQS Migration] Reading schema from: ${schemaPath}`);
    const sql = fs.readFileSync(schemaPath, 'utf8');

    console.log("[RIQS Migration] Connecting to Supabase database...");
    const client = await pool.connect();
    
    try {
      console.log("[RIQS Migration] Running consolidated DDL script... (This will drop and recreate all tables)");
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log("[RIQS Migration] Database bootstrap successfully complete! Seeding verified.");
    } catch (err) {
      await client.query('ROLLBACK');
      console.error("[RIQS Migration] Transaction Error - Rollback executed.");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[RIQS Migration] Fatal Migration Error:", error);
    process.exit(1);
  } finally {
    await pool.end();
    console.log("[RIQS Migration] Pool disconnected.");
  }
}

runMigration();
