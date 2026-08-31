import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { sendMail } from '../config/mailer';

const ELIGIBLE_MENTOR_CLASSES = ['Technologist', 'Professional'];

// 1. Member submits a request to become a mentor. Being a Technologist/Professional no
// longer grants the Mentor role automatically — this is now the only member-initiated path
// to it (the other being an Admin/Approver promoting them directly from their profile).
export async function requestMentorStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    const member = await prisma.member.findUnique({ where: { id: req.user.id } });
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    if (member.systemRole === 'Mentor') {
      return res.status(400).json({ error: 'You are already a mentor.' });
    }
    if (!ELIGIBLE_MENTOR_CLASSES.includes(member.membershipClass || '')) {
      return res.status(403).json({ error: 'Only Technologist or Professional members can apply to become a mentor.' });
    }

    const existingPending = await prisma.mentorApplication.findFirst({
      where: { memberId: req.user.id, status: 'Pending' }
    });
    if (existingPending) {
      return res.status(409).json({ error: 'You already have a mentor application awaiting review.' });
    }

    const { motivation } = req.body;

    const application = await prisma.$transaction(async (tx) => {
      const created = await tx.mentorApplication.create({
        data: { memberId: req.user!.id, motivation: motivation?.trim() || null }
      });
      await tx.auditLog.create({
        data: {
          memberId: req.user!.id,
          actionByEmail: req.user!.email,
          actionType: 'MENTOR_APPLICATION_SUBMITTED',
          details: `${member.fullName} applied to become a mentor.`
        }
      });
      return created;
    });

    return res.status(201).json({ message: 'Mentor application submitted for review.', application });
  } catch (error: any) {
    console.error('[Request Mentor Status] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error submitting mentor application.' });
  }
}

// 2. Member views their own most recent mentor application (if any).
export async function getMyMentorApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    const application = await prisma.mentorApplication.findFirst({
      where: { memberId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });
    return res.status(200).json({ application });
  } catch (error: any) {
    console.error('[Get My Mentor Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching mentor application.' });
  }
}

// 3. Admin / Admin Assistant: paginated queue of mentor applications.
export async function getMentorApplicationsQueue(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { status = 'Pending', page = '1', limit = '20' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const whereClause: any = {};
  if (status && status !== 'all') {
    whereClause.status = status;
  }

  try {
    const [applications, total] = await Promise.all([
      prisma.mentorApplication.findMany({
        where: whereClause,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          member: {
            select: { fullName: true, email: true, membershipId: true, membershipClass: true, systemRole: true }
          }
        }
      }),
      prisma.mentorApplication.count({ where: whereClause })
    ]);

    return res.status(200).json({ applications, pagination: { total, page: Number(page), limit: take } });
  } catch (error: any) {
    console.error('[Get Mentor Applications Queue] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching mentor applications.' });
  }
}

// 4. Admin / Admin Assistant: approve or reject a mentor application.
export async function reviewMentorApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id } = req.params;
  const { decision, reviewNotes } = req.body; // decision: 'Approve' | 'Reject'

  if (!['Approve', 'Reject'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision. Must be Approve or Reject.' });
  }

  try {
    const application = await prisma.mentorApplication.findUnique({
      where: { id },
      include: { member: true }
    });
    if (!application) return res.status(404).json({ error: 'Mentor application not found.' });
    if (application.status !== 'Pending') {
      return res.status(400).json({ error: `This application has already been ${application.status.toLowerCase()}.` });
    }

    if (decision === 'Reject') {
      if (!reviewNotes?.trim()) return res.status(400).json({ error: 'Please provide a reason for rejecting this application.' });

      await prisma.$transaction([
        prisma.mentorApplication.update({
          where: { id },
          data: { status: 'Rejected', reviewNotes: reviewNotes.trim(), reviewedByEmail: req.user.email, reviewedAt: new Date() }
        }),
        prisma.auditLog.create({
          data: {
            memberId: application.memberId,
            actionByEmail: req.user.email,
            actionType: 'MENTOR_APPLICATION_REJECTED',
            details: `Mentor application for ${application.member.fullName} rejected. Reason: ${reviewNotes.trim()}`
          }
        })
      ]);

      sendMail(application.member.email, 'mentor_application_rejected', {
        name: application.member.fullName,
        reason: reviewNotes.trim()
      }).catch((err: any) => {
        console.error('[Review Mentor Application] Failed to send rejection email:', err.message);
        // Otherwise a failed send vanishes into the server console — record it so "the
        // member says they never got the rejection notice" can be confirmed from data.
        prisma.auditLog.create({
          data: {
            memberId: application.memberId,
            actionByEmail: 'system@riqs.rw',
            actionType: 'EMAIL_SEND_FAILED',
            details: `Failed to send the mentor application rejection notice to ${application.member.email}: ${err.message}`
          }
        }).catch(() => {});
      });

      return res.status(200).json({ message: 'Mentor application rejected.' });
    }

    // Approve — re-check eligibility at the moment of approval in case the member's class
    // changed since they applied (e.g. they were somehow downgraded in the meantime).
    if (application.member.systemRole === 'Mentor') {
      return res.status(400).json({ error: 'This member is already a mentor.' });
    }
    if (!ELIGIBLE_MENTOR_CLASSES.includes(application.member.membershipClass || '')) {
      return res.status(400).json({ error: `${application.member.fullName} is no longer a Technologist or Professional member and cannot be approved as a mentor.` });
    }

    await prisma.$transaction([
      prisma.mentorApplication.update({
        where: { id },
        data: { status: 'Approved', reviewNotes: reviewNotes?.trim() || null, reviewedByEmail: req.user.email, reviewedAt: new Date() }
      }),
      prisma.member.update({
        where: { id: application.memberId },
        data: { systemRole: 'Mentor' }
      }),
      prisma.auditLog.create({
        data: {
          memberId: application.memberId,
          actionByEmail: req.user.email,
          actionType: 'MENTOR_APPLICATION_APPROVED',
          details: `Mentor application for ${application.member.fullName} approved. Mentor role granted.`
        }
      })
    ]);

    sendMail(application.member.email, 'mentor_application_approved', {
      name: application.member.fullName
    }).catch((err: any) => {
      console.error('[Review Mentor Application] Failed to send approval email:', err.message);
      prisma.auditLog.create({
        data: {
          memberId: application.memberId,
          actionByEmail: 'system@riqs.rw',
          actionType: 'EMAIL_SEND_FAILED',
          details: `Failed to send the mentor application approval notice to ${application.member.email}: ${err.message}`
        }
      }).catch(() => {});
    });

    return res.status(200).json({ message: 'Mentor application approved. Mentor role granted.' });
  } catch (error: any) {
    console.error('[Review Mentor Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error reviewing mentor application.' });
  }
}

// 5. Admin / Approver: directly grant the Mentor role from a member's profile, without
// requiring them to apply. Also auto-resolves any Pending application of theirs so it
// doesn't sit forever as a stale "awaiting review" artifact once they're already a mentor.
export async function promoteToMentor(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id } = req.params;

  try {
    const member = await prisma.member.findUnique({ where: { id } });
    if (!member) return res.status(404).json({ error: 'Member not found.' });
    if (member.systemRole === 'Mentor') {
      return res.status(400).json({ error: 'This member is already a mentor.' });
    }
    if (!ELIGIBLE_MENTOR_CLASSES.includes(member.membershipClass || '')) {
      return res.status(400).json({ error: 'Only Technologist or Professional members can be made a mentor.' });
    }

    await prisma.$transaction([
      prisma.member.update({ where: { id }, data: { systemRole: 'Mentor' } }),
      prisma.mentorApplication.updateMany({
        where: { memberId: id, status: 'Pending' },
        data: { status: 'Approved', reviewNotes: 'Auto-resolved: granted directly by an Admin/Approver.', reviewedByEmail: req.user.email, reviewedAt: new Date() }
      }),
      prisma.auditLog.create({
        data: {
          memberId: id,
          actionByEmail: req.user.email,
          actionType: 'MENTOR_STATUS_GRANTED',
          details: `${member.fullName} was directly designated a mentor by ${req.user.email}.`
        }
      })
    ]);

    sendMail(member.email, 'mentor_status_granted', {
      name: member.fullName
    }).catch((err: any) => {
      console.error('[Promote To Mentor] Failed to send email:', err.message);
      prisma.auditLog.create({
        data: {
          memberId: member.id,
          actionByEmail: 'system@riqs.rw',
          actionType: 'EMAIL_SEND_FAILED',
          details: `Failed to send the mentor-status-granted notice to ${member.email}: ${err.message}`
        }
      }).catch(() => {});
    });

    return res.status(200).json({ message: `${member.fullName} is now a mentor.` });
  } catch (error: any) {
    console.error('[Promote To Mentor] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error granting mentor status.' });
  }
}

// 6. Admin / Approver: revoke the Mentor role directly — the inverse of promoteToMentor.
// Does not touch or unassign any mentees already linked to them (mentorRegistrationNumber
// on their existing MentorshipAssignment rows) — that reassignment, if needed, is a
// separate, deliberate action for staff to take, not an automatic side effect of this one.
export async function revokeMentorStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id } = req.params;

  try {
    const member = await prisma.member.findUnique({ where: { id } });
    if (!member) return res.status(404).json({ error: 'Member not found.' });
    if (member.systemRole !== 'Mentor') {
      return res.status(400).json({ error: 'This member is not currently a mentor.' });
    }

    const activeMenteeCount = member.membershipId
      ? await prisma.mentorshipAssignment.count({ where: { mentorRegistrationNumber: member.membershipId } })
      : 0;

    await prisma.$transaction([
      prisma.member.update({ where: { id }, data: { systemRole: 'Standard' } }),
      prisma.auditLog.create({
        data: {
          memberId: id,
          actionByEmail: req.user.email,
          actionType: 'MENTOR_STATUS_REVOKED',
          details: `Mentor status revoked from ${member.fullName} by ${req.user.email}.${activeMenteeCount > 0 ? ` They had ${activeMenteeCount} mentee assignment(s) on record — these were not reassigned automatically.` : ''}`
        }
      })
    ]);

    return res.status(200).json({
      message: `Mentor status revoked from ${member.fullName}.`,
      activeMenteeCount
    });
  } catch (error: any) {
    console.error('[Revoke Mentor Status] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error revoking mentor status.' });
  }
}
