import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { ApcStatus, MemberClass } from '@prisma/client';
import { sendRawMail, sendMail } from '../config/mailer';
import { getCertificateCode } from '../utils/membershipUtils';

/**
 * Return the next available membership number for a certificate prefix.
 * Counting rows is unsafe because IDs can have gaps after test data is
 * removed (for example, 0001 and 0003 would make count + 1 collide with
 * 0003). Derive the maximum numeric suffix instead.
 */
export async function nextMembershipId(prefix: string): Promise<string> {
  const members = await prisma.member.findMany({
    where: { membershipId: { startsWith: prefix } },
    select: { membershipId: true }
  });

  let next = members.reduce((max, member) => {
    const match = member.membershipId?.match(/-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;

  let candidate = `${prefix}${String(next).padStart(4, '0')}`;
  while (await prisma.member.findUnique({ where: { membershipId: candidate } })) {
    next += 1;
    candidate = `${prefix}${String(next).padStart(4, '0')}`;
  }
  return candidate;
}

// 1. Fetch APC assessment tracking records
export async function getAPCStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  try {
    const assessments = await prisma.apcAssessment.findMany({
      where: { memberId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });

    return res.status(200).json({ assessments });
  } catch (error: any) {
    console.error('[Get APC Status] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching APC progression records.' });
  }
}

// 2. Request APC Upgrade (Graduate marks themselves ready)
export async function requestAPC(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    // Find the most recent approved application that does NOT already have a finalised APC
    const app = await prisma.application.findFirst({
      where: {
        memberId: req.user.id,
        status: 'Approved',
        mentorshipAssignment: {
          status: 'Approved',
          mentorRecommended: true
        },
        apcAssessments: {
          none: { status: { in: ['Passed', 'Failed', 'No_Show'] } }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!app) {
      return res.status(404).json({ error: 'No approved mentorship upgrade is ready for APC. The assigned mentor, reviewer board, and approver must complete their steps first.' });
    }

    const existing = await prisma.apcAssessment.findFirst({
      where: { applicationId: app.id, status: { in: ['Requested', 'Scheduled'] } }
    });

    if (existing) {
      return res.status(400).json({ error: 'You already have an APC board requested or scheduled for this application.' });
    }

    const assessment = await prisma.apcAssessment.create({
      data: {
        memberId: req.user.id,
        applicationId: app.id,
        status: 'Requested'
      }
    });

    return res.status(201).json({ message: 'APC Upgrade requested successfully.', assessment });
  } catch (error: any) {
    console.error('[Request APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error requesting APC.' });
  }
}

// 3. Schedule APC Assessment (Registers graduates for examinations)
function parseAssessmentPeriod(periodStr?: string): Date | null {
  if (!periodStr) return null;
  const match = periodStr.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (month < 1 || month > 12) return null;
  return new Date(`${match[1]}-${match[2]}-01T00:00:00.000Z`);
}

function formatAssessmentPeriod(periodStart: Date, periodEnd: Date | null): string {
  const startMonth = periodStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (periodEnd) {
    const endMonth = periodEnd.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `${startMonth} – ${endMonth}`;
  }
  return startMonth;
}

export async function registerAPC(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId, assessmentPeriodStart, assessmentPeriodEnd } = req.body;

  if (!applicationId || !assessmentPeriodStart) {
    return res.status(400).json({ error: 'Missing required parameters: applicationId and assessmentPeriodStart.' });
  }

  const periodStart = parseAssessmentPeriod(assessmentPeriodStart);
  const periodEnd = assessmentPeriodEnd ? parseAssessmentPeriod(assessmentPeriodEnd) : null;

  if (!periodStart || (assessmentPeriodEnd && !periodEnd)) {
    return res.status(400).json({ error: 'Invalid period format. Use YYYY-MM.' });
  }
  if (periodEnd && periodEnd < periodStart) {
    return res.status(400).json({ error: 'Period end cannot be before period start.' });
  }

  try {
    const app = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!app) return res.status(404).json({ error: 'Application not found.' });

    const existingReq = await prisma.apcAssessment.findFirst({
      where: { applicationId, status: 'Requested' }
    });

    let assessment;
    if (existingReq) {
      assessment = await prisma.apcAssessment.update({
        where: { id: existingReq.id },
        data: {
          assessmentPeriodStart: periodStart,
          assessmentPeriodEnd: periodEnd,
          status: 'Scheduled',
          updatedAt: new Date()
        }
      });
    } else {
      assessment = await prisma.apcAssessment.create({
        data: {
          memberId: app.memberId,
          applicationId,
          assessmentPeriodStart: periodStart,
          assessmentPeriodEnd: periodEnd,
          status: 'Scheduled'
        }
      });
    }

    const member = await prisma.member.findUnique({ where: { id: app.memberId } });
    if (member) {
      sendMail(member.email, 'apc_scheduled', {
        name: member.fullName,
        date: formatAssessmentPeriod(periodStart, periodEnd)
      }).catch(console.error);
    }

    return res.status(201).json({
      message: 'Assessment of Professional Competency (APC) board successfully scheduled.',
      assessment
    });
  } catch (error: any) {
    console.error('[Register APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error scheduling APC board.' });
  }
}

// Shared by gradeAPC (to preview what a Pass would mean) and approveAPCGrade (to actually
// apply it) — resolves the new MemberClass/certificate code/target category for a Pass.
function resolveApcUpgradeTarget(categoryCode: string): { newClass: MemberClass; newCertCode: string; targetCategoryCode: string | null } {
  // Route 1 (GrQST, AsQST) → Technologist, Route 2+ (GrQS, AsQS, PrQS, F-PrQS) → Professional
  const newClass: MemberClass = ['GrQS', 'PrQS', 'F-PrQS', 'AsQS'].includes(categoryCode) ? 'Professional' : 'Technologist';
  const newCertCode = newClass === 'Technologist' ? 'TechQS' : 'PrQS';

  let targetCategoryCode: string | null = categoryCode;
  if (['GrQST', 'AsQST'].includes(categoryCode)) targetCategoryCode = 'TcQS';
  else if (['GrQS', 'AsQS'].includes(categoryCode)) targetCategoryCode = 'PrQS';
  if (targetCategoryCode === categoryCode) targetCategoryCode = null; // no actual category change

  return { newClass, newCertCode, targetCategoryCode };
}

// 3. Grade APC Assessment — Step 1 of 2. An Admin Assistant (or Admin/Approver) stages a
// grade here; nothing about the member's class, fees, or inbox changes yet. The grade sits as
// `Pending_Approval` until an Admin/Approver calls approveAPCGrade below to confirm or reject
// it — that's the only point at which the upgrade fee is invoiced and the results email goes
// out, mirroring the existing Reviewer→Approver staging used for full applications.
export async function gradeAPC(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { assessmentId, status, scorePercentage, assessmentNotes, stampFeePaid, licenseIssued } = req.body;

  if (!assessmentId || !status) {
    return res.status(400).json({ error: 'Missing assessmentId or status.' });
  }

  const validStatuses = ['Attended', 'Passed', 'Failed', 'No_Show'];
  let mappedStatus = status;
  if (status === 'No Show') mappedStatus = 'No_Show';

  if (!validStatuses.includes(mappedStatus)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: Attended, Passed, Failed, No Show` });
  }

  try {
    const apc = await prisma.apcAssessment.findUnique({ where: { id: assessmentId } });
    if (!apc) return res.status(404).json({ error: 'APC assessment not found.' });

    if (apc.status === 'Pending_Approval') {
      return res.status(409).json({ error: 'This assessment already has a grade awaiting Admin/Approver confirmation.' });
    }

    const updatedApc = await prisma.$transaction(async (tx) => {
      const updated = await tx.apcAssessment.update({
        where: { id: assessmentId },
        data: {
          preApprovalStatus: apc.status,
          status: 'Pending_Approval',
          proposedStatus: mappedStatus as ApcStatus,
          proposedScorePercentage: scorePercentage || null,
          proposedAssessmentNotes: assessmentNotes || null,
          proposedStampFeePaid: stampFeePaid || false,
          proposedLicenseIssued: licenseIssued || false,
          gradedByEmail: req.user!.email,
          gradedAt: new Date(),
          approvedByEmail: null,
          approvedAt: null,
          gradingRejectionReason: null,
          updatedAt: new Date()
        }
      });
      await tx.auditLog.create({
        data: {
          memberId: apc.memberId,
          actionByEmail: req.user!.email,
          actionType: 'APC_GRADED_PENDING_APPROVAL',
          details: `APC ${assessmentId} graded as ${status} (score: ${scorePercentage || 'N/A'}%) by ${req.user!.email} — awaiting Admin/Approver confirmation before it takes effect.`
        }
      });
      return updated;
    });

    return res.status(200).json({ message: `Grade submitted — awaiting Admin/Approver confirmation.`, assessment: updatedApc });
  } catch (error: any) {
    console.error('[Grade APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error grading APC assessment.' });
  }
}

// 3b. Confirm or reject a staged APC grade — Step 2 of 2 (Admin/Approver only). Approving
// applies the exact same class-upgrade/fee/email logic the old single-step gradeAPC used to
// run inline; rejecting just discards the staged grade and reverts to whatever the assessment's
// status was before grading, so it can be re-graded.
export async function approveAPCGrade(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { assessmentId, decision, rejectionReason } = req.body;
  if (!assessmentId || !['Approve', 'Reject'].includes(decision)) {
    return res.status(400).json({ error: 'Missing assessmentId or invalid decision (must be Approve or Reject).' });
  }

  try {
    const apc = await prisma.apcAssessment.findUnique({
      where: { id: assessmentId },
      include: {
        application: { include: { category: { select: { categoryCode: true, categoryName: true, stampFee: true, currency: true } } } },
        member: true
      }
    });

    if (!apc) return res.status(404).json({ error: 'APC assessment not found.' });
    if (apc.status !== 'Pending_Approval') {
      return res.status(409).json({ error: 'This assessment has no grade currently awaiting confirmation.' });
    }

    const mappedStatus = apc.proposedStatus as ApcStatus;

    if (decision === 'Reject') {
      const reverted = await prisma.$transaction(async (tx) => {
        const updated = await tx.apcAssessment.update({
          where: { id: assessmentId },
          data: {
            status: apc.preApprovalStatus || 'Scheduled',
            proposedStatus: null,
            proposedScorePercentage: null,
            proposedAssessmentNotes: null,
            proposedStampFeePaid: null,
            proposedLicenseIssued: null,
            gradingRejectionReason: rejectionReason || null,
            updatedAt: new Date()
          }
        });
        await tx.auditLog.create({
          data: {
            memberId: apc.memberId,
            actionByEmail: req.user!.email,
            actionType: 'APC_GRADING_REJECTED',
            details: `Grade of "${apc.proposedStatus}" (staged by ${apc.gradedByEmail}) for APC ${assessmentId} was rejected by ${req.user!.email}.${rejectionReason ? ` Reason: ${rejectionReason}` : ''}`
          }
        });
        return updated;
      });
      return res.status(200).json({ message: 'Grade rejected — sent back for re-grading.', assessment: reverted });
    }

    // decision === 'Approve'
    let newClass: MemberClass | undefined = undefined;
    let newCertCode: string | undefined = undefined;
    let targetCategory: any = null;

    if (mappedStatus === 'Passed') {
      const code = apc.application.category.categoryCode;
      const resolved = resolveApcUpgradeTarget(code);
      newClass = resolved.newClass;
      newCertCode = resolved.newCertCode;
      if (resolved.targetCategoryCode) {
        targetCategory = await prisma.membershipCategory.findFirst({
          where: { categoryCode: resolved.targetCategoryCode, entityType: 'Individual' }
        });
      }
    }

    const transactions: any[] = [
      prisma.apcAssessment.update({
        where: { id: assessmentId },
        data: {
          status: mappedStatus,
          scorePercentage: apc.proposedScorePercentage,
          assessmentNotes: apc.proposedAssessmentNotes,
          stampFeePaid: apc.proposedStampFeePaid || false,
          licenseIssued: apc.proposedLicenseIssued || false,
          proposedStatus: null,
          proposedScorePercentage: null,
          proposedAssessmentNotes: null,
          proposedStampFeePaid: null,
          proposedLicenseIssued: null,
          approvedByEmail: req.user.email,
          approvedAt: new Date(),
          updatedAt: new Date()
        }
      }),
      prisma.auditLog.create({
        data: {
          memberId: apc.memberId,
          actionByEmail: req.user.email,
          actionType: 'APC_APPROVED',
          details: `APC ${assessmentId} grade of "${mappedStatus}" (staged by ${apc.gradedByEmail}) confirmed by ${req.user.email}. Score: ${apc.proposedScorePercentage || 'N/A'}%`
        }
      })
    ];

    // Rather than upgrading the member immediately, hold the upgrade pending payment of the
    // new category's first-year fee. The membershipClass and membershipId are only applied
    // once that fee's FinancialTransaction is cleared (see verifyPayment in
    // paymentController.ts). Passing the APC no longer grants the Mentor role by itself —
    // members now either apply for it (mentorApplicationController.requestMentorStatus) or an
    // Admin/Approver promotes them directly from their profile.
    if (newClass && targetCategory) {
      const transactionReference = `UPG-${apc.applicationId.slice(0, 8)}-${Date.now()}`;

      transactions.push(
        prisma.application.update({
          where: { id: apc.applicationId },
          data: {
            pendingUpgradeClass: newClass,
            pendingUpgradeCategoryId: targetCategory.id,
            pendingUpgradeCertCode: newCertCode
          }
        })
      );

      if (targetCategory.firstYearFee && Number(targetCategory.firstYearFee) > 0) {
        transactions.push(
          prisma.financialTransaction.create({
            data: {
              memberId: apc.memberId,
              applicationId: apc.applicationId,
              amount: targetCategory.firstYearFee,
              currency: targetCategory.currency || 'RWF',
              txType: 'First_Year_Fee',
              paymentMethod: 'Bank_Transfer',
              transactionReference,
              status: 'Unpaid'
            }
          })
        );
      }

      transactions.push(
        prisma.auditLog.create({
          data: {
            memberId: apc.memberId,
            actionByEmail: req.user.email,
            actionType: 'APC_UPGRADE_PENDING_PAYMENT',
            details: `APC passed. Upgrade to ${newClass} (${targetCategory.categoryName}) approved, pending payment of the first-year fee before the new membership ID is issued.`
          }
        })
      );
    }

    const [updatedApc] = await prisma.$transaction(transactions);

    // Send email notification only now that the result is final and confirmed.
    if (['Passed', 'Failed'].includes(mappedStatus) && apc.member?.email) {
      const emailSubject = `APC Assessment Result: ${mappedStatus}`;
      const feeLine = newClass && targetCategory && targetCategory.firstYearFee && Number(targetCategory.firstYearFee) > 0
        ? `<p><strong>First-year fee due:</strong> ${Number(targetCategory.firstYearFee).toLocaleString()} ${targetCategory.currency || 'RWF'}</p>`
        : '';
      const emailBody = `
        <div style="font-family: sans-serif; color: #333;">
          <h2>APC Assessment Results Published</h2>
          <p>Dear ${apc.member.fullName},</p>
          <p>The results for your recent APC board assessment have been finalized and confirmed.</p>
          <p><strong>Final Outcome:</strong> ${mappedStatus}</p>
          ${apc.proposedScorePercentage ? `<p><strong>Score:</strong> ${apc.proposedScorePercentage}%</p>` : ''}
          ${newClass && targetCategory ? `<p style="color: #059669; font-weight: bold;">Congratulations! You have been approved for an upgrade to ${newClass} (${targetCategory.categoryName}).</p>${feeLine}<p>To be recognized under this new class and receive your new membership ID and credentials, please log in to your RIQS dashboard Payments page and pay the first-year membership fee above. Your new membership ID and the benefits of this class will be issued once payment is verified.</p>` : ''}
          <p>Please log in to your RIQS dashboard to view any specific feedback or notes from your examiners.</p>
          <br/>
          <p>Best regards,</p>
          <p>RIQS Registration Board</p>
        </div>
      `;

      sendRawMail({
        to: apc.member.email,
        subject: emailSubject,
        html: emailBody
      }).catch((err: any) => {
        console.error("[Approve APC Grade] Failed to send email:", err.message);
        // A failed send here otherwise vanishes into the server console — record it so a
        // "the member says they never got the email" report can be confirmed from data
        // instead of re-checking SMTP logs after the fact.
        prisma.auditLog.create({
          data: {
            memberId: apc.memberId,
            actionByEmail: 'system@riqs.rw',
            actionType: 'EMAIL_SEND_FAILED',
            details: `Failed to send "${emailSubject}" to ${apc.member.email}: ${err.message}`
          }
        }).catch(() => {});
      });
    }

    return res.status(200).json({ message: `APC assessment confirmed: ${mappedStatus}.`, assessment: updatedApc });
  } catch (error: any) {
    console.error('[Approve APC Grade] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error confirming APC assessment grade.' });
  }
}

// 4. Award Associate Class — Admin awards Associate membership after 2-year mentorship (no APC required)
export async function awardAssociate(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId } = req.body;
  if (!applicationId) return res.status(400).json({ error: 'Missing applicationId.' });

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        member: true,
        category: { select: { categoryCode: true, categoryName: true } }
      }
    });

    if (!app) return res.status(404).json({ error: 'Application not found.' });
    if (app.status !== 'Approved') return res.status(400).json({ error: 'Application must be Approved to award Associate class.' });

    const code = app.category.categoryCode;
    // Route 1 (GradQST) → Associate QS Technologist (AsQST)
    // Route 2 (GradQS)  → Associate Quantity Surveyor (AsQS)
    let targetCode: string;
    let newClass: MemberClass;
    // The seeded graduate routes use the `Gr*` category codes. Keep the
    // legacy `Grad*` aliases supported for older applications as well.
    if (['GrQST', 'GradQST'].includes(code)) { targetCode = 'AsQST'; newClass = 'Associate'; }
    else if (['GrQS', 'GradQS'].includes(code)) { targetCode = 'AsQS'; newClass = 'Associate'; }
    else return res.status(400).json({ error: `Associate class is only applicable to Route 1 (GradQST) or Route 2 (GradQS). Current category: ${code}` });

    const targetCategory = await prisma.membershipCategory.findFirst({
      where: { categoryCode: targetCode, entityType: 'Individual' }
    });
    if (!targetCategory) return res.status(500).json({ error: `Associate category (${targetCode}) not found in database. Please re-run seed.` });

    // Rather than upgrading the member immediately, hold the upgrade pending
    // payment of the Associate category's first-year fee. The membershipClass
    // and membershipId are only applied once that fee's FinancialTransaction is
    // cleared (see verifyPayment in paymentController.ts).
    const transactionReference = `UPG-${applicationId.slice(0, 8)}-${Date.now()}`;

    const upgradeOps: any[] = [
      prisma.application.update({
        where: { id: applicationId },
        data: {
          pendingUpgradeClass: newClass,
          pendingUpgradeCategoryId: targetCategory.id,
          pendingUpgradeCertCode: targetCode,
          pendingUpgradePromoteToMentor: false
        }
      }),
      prisma.auditLog.create({
        data: {
          memberId: app.memberId,
          actionByEmail: req.user.email,
          actionType: 'ASSOCIATE_AWARD_PENDING_PAYMENT',
          details: `Associate class approved for ${app.member.fullName}, pending payment of the first-year fee before the new membership ID is issued.`
        }
      })
    ];

    if (targetCategory.firstYearFee && Number(targetCategory.firstYearFee) > 0) {
      upgradeOps.push(
        prisma.financialTransaction.create({
          data: {
            memberId: app.memberId,
            applicationId,
            amount: targetCategory.firstYearFee,
            currency: targetCategory.currency || 'RWF',
            txType: 'First_Year_Fee',
            paymentMethod: 'Bank_Transfer',
            transactionReference,
            status: 'Unpaid'
          }
        })
      );
    }

    await prisma.$transaction(upgradeOps);

    // Email notification
    sendRawMail({
      to: app.member.email,
      subject: 'RIQS Membership Upgrade: Associate Class Approved — Payment Required',
      html: `
        <div style="font-family: sans-serif; color: #333;">
          <h2>Congratulations — Associate Membership Approved</h2>
          <p>Dear ${app.member.fullName},</p>
          <p>We are pleased to inform you that upon review of your completed 2-year mentorship period, the RIQS Board has approved you for the <strong>${targetCategory.categoryName}</strong> membership class.</p>
          <p>To be recognized under this new class and receive your new membership ID, please pay the first-year membership fee for this category through your RIQS dashboard Payments page. Your new membership ID and the benefits of this class will be issued once payment is verified.</p>
          <p>You may continue your professional journey by requesting an APC assessment at any time to upgrade to full Technologist or Professional membership.</p>
          <br/><p>Best regards,</p><p>RIQS Registration Board</p>
        </div>
      `
    }).catch((err: any) => {
      console.error('[Award Associate] Failed to send email:', err.message);
      // Otherwise a failed send vanishes into the server console — record it so "the
      // member says they never got the invoice email" can be confirmed from data instead
      // of re-checking SMTP logs after the fact.
      prisma.auditLog.create({
        data: {
          memberId: app.memberId,
          actionByEmail: 'system@riqs.rw',
          actionType: 'EMAIL_SEND_FAILED',
          details: `Failed to send the Associate-class-approved payment-required email to ${app.member.email}: ${err.message}`
        }
      }).catch(() => {});
    });

    return res.status(200).json({
      message: `Associate class approved for ${targetCategory.categoryName}. Membership ID will be issued once the first-year fee is paid.`,
      memberClass: newClass
    });
  } catch (error: any) {
    console.error('[Award Associate] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error awarding Associate class.' });
  }
}

// 4. Update Member Profile (Phase B editable fields: Full Name only — with mandatory audit)
export async function updateMemberProfile(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { fullName } = req.body;

  if (!fullName || fullName.trim().length < 2) {
    return res.status(400).json({ error: 'Full name must be at least 2 characters.' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { id: req.user.id } });
    if (!member) return res.status(404).json({ error: 'Member profile not found.' });

    const oldName = member.fullName;

    if (oldName === fullName.trim()) {
      return res.status(200).json({ message: 'No changes detected.', member });
    }

    const [updatedMember, _] = await prisma.$transaction([
      prisma.member.update({
        where: { id: req.user.id },
        data: { fullName: fullName.trim(), updatedAt: new Date() }
      }),
      prisma.auditLog.create({
        data: {
          memberId: req.user.id,
          actionByEmail: req.user.email,
          actionType: 'NAME_CHANGE',
          details: `Name changed from "${oldName}" to "${fullName.trim()}".`
        }
      })
    ]);

    return res.status(200).json({ message: 'Profile name updated. Audit record created.', member: updatedMember });
  } catch (error: any) {
    console.error('[Update Member Profile] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error updating profile.' });
  }
}

// 5. Get Mentorship Progress for current member
export async function getMentorshipProgress(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    const progress = await prisma.mentorshipAssignment.findFirst({
      where: { application: { memberId: req.user.id } },
      include: {
        application: {
          select: {
            status: true,
            approvedAt: true,
            category: {
              select: {
                categoryName: true,
                categoryCode: true
              }
            }
          }
        }
      }
    });

    if (!progress) return res.status(200).json({ mentorship: null });

    const formattedProgress = {
      ...progress,
      application_status: progress.application.status,
      approved_at: progress.application.approvedAt,
      category_name: progress.application.category.categoryName,
      category_code: progress.application.category.categoryCode,
      application: undefined
    };

    return res.status(200).json({ mentorship: formattedProgress });
  } catch (error: any) {
    console.error('[Get Mentorship Progress] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching mentorship progress.' });
  }
}

// 6. Get assigned Mentees for the current logged-in Mentor
export async function getMentees(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  try {
    // The JWT's `role` claim is baked in at login time, so a member approved as a Mentor after
    // their session started would still carry the old "Standard" role on every request until
    // they log out and back in — hitting a false "Mentor status required" 403 the whole time.
    // Check the live systemRole here instead of trusting the token for this.
    const mentor = await prisma.member.findUnique({
      where: { id: req.user.id },
      select: { membershipId: true, systemRole: true }
    });

    if (req.user.role.toLowerCase() !== 'admin' && mentor?.systemRole !== 'Mentor') {
      return res.status(403).json({ error: 'Access Denied. Mentor status required.' });
    }

    if (!mentor || !mentor.membershipId) {
      return res.status(400).json({ error: 'Logged-in user does not have a valid membership registration number.' });
    }

    const assignments = await prisma.mentorshipAssignment.findMany({
      where: { mentorRegistrationNumber: mentor.membershipId },
      include: {
        application: {
          include: {
            member: {
              select: {
                fullName: true,
                email: true,
                phoneNumber: true,
                membershipClass: true,
                createdAt: true
              }
            },
            category: {
              select: { categoryName: true, categoryCode: true, location: true }
            },
            educationRecords: true,
            employmentRecords: true,
            uploadedDocuments: {
              select: {
                id: true,
                documentType: true,
                fileName: true,
                fileUrl: true,
                fileSizeBytes: true,
                uploadedAt: true
              }
            }
          }
        }
      }
    });


    const logbookEntries = await prisma.logbookEntry.findMany({
      where: {
        applicationId: { in: assignments.map(a => a.applicationId) }
      }
    });

    const formattedMentees = assignments.map(a => {
      const mentee = a.application.member;
      const relatedLogs = logbookEntries.filter(e => e.applicationId === a.applicationId);
      const progress = Math.min(100, Math.round((relatedLogs.length / 2) * 100));

      return {
        id: a.id,
        applicationId: a.applicationId,
        name: mentee.fullName,
        email: mentee.email,
        phone: mentee.phoneNumber,
        category: mentee.membershipClass || 'Graduate',
        joined: mentee.createdAt ? new Date(mentee.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'N/A',
        progress,
        entriesCount: relatedLogs.length,
        upgradeRequested: a.upgradeRequested,
        apcReadiness: a.apcReadiness,
        assignmentStatus: a.status,
        mentorRecommended: a.mentorRecommended,
        mentorNotes: a.mentorNotes,
        yearOneReportUrl: a.yearOneReportUrl,
        yearTwoReportUrl: a.yearTwoReportUrl,
        mentorRecommendationUrl: a.mentorRecommendationUrl,
        applicant: {
          ...mentee,
          category: a.application.category,
          education: a.application.educationRecords,
          employment: a.application.employmentRecords,
          documents: a.application.uploadedDocuments
        },
        logbooks: relatedLogs
      };
    });

    return res.status(200).json({ mentees: formattedMentees });
  } catch (error: any) {
    console.error('[Get Mentees] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching mentees list.' });
  }
}

export async function bulkScheduleApc(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationIds, assessmentPeriodStart, assessmentPeriodEnd } = req.body;

  if (!applicationIds || !Array.isArray(applicationIds) || applicationIds.length === 0 || !assessmentPeriodStart) {
    return res.status(400).json({ error: 'Missing required parameters: applicationIds (array) and assessmentPeriodStart.' });
  }

  const periodStart = parseAssessmentPeriod(assessmentPeriodStart);
  const periodEnd = assessmentPeriodEnd ? parseAssessmentPeriod(assessmentPeriodEnd) : null;

  if (!periodStart || (assessmentPeriodEnd && !periodEnd)) {
    return res.status(400).json({ error: 'Invalid period format. Use YYYY-MM.' });
  }
  if (periodEnd && periodEnd < periodStart) {
    return res.status(400).json({ error: 'Period end cannot be before period start.' });
  }

  try {
    const uniqueIds = Array.from(new Set(applicationIds as string[]));

    const [apps, existingAssessments] = await Promise.all([
      prisma.application.findMany({ where: { id: { in: uniqueIds } } }),
      prisma.apcAssessment.findMany({ where: { applicationId: { in: uniqueIds } } })
    ]);

    const appById = new Map(apps.map(a => [a.id, a]));
    const existingByAppId = new Map(existingAssessments.map(a => [a.applicationId, a]));

    const results = uniqueIds.map(appId => {
      const app = appById.get(appId);
      if (!app) return { applicationId: appId, success: false, error: 'Application not found.' };
      return { applicationId: appId, success: true, memberId: app.memberId };
    });

    const validApps = results.filter((r): r is { applicationId: string; success: true; memberId: string } => r.success);
    const toUpdateIds = validApps
      .filter(r => existingByAppId.has(r.applicationId))
      .map(r => existingByAppId.get(r.applicationId)!.id);
    const toCreate = validApps.filter(r => !existingByAppId.has(r.applicationId));

    await Promise.all([
      toUpdateIds.length > 0 ? prisma.apcAssessment.updateMany({
        where: { id: { in: toUpdateIds } },
        data: {
          assessmentPeriodStart: periodStart,
          assessmentPeriodEnd: periodEnd,
          status: 'Scheduled',
          updatedAt: new Date()
        }
      }) : Promise.resolve(),
      toCreate.length > 0 ? prisma.apcAssessment.createMany({
        data: toCreate.map(r => ({
          memberId: r.memberId,
          applicationId: r.applicationId,
          assessmentPeriodStart: periodStart,
          assessmentPeriodEnd: periodEnd,
          status: 'Scheduled' as const
        }))
      }) : Promise.resolve()
    ]);

    const memberIds = Array.from(new Set(validApps.map(r => r.memberId)));
    const members = await prisma.member.findMany({ where: { id: { in: memberIds } } });
    const memberById = new Map(members.map(m => [m.id, m]));
    for (const r of validApps) {
      const member = memberById.get(r.memberId);
      if (member) {
        sendMail(member.email, 'apc_scheduled', {
          name: member.fullName,
          date: formatAssessmentPeriod(periodStart, periodEnd)
        }).catch(console.error);
      }
    }

    const successful = results.filter(r => r.success).length;
    return res.status(200).json({
      message: `Scheduled ${successful} of ${results.length} assessments.`,
      results
    });
  } catch (error: any) {
    console.error('[Bulk Schedule APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error during bulk scheduling.' });
  }
}
