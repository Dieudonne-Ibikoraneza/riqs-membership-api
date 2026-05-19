import { pool } from './config/db';
import { sendMail, mailTemplates } from './config/mailer';

async function testServices() {
  console.log("=== RIQS Core Services Verification Test ===");
  try {
    // 1. Test Database
    console.log("[Test] Testing PostgreSQL Pool Query...");
    const dbRes = await pool.query('SELECT NOW()');
    console.log("[Test] Database Ping Success. Supabase Time:", dbRes.rows[0].now);

    // 2. Test SMTP Mailer
    const testRecipient = 'dieudonneibikoraneza13@gmail.com';
    console.log(`[Test] Dispatching sample rich welcome email to ${testRecipient}...`);
    
    const emailRes = await sendMail(
      testRecipient,
      mailTemplates.welcome('Dieudonne Ibikoraneza', 'RIQS-2026-TEST-0420')
    );
    
    console.log("[Test] Nodemailer Dispatch Success! Message ID:", emailRes.messageId);
    console.log("=== ALL CORE SERVICES VERIFIED & ONLINE ===");
    process.exit(0);
  } catch (error) {
    console.error("[Test] Service test failed with fatal error:", error);
    process.exit(1);
  }
}

testServices();
