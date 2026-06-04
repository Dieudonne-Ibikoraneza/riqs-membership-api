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

    console.log('[Cron Jobs] Running annual renewal checks...');
    try {
      // Find all applications approved more than a year ago that haven't been renewed yet.
      // (This is a structural placeholder for the Annual Report generation / notification logic)
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      const dueForRenewal = await prisma.application.findMany({
        where: {
          status: 'Approved',
          approvedAt: { lte: oneYearAgo }
        },
        include: { member: true }
      });

      if (dueForRenewal.length > 0) {
        console.log(`[Cron Jobs] Found ${dueForRenewal.length} members due for annual renewal/reporting.`);
        for (const app of dueForRenewal) {
          // TODO: Send email notification
          // TODO: Generate AnnualReport requirement record
          console.log(`[Cron Jobs] Triggering renewal requirement for member ${app.member.email}`);
        }
      } else {
        console.log('[Cron Jobs] No members due for annual renewal found.');
      }
    } catch (error: any) {
      console.error('[Cron Jobs] Error running annual renewal job:', error.message);
    }
  }, RUN_INTERVAL_MS);
}
