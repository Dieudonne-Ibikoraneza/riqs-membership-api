import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { ApcStatus, MemberClass } from '@prisma/client';
import { sendRawMail, sendMail } from '../config/mailer';
import { getCertificateCode } from '../utils/membershipUtils';

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
        apcAssessments: {
          none: { status: { in: ['Passed', 'Failed', 'No_Show'] } }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!app) {
      return res.status(404).json({ error: 'No approved application found for this member. If you have already completed an APC for your current application, please submit a new application for the next membership tier.' });
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
export async function registerAPC(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId, assessmentDate, panelChair, panelChairEmail, examiner1, examiner1Email, examiner2, examiner2Email } = req.body;

  if (!applicationId || !assessmentDate) {
    return res.status(400).json({ error: 'Missing required parameters: applicationId and assessmentDate.' });
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
          assessmentDate: new Date(assessmentDate),
          panelChairName: panelChair || 'Board Chair TBD',
          panelChairEmail: panelChairEmail || null,
          examiner1Name: examiner1 || 'Examiner 1 TBD',
          examiner1Email: examiner1Email || null,
          examiner2Name: examiner2 || 'Examiner 2 TBD',
          examiner2Email: examiner2Email || null,
          status: 'Scheduled',
          updatedAt: new Date()
        }
      });
    } else {
      assessment = await prisma.apcAssessment.create({
        data: {
          memberId: app.memberId,
          applicationId,
          assessmentDate: new Date(assessmentDate),
          panelChairName: panelChair || 'Board Chair TBD',
          panelChairEmail: panelChairEmail || null,
          examiner1Name: examiner1 || 'Examiner 1 TBD',
          examiner1Email: examiner1Email || null,
          examiner2Name: examiner2 || 'Examiner 2 TBD',
          examiner2Email: examiner2Email || null,
          status: 'Scheduled'
        }
      });
    }

    const member = await prisma.member.findUnique({ where: { id: app.memberId } });
    if (member) {
      const formattedDate = new Date(assessmentDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      sendMail(member.email, 'apc_scheduled', {
        name: member.fullName,
        date: formattedDate,
        chair: panelChair || 'TBD',
        examiner1: examiner1 || 'TBD',
        examiner2: examiner2 || 'TBD'
      }).catch(console.error);

      const generateHtmlTemplate = (examinerName: string) => `
        <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
          <p>Dear ${examinerName},</p>
          <p>I hope you are doing well. I am pleased to inform you that you have been selected to serve as an Examiner for the APC Assessment of the <strong>${member?.fullName || 'candidate'}</strong>.</p>
          <p>The panel schedule is as follows:</p>
          <ul style="list-style-type: none; padding-left: 0;">
            <li><strong>Date & Time:</strong> ${formattedDate}</li>
            <li><strong>Panel Chair:</strong> ${panelChair || 'TBD'}</li>
            <li><strong>Examination/Candidate:</strong> ${member?.fullName || 'TBD'}</li>
            <li><strong>Examiners:</strong> ${examiner1 || 'TBD'}, ${examiner2 || 'TBD'}</li>
          </ul>
          <p>Kindly proceed with your preparations in line with the assessment requirements and any instructions already communicated by the RIQS Secretariat.</p>
          <p>Please acknowledge receipt of this message at your earliest convenience.</p>
          <p>Regards,<br/><strong>RIQS Board</strong></p>
        </div>
      `;
      const emailSubject = `Appointment Confirmation – APC Assessment for ${member?.fullName || 'candidate'}`;

      if (panelChairEmail) {
        sendRawMail({ to: panelChairEmail, subject: emailSubject, html: generateHtmlTemplate(panelChair || 'Panel Chair') }).catch(console.error);
      }
      if (examiner1Email) {
        sendRawMail({ to: examiner1Email, subject: emailSubject, html: generateHtmlTemplate(examiner1 || 'Examiner') }).catch(console.error);
      }
      if (examiner2Email) {
        sendRawMail({ to: examiner2Email, subject: emailSubject, html: generateHtmlTemplate(examiner2 || 'Examiner') }).catch(console.error);
      }
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

// 3. Grade APC Assessment (Admin records pass/fail and triggers class upgrade)
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
    const apc = await prisma.apcAssessment.findUnique({
      where: { id: assessmentId },
      include: { 
        application: { include: { category: { select: { categoryCode: true, categoryName: true, stampFee: true, currency: true } } } },
        member: true
      }
    });

    if (!apc) return res.status(404).json({ error: 'APC assessment not found.' });

    let newClass: MemberClass | undefined = undefined;
    let newMembershipId: string | undefined = undefined;
    let newCertCode: string | undefined = undefined;

    if (mappedStatus === 'Passed') {
      const code = apc.application.category.categoryCode;
      // Route 1 (GQST) → Technologist, Route 2+ (GQS/PQS/FPQS) → Professional
      newClass = 'Technologist';
      if (code === 'GQS' || code === 'PQS' || code === 'FPQS') newClass = 'Professional';

      // Determine the new certificate code based on new class
      if (newClass === 'Technologist') newCertCode = 'TechQS';
      else newCertCode = code === 'FPQS' ? 'PrQS' : 'PrQS';

      // Generate a sequential membership ID under the new cert code
      const currentYear = new Date().getFullYear();
      const existingCount = await prisma.member.count({
        where: { membershipId: { startsWith: `RIQS-${currentYear}-${newCertCode}-` } }
      });
      const paddedSequence = String(existingCount + 1).padStart(4, '0');
      newMembershipId = `RIQS-${currentYear}-${newCertCode}-${paddedSequence}`;
    }

    let targetCategory: any = null;
    if (mappedStatus === 'Passed') {
      const code = apc.application.category.categoryCode;
      let targetCategoryCode = code;
      if (code === 'GQST') targetCategoryCode = 'QST';
      else if (code === 'GQS') targetCategoryCode = 'PQS';

      if (targetCategoryCode !== code) {
        targetCategory = await prisma.membershipCategory.findFirst({
          where: { categoryCode: targetCategoryCode, entityType: 'Individual' }
        });
      }
    }

    const transactions: any[] = [
      prisma.apcAssessment.update({
        where: { id: assessmentId },
        data: {
          status: mappedStatus as ApcStatus,
          scorePercentage: scorePercentage || null,
          assessmentNotes: assessmentNotes || null,
          stampFeePaid: stampFeePaid || false,
          licenseIssued: licenseIssued || false,
          updatedAt: new Date()
        }
      }),
      prisma.auditLog.create({
        data: {
          memberId: apc.memberId,
          actionByEmail: req.user.email,
          actionType: 'APC_GRADED',
          details: `APC ${assessmentId} graded as ${status}. Score: ${scorePercentage || 'N/A'}%`
        }
      })
    ];

    if (newClass && newMembershipId) {
      // Upgrade member class + issue new membership ID and upgrade system role to Mentor
      transactions.push(
        prisma.member.update({
          where: { id: apc.memberId },
          data: { 
            membershipClass: newClass, 
            membershipId: newMembershipId, 
            systemRole: 'Mentor',
            updatedAt: new Date() 
          }
        })
      );

      // Upgrade the application category so future renewals have the escalated fee
      if (targetCategory) {
        transactions.push(
          prisma.application.update({
            where: { id: apc.applicationId },
            data: { categoryId: targetCategory.id }
          })
        );
      }

      // Create unpaid Stamp Fee invoice if applicable
      const stampFeeAmount = apc.application.category.stampFee ?? 0;
      if (Number(stampFeeAmount) > 0) {
        transactions.push(
          prisma.financialTransaction.create({
            data: {
              memberId: apc.memberId,
              applicationId: apc.applicationId,
              amount: stampFeeAmount,
              currency: apc.application.category.currency || 'RWF',
              txType: 'Stamp_Fee',
              paymentMethod: 'Bank_Transfer',
              transactionReference: `STAMP-${newMembershipId}-${Date.now()}`,
              status: 'Unpaid',
            }
          })
        );
      }

      // Audit the upgrade
      transactions.push(
        prisma.auditLog.create({
          data: {
            memberId: apc.memberId,
            actionByEmail: req.user.email,
            actionType: 'APC_UPGRADE',
            details: `Membership upgraded to ${newClass}. New ID: ${newMembershipId}. Stamp fee invoice created.`
          }
        })
      );
    }

    const [updatedApc] = await prisma.$transaction(transactions);

    // Send email notification for finalized results
    if (['Passed', 'Failed'].includes(mappedStatus) && apc.member?.email) {
      const emailSubject = `APC Assessment Result: ${mappedStatus}`;
      const emailBody = `
        <div style="font-family: sans-serif; color: #333;">
          <h2>APC Assessment Results Published</h2>
          <p>Dear ${apc.member.fullName},</p>
          <p>The results for your recent APC board assessment have been finalized.</p>
          <p><strong>Final Outcome:</strong> ${mappedStatus}</p>
          ${scorePercentage ? `<p><strong>Score:</strong> ${scorePercentage}%</p>` : ''}
          ${newClass ? `<p style="color: #059669; font-weight: bold;">Congratulations! Your membership class has been upgraded to ${newClass}.</p>` : ''}
          ${newMembershipId ? `<p><strong>Your new Membership ID:</strong> ${newMembershipId}</p><p>A stamp fee invoice has been raised on your account. Please log in to your dashboard to complete payment.</p>` : ''}
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
      }).catch((err: any) => console.error("[Grade APC] Failed to send email:", err.message));
    }

    return res.status(200).json({ message: `APC assessment graded: ${status}.`, assessment: updatedApc });
  } catch (error: any) {
    console.error('[Grade APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error grading APC assessment.' });
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
    // Route 1 (GQST) → Associate QS Technologist (AQST)
    // Route 2 (GQS)  → Associate Quantity Surveyor (AQS)
    let targetCode: string;
    let newClass: MemberClass;
    if (code === 'GQST') { targetCode = 'AQST'; newClass = 'Associate'; }
    else if (code === 'GQS') { targetCode = 'AQS'; newClass = 'Associate'; }
    else return res.status(400).json({ error: `Associate class is only applicable to Route 1 (GQST) or Route 2 (GQS). Current category: ${code}` });

    const targetCategory = await prisma.membershipCategory.findFirst({
      where: { categoryCode: targetCode, entityType: 'Individual' }
    });
    if (!targetCategory) return res.status(500).json({ error: `Associate category (${targetCode}) not found in database. Please re-run seed.` });

    // Generate new membership ID
    const currentYear = new Date().getFullYear();
    const existingCount = await prisma.member.count({
      where: { membershipId: { startsWith: `RIQS-${currentYear}-${targetCode}-` } }
    });
    const paddedSeq = String(existingCount + 1).padStart(4, '0');
    const newMembershipId = `RIQS-${currentYear}-${targetCode}-${paddedSeq}`;

    await prisma.$transaction([
      prisma.member.update({
        where: { id: app.memberId },
        data: { membershipClass: newClass, membershipId: newMembershipId, updatedAt: new Date() }
      }),
      prisma.application.update({
        where: { id: applicationId },
        data: { categoryId: targetCategory.id }
      }),
      prisma.auditLog.create({
        data: {
          memberId: app.memberId,
          actionByEmail: req.user.email,
          actionType: 'ASSOCIATE_AWARDED',
          details: `Associate class awarded to ${app.member.email}. New ID: ${newMembershipId}. No APC required.`
        }
      })
    ]);

    // Email notification
    sendRawMail({
      to: app.member.email,
      subject: 'RIQS Membership Upgrade: Associate Class Awarded',
      html: `
        <div style="font-family: sans-serif; color: #333;">
          <h2>Congratulations — Associate Membership Awarded</h2>
          <p>Dear ${app.member.fullName},</p>
          <p>We are pleased to inform you that upon review of your completed 2-year mentorship period, the RIQS Board has awarded you the <strong>${targetCategory.categoryName}</strong> membership class.</p>
          <p><strong>Your New Membership ID:</strong> ${newMembershipId}</p>
          <p>You may continue your professional journey by requesting an APC assessment at any time to upgrade to full Technologist or Professional membership.</p>
          <br/><p>Best regards,</p><p>RIQS Registration Board</p>
        </div>
      `
    }).catch((err: any) => console.error('[Award Associate] Failed to send email:', err.message));

    return res.status(200).json({
      message: `Associate class successfully awarded. New membership ID: ${newMembershipId}`,
      membershipId: newMembershipId,
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
  if (req.user.role.toLowerCase() !== 'mentor' && req.user.role.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Access Denied. Mentor status required.' });
  }

  try {
    const mentor = await prisma.member.findUnique({
      where: { id: req.user.id },
      select: { membershipId: true }
    });

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
            uploadedDocuments: {
              where: { documentType: 'MentorRecommendation' },
              select: {
                id: true,
                fileName: true,
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
        yearOneReportUrl: a.yearOneReportUrl,
        yearTwoReportUrl: a.yearTwoReportUrl,
        mentorRecommendationUrl: a.mentorRecommendationUrl
      };
    });

    return res.status(200).json({ mentees: formattedMentees });
  } catch (error: any) {
    console.error('[Get Mentees] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching mentees list.' });
  }
}
