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

    console.log('[Cron Jobs] Running 2-year mentorship completion checks...');
    try {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

      // Graduate members approved 2+ years ago with no passing APC and still Graduate class
      const eligibleForAssociate = await prisma.application.findMany({
        where: {
          status: 'Approved',
          approvedAt: { lte: twoYearsAgo },
          category: { categoryCode: { in: ['GQST', 'GQS'] } },
          member: { membershipClass: 'Graduate' },
          apcAssessments: { none: { status: { in: ['Passed'] } } }
        },
        include: { member: true, category: true }
      });

      if (eligibleForAssociate.length > 0) {
        console.log(`[Cron Jobs] Found ${eligibleForAssociate.length} members eligible for Associate class upgrade.`);
        for (const app of eligibleForAssociate) {
          // Check if we've already sent a notification recently (audit log check)
          const recentNotification = await prisma.auditLog.findFirst({
            where: {
              memberId: app.member.id,
              actionType: 'ASSOCIATE_ELIGIBLE_NOTIFIED',
              createdAt: { gte: new Date(new Date().setMonth(new Date().getMonth() - 1)) }
            }
          });
          if (recentNotification) continue;

          // Log that we sent the notification
          await prisma.auditLog.create({
            data: {
              memberId: app.member.id,
              actionByEmail: 'system@riqs.rw',
              actionType: 'ASSOCIATE_ELIGIBLE_NOTIFIED',
              details: `Member ${app.member.email} has completed 2 years of mentorship and is eligible for Associate class upgrade.`
            }
          });

          // Notify the member
          const { transporter } = require('../config/mailer');
          transporter.sendMail({
            from: `"RIQS Registry Portal" <${process.env.SMTP_USER}>`,
            to: app.member.email,
            subject: 'Your 2-Year Mentorship is Complete — Next Steps',
            html: `
              <div style="font-family: sans-serif; color: #333;">
                <h2>Mentorship Milestone Reached</h2>
                <p>Dear ${app.member.fullName},</p>
                <p>Congratulations! You have successfully completed your 2-year mentorship period as a ${app.category.categoryName}.</p>
                <p>You now have two options for your next step:</p>
                <ol>
                  <li><strong>Request an APC Board:</strong> Sit for the Assessment of Professional Competency to be upgraded to full Technologist or Professional membership.</li>
                  <li><strong>Associate Membership:</strong> The RIQS Secretariat may award you an Associate membership class without requiring the APC. Please contact us at info@riqs.rw.</li>
                </ol>
                <br/><p>Best regards,</p><p>RIQS Registration Board</p>
              </div>
            `
          }).catch((err: any) => console.error('[Cron Jobs] Failed to send 2-year completion email:', err.message));

          console.log(`[Cron Jobs] Sent 2-year completion notification to ${app.member.email}`);
        }
      } else {
        console.log('[Cron Jobs] No members found eligible for Associate class upgrade.');
      }
    } catch (error: any) {
      console.error('[Cron Jobs] Error running 2-year mentorship completion job:', error.message);
    }
  }, RUN_INTERVAL_MS);
}
