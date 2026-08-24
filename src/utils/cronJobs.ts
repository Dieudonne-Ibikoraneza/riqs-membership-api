import { prisma } from '../config/db';
import cron from 'node-cron';

export function startCronJobs() {
  console.log('[Cron Jobs] Initializing background tasks via node-cron...');

  // 1. Daily Job: Expiration Check for Locked Accounts (Runs every midnight)
  cron.schedule('50 19 * * *', async () => {
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
  });

  // 2. Daily Job: Annual Renewal Checks
  cron.schedule('50 19 * * *', async () => {
    console.log('[Cron Jobs] Running annual renewal checks...');
    try {
      const today = new Date();
      const currentYear = today.getFullYear();
      const thresholdDate = new Date();
      thresholdDate.setDate(today.getDate() + 30); // 30 days ahead

      // Find members expiring within 30 days or already expired
      const eligibleMembers = await prisma.member.findMany({
        where: {
          membershipExpiresAt: {
            lte: thresholdDate,
            not: null
          }
        },
        include: {
          applications: {
            where: { status: 'Approved' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { category: true }
          }
        }
      });

      if (eligibleMembers.length > 0) {
        console.log(`[Cron Jobs] Found ${eligibleMembers.length} members due for annual renewal invoicing.`);
        for (const member of eligibleMembers) {
          const app = member.applications[0];
          
          // Check if an Annual_Renewal transaction exists for this member generated for the upcoming cycle
          // Since billing cycle usually matches the year they are entering
          const targetBillingYear = member.membershipExpiresAt!.getFullYear();
          
          const existingTx = await prisma.financialTransaction.findFirst({
            where: {
              memberId: member.id,
              txType: 'Annual_Renewal',
              status: { in: ['Unpaid', 'Pending_Verification', 'Failed'] }
            }
          });

          // Also check if they already have a cleared transaction recently (in case they paid but expiry didn't bump yet)
          const alreadyPaid = await prisma.financialTransaction.findFirst({
             where: {
               memberId: member.id,
               txType: 'Annual_Renewal',
               status: 'Paid',
               createdAt: { gte: new Date(today.getFullYear(), today.getMonth() - 2, 1) }
             }
          });

          if (!existingTx && !alreadyPaid) {
            let feeAmount = 100;
            let currency = 'USD';
            let appId = undefined;

            if (app && app.category?.annualRenewalFee) {
              feeAmount = Number(app.category.annualRenewalFee);
              currency = app.category.currency || 'RWF';
              appId = app.id;
            } else {
               const isRwandan = member.countryOfOrigin === 'Rwanda';
               feeAmount = isRwandan ? 50000 : 100;
               currency = isRwandan ? 'RWF' : 'USD';
            }

            await prisma.financialTransaction.create({
              data: {
                memberId: member.id,
                applicationId: appId,
                amount: feeAmount,
                currency: currency,
                txType: 'Annual_Renewal',
                paymentMethod: 'Bank_Transfer',
                transactionReference: `RENEW-${member.membershipId || member.id.substring(0, 8)}-${targetBillingYear}`,
                status: 'Unpaid'
              }
            });

            // Send Email Notification
            try {
              const { sendMail } = require('../config/mailer');
              const expiryDateStr = member.membershipExpiresAt
                ? new Date(member.membershipExpiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
                : `31 December ${targetBillingYear}`;
              await sendMail(member.email, 'renewal', {
                name: member.fullName,
                year: targetBillingYear,
                fee: `${currency} ${Number(feeAmount).toLocaleString()}`,
                expiry_date: expiryDateStr
              });
              console.log(`[Cron Jobs] Generated renewal invoice and sent notification to ${member.email}`);
            } catch (err: any) {
               console.error('[Cron Jobs] Failed to send renewal email:', err.message);
            }
          }
        }
      } else {
        console.log('[Cron Jobs] No members due for annual renewal found.');
      }
    } catch (error: any) {
      console.error('[Cron Jobs] Error running annual renewal job:', error.message);
    }
  });

  // 3. Daily Job: 2-Year Mentorship Checks
  cron.schedule('50 19 * * *', async () => {
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
  });
}
