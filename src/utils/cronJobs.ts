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
      const currentYear = new Date().getFullYear();
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(currentYear - 1);

      const dueForRenewal = await prisma.application.findMany({
        where: {
          status: 'Approved',
          approvedAt: { lte: oneYearAgo }
        },
        include: { member: true, category: true }
      });

      if (dueForRenewal.length > 0) {
        console.log(`[Cron Jobs] Found ${dueForRenewal.length} members due for annual renewal/reporting.`);
        for (const app of dueForRenewal) {
          // Check if an Annual_Renewal transaction exists for this member created in the current year
          const existingTx = await prisma.financialTransaction.findFirst({
            where: {
              memberId: app.member.id,
              txType: 'Annual_Renewal',
              createdAt: {
                gte: new Date(currentYear, 0, 1),
                lt: new Date(currentYear + 1, 0, 1)
              }
            }
          });

          if (!existingTx && app.category?.annualRenewalFee) {
            const feeAmount = app.category.annualRenewalFee;
            const currency = app.category.currency || 'RWF';

            await prisma.financialTransaction.create({
              data: {
                memberId: app.member.id,
                applicationId: app.id,
                amount: feeAmount,
                currency: currency,
                txType: 'Annual_Renewal',
                paymentMethod: 'Bank_Transfer',
                transactionReference: `RENEW-${app.member.membershipId || app.member.id.substring(0, 8)}-${currentYear}`,
                status: 'Unpaid'
              }
            });

            // Send Email Notification
            const { sendMail } = require('./mailer');
            sendMail(app.member.email, 'annual_renewal', {
              name: app.member.fullName,
              year: currentYear,
              fee: `${feeAmount} ${currency}`
            }).catch((err: any) => console.error('[Cron Jobs] Failed to send renewal email:', err.message));

            console.log(`[Cron Jobs] Generated renewal invoice and sent notification to ${app.member.email}`);
          }
        }
      } else {
        console.log('[Cron Jobs] No members due for annual renewal found.');
      }
    } catch (error: any) {
      console.error('[Cron Jobs] Error running annual renewal job:', error.message);
    }
  }, RUN_INTERVAL_MS);
}
