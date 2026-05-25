import { prisma } from './config/db';
import { sendMail } from './config/mailer';

async function testServices() {
  console.log("=== RIQS Core Services Verification Test ===");
  try {
    // 1. Test Database
    console.log("[Test] Testing PostgreSQL Query...");
    const dbRes: any[] = await prisma.$queryRaw`SELECT NOW()`;
    console.log("[Test] Database Ping Success. DB Time:", dbRes[0].now);

    // 2. Test SMTP Mailer
    const testRecipient = 'dieudonneibikoraneza13@gmail.com';
    console.log(`[Test] Dispatching sample rich welcome email to ${testRecipient}...`);
    
    const emailRes = await sendMail(testRecipient, 'welcome', { name: 'Test User' });
    
    console.log("[Test] Nodemailer Dispatch Success! Message ID:", emailRes.messageId);
    console.log("=== ALL CORE SERVICES VERIFIED & ONLINE ===");
    process.exit(0);
  } catch (error) {
    console.error("[Test] Service test failed with fatal error:", error);
    process.exit(1);
  }
}

testServices();
