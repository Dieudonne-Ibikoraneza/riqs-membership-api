import { prisma } from '../config/db';

const RUN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startCronJobs() {
  console.log('[Cron Jobs] Initializing background tasks...');

  setInterval(async () => {
    console.log('[Cron Jobs] Running expiration check for locked accounts...');
    try {
      const expiredAccounts = await prisma.member.findMany({
        where: {
          isLocked: true,
          lockedUntil: {
            lte: new Date()
          }
        }
      });

      if (expiredAccounts.length > 0) {
        console.log(`[Cron Jobs] Found ${expiredAccounts.length} expired locked accounts to permanently delete.`);
        for (const account of expiredAccounts) {
          await prisma.member.delete({
            where: { id: account.id }
          });
          console.log(`[Cron Jobs] Permanently deleted account ${account.email} (ID: ${account.id})`);
        }
      } else {
        console.log('[Cron Jobs] No expired locked accounts found.');
      }
    } catch (error: any) {
      console.error('[Cron Jobs] Error running account expiration job:', error.message);
    }
  }, RUN_INTERVAL_MS);
}
