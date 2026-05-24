import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { ApcStatus, MemberClass } from '@prisma/client';

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

// 2. Schedule APC Assessment (Registers graduates for examinations)
export async function registerAPC(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId, assessmentDate, panelChair, examiner1, examiner2 } = req.body;

  if (!applicationId || !assessmentDate) {
    return res.status(400).json({ error: 'Missing required parameters: applicationId and assessmentDate.' });
  }

  try {
    const assessment = await prisma.apcAssessment.create({
      data: {
        memberId: req.user.id,
        applicationId,
        assessmentDate: new Date(assessmentDate),
        panelChairName: panelChair || 'Board Chair TBD',
        examiner1Name: examiner1 || 'Examiner 1 TBD',
        examiner2Name: examiner2 || 'Examiner 2 TBD',
        status: 'Scheduled'
      }
    });

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
      include: { application: { include: { category: true } } }
    });

    if (!apc) return res.status(404).json({ error: 'APC assessment not found.' });

    let newClass: MemberClass | undefined = undefined;

    if (mappedStatus === 'Passed') {
      const code = apc.application.category.categoryCode;
      newClass = 'Technologist';
      if (code === 'GQS' || code === 'PQS' || code === 'FPQS') newClass = 'Professional';
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

    if (newClass) {
      transactions.push(
        prisma.member.update({
          where: { id: apc.memberId },
          data: { membershipClass: newClass, updatedAt: new Date() }
        })
      );
    }

    const [updatedApc, _, __] = await prisma.$transaction(transactions);

    return res.status(200).json({ message: `APC assessment graded: ${status}.`, assessment: updatedApc });
  } catch (error: any) {
    console.error('[Grade APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error grading APC assessment.' });
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

    const formattedMentees = assignments.map(a => {
      const mentee = a.application.member;
      const recDoc = a.application.uploadedDocuments[0];
      return {
        id: a.id,
        applicationId: a.applicationId,
        name: mentee.fullName,
        email: mentee.email,
        phone: mentee.phoneNumber,
        category: mentee.membershipClass || 'Graduate',
        joined: mentee.createdAt ? new Date(mentee.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'N/A',
        progress: a.completedDurationMonths ? Math.min(100, Math.round((a.completedDurationMonths / 24) * 100)) : 40,
        recommendationSent: !!recDoc,
        recommendationDocId: recDoc ? recDoc.id : null,
        recommendationFileName: recDoc ? recDoc.fileName : null
      };
    });

    return res.status(200).json({ mentees: formattedMentees });
  } catch (error: any) {
    console.error('[Get Mentees] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching mentees list.' });
  }
}
