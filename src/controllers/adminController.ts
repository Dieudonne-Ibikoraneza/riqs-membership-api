import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { sendMail, sendRawMail } from '../config/mailer';
import { ApplicationStatus } from '@prisma/client';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { pickAuthoritativeTransaction, memberStatusWhereConditions } from '../utils/membershipUtils';

function parseReviewMonth(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  return new Date(`${value}-01T00:00:00.000Z`);
}

// 1. Administrative Registry Queue (Paginated & Filterable)
export async function getReviewQueue(req: AuthenticatedRequest, res: Response) {
  const { status, page = 1, limit = 10, view } = req.query;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    const whereClause: any = {};
    
    // 1. Process explicit status filter from dropdown
    if (status) {
      const statusStr = String(status).toLowerCase();
      const validStatuses = ['Draft', 'Pending', 'Under_Review', 'Pending_Approval', 'Correction_Required', 'Approved', 'Rejected'];
      const matchedStatus = validStatuses.find(s => s.toLowerCase() === statusStr);
      
      if (matchedStatus) {
        whereClause.status = matchedStatus as ApplicationStatus;
      } else {
        return res.status(400).json({ error: `Invalid status parameter. Valid options: ${validStatuses.join(', ')}` });
      }
    }

    const userRole = req.user?.role?.toLowerCase() || '';
    const isAdmin = userRole === 'admin';
    const isAdminAssistant = userRole === 'admin_assistant';
    const isApprover = userRole === 'approver';
    const isReviewerOrHead = userRole === 'reviewer' || userRole === 'head_reviewer';

    // 2. Apply role-based visibility: each role only sees their slice of the workflow
    if (isAdmin || isAdminAssistant) {
      // Admin sees newly submitted apps awaiting initial review (Pending only)
      if (view === 'all') {
        // "All" tab — admin can see historical records too
        if (!status) whereClause.status = { not: 'Draft' };
      } else {
        // Default queue tab — only Pending apps needing admin's attention
        if (!status) whereClause.status = 'Pending';
      }
    } else if (isApprover) {
      // Approver sees apps forwarded to them (Pending_Approval)
      if (view === 'all') {
        // The All view exposes every submitted application for read-only
        // oversight. Drafts remain private to applicants until submission.
        if (!status) whereClause.status = { not: 'Draft' };
      } else {
        if (!status) whereClause.status = 'Pending_Approval';
      }
    } else if (isReviewerOrHead) {
      // Reviewers and Head Reviewer only see apps forwarded by admin (Under_Review and above)
      if (view === 'all') {
        if (!status) whereClause.status = { in: ['Under_Review', 'Pending_Approval', 'Correction_Required', 'Approved', 'Rejected'] };
      } else {
        if (!status) {
          whereClause.OR = [
            { status: { in: ['Under_Review', 'Correction_Required'] } },
            { mentorshipAssignment: { status: 'Pending_Reviewer_Board' } }
          ];
        } else {
          whereClause.status = status;
        }
      }
    }

    const [queue, total] = await Promise.all([
      prisma.application.findMany({
        where: whereClause,
        skip,
        take,
        orderBy: { submittedAt: 'desc' },
        include: {
          member: { select: { fullName: true, email: true, isFellow: true, isHonorary: true, honors: true } },
          category: { select: { categoryName: true, location: true } },
          assignedReviewer: { select: { fullName: true } },
          mentorshipAssignment: true,
          uploadedDocuments: {
            where: { documentType: { in: ['Passport_Photo', 'PassportPhoto'] } },
            take: 1
          },
          apcAssessments: {
            where: { status: 'Requested' },
            take: 1
          }
        }
      }),
      prisma.application.count({ where: whereClause })
    ]);

    // Flatten to match existing SQL output shape for UI
    const formattedQueue = queue.map(app => ({
      id: app.id,
      member_id: app.memberId,
      status: ['Pending_Reviewer_Board', 'Pending_Admin_Review'].includes(app.mentorshipAssignment?.status || '') ? 'Mentorship_Upgrade' : app.status,
      submitted_at: app.submittedAt,
      full_name: app.member.fullName,
      email: app.member.email,
      category_name: app.category.categoryName,
      location: app.category.location,
      reviewer: app.assignedReviewer?.fullName || 'Unassigned',
      photoId: app.uploadedDocuments?.[0]?.id,
      apcRequested: (app as any).apcAssessments?.length > 0,
      isFellow: app.member.isFellow,
      isHonorary: app.member.isHonorary,
      honors: (app.member as any).honors || []
    }));

    return res.status(200).json({
      queue: formattedQueue,
      pagination: {
        total,
        page: parseInt(page as string, 10),
        limit: take
      }
    });
  } catch (error: any) {
    console.error('[Admin Queue] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching administrative queue.' });
  }
}

// 2. Administrative Decision Processor (Approve / Flag / Reject)
export async function handleReviewDecision(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });
  if (req.user.role.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Access Denied. Only Admins can use the direct application decision action.' });
  }

  const { applicationId, action, notes } = req.body; // action: 'Approve' | 'Flag' | 'Reject'

  if (!applicationId || !action) {
    return res.status(400).json({ error: 'Missing mandatory parameters: applicationId and action.' });
  }

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        member: true,
        category: true
      }
    });

    if (!app) {
      return res.status(404).json({ error: 'Application record not found.' });
    }

    if (app.status && ['Approved', 'Rejected', 'Correction_Required'].includes(app.status)) {
      return res.status(400).json({ error: `This application has already been processed (current status: "${app.status}").` });
    }

    const oldStatus = app.status;

    if (action === 'Flag') {
      if (!notes) return res.status(400).json({ error: 'Action Rejected. Reviewer correction remarks are mandatory when flagging applications.' });

      await prisma.$transaction([
        prisma.application.update({
          where: { id: applicationId },
          data: { status: 'Correction_Required', updatedAt: new Date() }
        }),
        prisma.applicationStatusHistory.create({
          data: {
            applicationId,
            changedByEmail: req.user.email,
            oldStatus: oldStatus || 'Draft',
            newStatus: 'Correction_Required',
            reviewerNotes: notes
          }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'APPLICATION_FLAGGED',
            details: `Admin returned application ${applicationId} for correction. Notes: ${notes}`
          }
        })
      ]);

      try { await sendMail(app.member.email, "correctionRequired", { name: app.member.fullName, reviewerNotes: notes }); } catch (e) {}
      return res.status(200).json({ message: 'Application flagged. Correction instructions sent.' });

    } else if (action === 'Reject') {
      if (!notes) return res.status(400).json({ error: 'Action Rejected. Rejection notes are mandatory.' });

      await prisma.$transaction([
        prisma.application.update({
          where: { id: applicationId },
          data: { status: 'Rejected', updatedAt: new Date() }
        }),
        prisma.applicationStatusHistory.create({
          data: {
            applicationId,
            changedByEmail: req.user.email,
            oldStatus: oldStatus || 'Draft',
            newStatus: 'Rejected',
            reviewerNotes: notes
          }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'APPLICATION_REJECTED',
            details: `Admin rejected application ${applicationId}. Notes: ${notes}`
          }
        })
      ]);

      try { await sendMail(app.member.email, "rejected", { name: app.member.fullName, reason: notes }); } catch (e) {}
      return res.status(200).json({ message: 'Application declined. Notification sent.' });

    } else if (action === 'ReturnForCorrection') {
      if (!notes) return res.status(400).json({ error: 'Correction remarks are mandatory.' });

      await prisma.$transaction([
        prisma.application.update({
          where: { id: applicationId },
          data: { status: 'Correction_Required', updatedAt: new Date() }
        }),
        prisma.applicationStatusHistory.create({
          data: {
            applicationId,
            changedByEmail: req.user.email,
            oldStatus: oldStatus || 'Draft',
            newStatus: 'Correction_Required',
            reviewerNotes: notes
          }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'APPLICATION_RETURNED_FOR_CORRECTION',
            details: `Admin returned application ${applicationId} for correction. Notes: ${notes}`
          }
        })
      ]);

      try { await sendMail(app.member.email, "correctionRequired", { name: app.member.fullName, reviewerNotes: notes }); } catch (e) {}
      return res.status(200).json({ message: 'Application flagged for correction. Notification sent.' });

    }

    else if (action === 'Approve') {
      const currentYear = new Date().getFullYear();
      const transactionReference = `INV-${applicationId.slice(0, 8)}-${currentYear}`;
      const txOps: any[] = [
        prisma.application.update({
          where: { id: applicationId },
          data: { status: 'Approved', approvedAt: new Date(), updatedAt: new Date() }
        }),
        prisma.applicationStatusHistory.create({
          data: {
            applicationId,
            changedByEmail: req.user.email,
            oldStatus: oldStatus || 'Draft',
            newStatus: 'Approved',
            reviewerNotes: 'Application approved.'
          }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'APPROVE',
            details: 'Application approved. Membership credentials will be issued after first-year fee clearance.'
          }
        })
      ];
      if (app.category.firstYearFee && Number(app.category.firstYearFee) > 0) {
        txOps.push(prisma.financialTransaction.create({
          data: {
            memberId: app.memberId,
            applicationId,
            amount: app.category.firstYearFee,
            currency: app.category.currency || 'RWF',
            txType: 'First_Year_Fee',
            paymentMethod: 'Bank_Transfer',
            transactionReference,
            status: 'Unpaid'
          }
        }));
      }
      await prisma.$transaction(txOps);
      const paymentsUrl = 'https://ricos.rwandaiqs.org/dashboard/payments';
      try { await sendMail(app.member.email, "approved", { name: app.member.fullName, category: app.category.categoryName, paymentsUrl }); } catch (e) {}
      return res.status(200).json({ message: 'Application approved. First-year fee invoice created; membership credentials will be issued after payment clearance.' });
    }

    return res.status(400).json({ error: 'Invalid action. Only Approve, Flag, or Reject allowed.' });
  } catch (error: any) {
    console.error('[Admin Review Decision] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error resolving reviewer decision.' });
  }
}

// 2b. Reviewer First-Stage Action (Reviewer / Admin only)
// Actions: StartReview | ReturnForCorrection | ForwardToApprover
export async function handleReviewerAction(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const userRole = req.user.role.toLowerCase();
  if (!['reviewer', 'head_reviewer', 'admin', 'admin_assistant'].includes(userRole)) {
    return res.status(403).json({ error: 'Access Denied. Only Reviewers, Head Reviewers, Admins, or Admin Assistants can perform first-stage application actions.' });
  }

  const { applicationId, action, notes, complianceStatus } = req.body;
  if (!applicationId || !action) {
    return res.status(400).json({ error: 'Missing mandatory parameters: applicationId and action.' });
  }

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { member: true }
    });

    if (!app) return res.status(404).json({ error: 'Application record not found.' });
    const oldStatus = app.status;

    if (action === 'SubmitReviewNote') {
      if (userRole !== 'reviewer' && userRole !== 'head_reviewer') {
        return res.status(403).json({ error: 'Access Denied. Only Reviewers or Head Reviewers can submit review notes.' });
      }
      if (app.status !== 'Under_Review') {
        return res.status(400).json({ error: `Cannot add review. Application is in "${app.status}" status.` });
      }
      if (!['Compliant', 'Non-compliant'].includes(complianceStatus)) {
        return res.status(400).json({ error: 'Select whether the application is Compliant or Non-compliant.' });
      }
      if (complianceStatus === 'Non-compliant' && !notes?.trim()) {
        return res.status(400).json({ error: 'Review notes are required when the application is Non-compliant.' });
      }

      const approverReturnCount = await prisma.applicationStatusHistory.count({
        where: { applicationId, oldStatus: 'Pending_Approval', newStatus: 'Under_Review' }
      });
      const reviewRound = approverReturnCount + 1;
      const existingReview = await prisma.applicationReview.findUnique({
        where: { applicationId_reviewerId_reviewRound: {
          applicationId,
          reviewerId: req.user.id,
          reviewRound
        } }
      });
      if (existingReview) {
        return res.status(409).json({ error: 'You have already submitted a review note for this application.' });
      }
      
      await prisma.$transaction([
        prisma.applicationReview.create({
          data: { applicationId, reviewerId: req.user.id, reviewRound, complianceStatus, notes: notes?.trim() || null }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'REVIEW_NOTE_SUBMITTED',
            details: `${req.user.role} submitted a ${complianceStatus} review for application ${applicationId}.`
          }
        })
      ]);

      return res.status(200).json({ message: 'Review submitted successfully.' });

    } else if (action === 'ReturnForCorrection') {
      if (userRole !== 'head_reviewer' && userRole !== 'admin' && userRole !== 'admin_assistant') {
        return res.status(403).json({ error: 'Access Denied. Only Head Reviewers, Admins, or Admin Assistants can return an application for correction.' });
      }
      if (!notes) return res.status(400).json({ error: 'Correction remarks are mandatory.' });
      if (app.status !== 'Under_Review' && app.status !== 'Pending') {
        return res.status(400).json({ error: `Cannot return. Application is in "${app.status}" status.` });
      }
      await prisma.$transaction([
        prisma.application.update({ where: { id: applicationId }, data: { status: 'Correction_Required', updatedAt: new Date() } }),
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user.email, oldStatus: app.status, newStatus: 'Correction_Required', reviewerNotes: notes }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'APPLICATION_RETURNED_FOR_CORRECTION',
            details: `${req.user.role} returned application ${applicationId} for correction. Notes: ${notes}`
          }
        })
      ]);
      try { await sendMail(app.member.email, "correctionRequired", { name: app.member.fullName, reviewerNotes: notes }); } catch (e) {}
      return res.status(200).json({ message: 'Application returned to applicant for correction.' });

    } else if (action === 'ForwardToApprover') {
      if (userRole !== 'head_reviewer') {
        return res.status(403).json({ error: 'Only Head Reviewers can forward an application to the Approver.' });
      }
      if (app.status !== 'Under_Review') {
        return res.status(400).json({ error: `Cannot forward. Application is in "${app.status}" status.` });
      }
      
      // Check for at least 3 reviews
      const approverReturnCount = await prisma.applicationStatusHistory.count({
        where: { applicationId, oldStatus: 'Pending_Approval', newStatus: 'Under_Review' }
      });
      const reviewRound = approverReturnCount + 1;
      const reviewCount = await prisma.applicationReview.count({ where: { applicationId, reviewRound } });
      if (reviewCount < 3) {
         return res.status(400).json({ error: 'At least 3 reviews are required before forwarding to the Approver.' });
      }

      const userEmail = req.user!.email;
      const userId = req.user!.id;

      await prisma.$transaction(async (tx) => {
        await tx.application.update({ where: { id: applicationId }, data: { status: 'Pending_Approval', updatedAt: new Date() } });
        await tx.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: userEmail, oldStatus: 'Under_Review', newStatus: 'Pending_Approval', reviewerNotes: notes?.trim() || null }
        });
        await tx.applicationReview.upsert({
          where: { applicationId_reviewerId_reviewRound: { applicationId, reviewerId: userId, reviewRound } },
          create: { applicationId, reviewerId: userId, reviewRound, notes, complianceStatus: 'Compliant' },
          update: { notes, updatedAt: new Date() }
        });
        await tx.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: userEmail,
            actionType: 'APPLICATION_FORWARDED_TO_APPROVER',
            details: `${req.user!.role} forwarded application ${applicationId} to the Approver after ${reviewCount} reviews.${notes?.trim() ? ` Notes: ${notes.trim()}` : ''}`
          }
        });
      });
      return res.status(200).json({ message: 'Application forwarded to Approver queue.' });

    } else if (action === 'ForwardToReviewers') {
      if (userRole !== 'admin' && userRole !== 'admin_assistant') {
        return res.status(403).json({ error: 'Access Denied. Only Admins or Admin Assistants can forward applications to reviewers.' });
      }
      if (app.status !== 'Pending') {
        return res.status(400).json({ error: `Cannot forward. Application is in "${app.status}" status.` });
      }

      await prisma.$transaction([
        prisma.application.update({ where: { id: applicationId }, data: { status: 'Under_Review', updatedAt: new Date() } }),
        prisma.applicationReview.deleteMany({ where: { applicationId } }), // Clear old review notes for the new round
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user!.email, oldStatus: app.status, newStatus: 'Under_Review', reviewerNotes: notes || null }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user!.email,
            actionType: 'APPLICATION_FORWARDED_TO_REVIEWERS',
            details: `${req.user!.role} forwarded application ${applicationId} to the Review Team.${notes ? ` Note: ${notes}` : ''}`
          }
        })
      ]);
      try {
        await sendMail(app.member.email, 'applicationForwardedToCommittee', {
          name: app.member.fullName,
        });
      } catch (mailErr: any) {
        console.warn('[Reviewer Action] Committee forwarding email failed:', mailErr.message);
      }
      return res.status(200).json({ message: 'Application forwarded to Review Team.' });
    }

    return res.status(400).json({ error: 'Invalid action. Valid reviewer actions: SubmitReviewNote, ReturnForCorrection, ForwardToApprover, ForwardToReviewers.' });
  } catch (error: any) {
    console.error('[Reviewer Action] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error processing reviewer action.' });
  }
}

// 2c. Approver Final Decision (Approver / Admin only)
// Actions: Approve | Reject
export async function handleApproverDecision(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const userRole = req.user.role.toLowerCase();
  if (!['approver', 'admin'].includes(userRole)) {
    return res.status(403).json({ error: 'Access Denied. Only Approvers can make final membership decisions.' });
  }

  const { applicationId, action, notes } = req.body;
  if (!applicationId || !action) {
    return res.status(400).json({ error: 'Missing mandatory parameters: applicationId and action.' });
  }

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { 
        member: true, 
        category: true,
        financialTransactions: {
          where: { txType: 'Processing_Fee' },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    if (!app) return res.status(404).json({ error: 'Application record not found.' });

    if (app.status !== 'Pending_Approval') {
      return res.status(400).json({ error: `Application must be in "Pending_Approval" status. Currently: "${app.status}".` });
    }

    const oldStatus = app.status;

    if (action === 'Approve') {

      const txOps: any[] = [
        prisma.application.update({ where: { id: applicationId }, data: { status: 'Approved', approvedAt: new Date(), updatedAt: new Date() } }),
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user.email, oldStatus, newStatus: 'Approved', reviewerNotes: notes || 'Application approved.' }
        }),
        prisma.auditLog.create({
          data: { memberId: app.memberId, actionByEmail: req.user.email, actionType: 'APPROVE', details: 'Application approved. Membership credentials will be issued after first-year fee clearance.' }
        })
      ];

      if (app.category.firstYearFee && Number(app.category.firstYearFee) > 0) {
        txOps.push(
          prisma.financialTransaction.create({
            data: {
              memberId: app.memberId,
              applicationId: applicationId,
              amount: app.category.firstYearFee,
              currency: (app.category.currency || 'RWF') as string,
              txType: 'First_Year_Fee',
              paymentMethod: 'Bank_Transfer',
              transactionReference: `INV-${applicationId.slice(0, 8)}-${new Date().getFullYear()}`,
              status: 'Unpaid'
            }
          })
        );
      }

      await prisma.$transaction(txOps);

      const paymentsUrl = 'https://ricos.rwandaiqs.org/dashboard/payments';
      try { await sendMail(app.member.email, "approved", { name: app.member.fullName, category: app.category.categoryName, paymentsUrl }); } catch (e) {}
      
      if (app.category.firstYearFee && Number(app.category.firstYearFee) > 0) {
        try { await sendMail(app.member.email, "invoice_generated", { name: app.member.fullName, txType: "First Year Membership Fee", amount: app.category.firstYearFee, currency: app.category.currency || 'RWF', reference: `INV-${applicationId.slice(0, 8)}-${new Date().getFullYear()}`, paymentsUrl }); } catch (e) {}
      }
      
      return res.status(200).json({ message: 'Application approved. The first-year fee invoice is ready; membership credentials will be issued after payment clearance.' });

    } else if (action === 'ReturnForCorrection') {
      if (!notes?.trim()) {
        return res.status(400).json({ error: 'Correction remarks are mandatory.' });
      }

      await prisma.$transaction([
        prisma.application.update({
          where: { id: applicationId },
          // Approval-stage corrections go back to the reviewer committee.
          // Reviewers decide whether a correction must be requested from the applicant.
          data: { status: 'Under_Review', updatedAt: new Date() }
        }),
        prisma.applicationStatusHistory.create({
          data: {
            applicationId,
            changedByEmail: req.user.email,
            oldStatus,
            newStatus: 'Under_Review',
            reviewerNotes: notes
          }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'APPLICATION_RETURNED_TO_REVIEWERS',
            details: `${req.user.role} returned application ${applicationId} to the reviewer committee for reassessment. Notes: ${notes}`
          }
        })
      ]);

      return res.status(200).json({ message: 'Application returned to the reviewer committee for reassessment.' });

    } else if (action === 'Reject') {
      if (!notes) return res.status(400).json({ error: 'Rejection notes are mandatory.' });

      await prisma.$transaction([
        prisma.application.update({ where: { id: applicationId }, data: { status: 'Rejected', updatedAt: new Date() } }),
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user.email, oldStatus, newStatus: 'Rejected', reviewerNotes: notes }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'APPLICATION_REJECTED',
            details: `${req.user.role} rejected application ${applicationId}. Notes: ${notes}`
          }
        })
      ]);

      try { await sendMail(app.member.email, "rejected", { name: app.member.fullName, reason: notes }); } catch (e) {}
      return res.status(200).json({ message: 'Application rejected. Notification sent.' });
    }

    return res.status(400).json({ error: 'Invalid action. Approver actions: Approve, Reject.' });
  } catch (error: any) {
    console.error('[Approver Decision] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error processing approver decision.' });
  }
}


// 3. Get Full Application Detail (Side-by-Side Review Workspace)
export async function getApplicationDetail(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id } = req.params;

  try {
    const app = await prisma.application.findUnique({
      where: { id },
      include: {
        member: true,
        category: true,
        educationRecords: { orderBy: { startDate: 'desc' } },
        employmentRecords: { orderBy: { startDate: 'desc' } },
        firmShareholders: true,
        mentorshipAssignment: true,
        uploadedDocuments: true,
        studentAssociation: true,
        logbookEntries: { orderBy: { createdAt: 'desc' } },
        statusHistory: { orderBy: { createdAt: 'desc' } },
        financialTransactions: {
          where: { txType: 'Processing_Fee' },
          orderBy: { createdAt: 'desc' }
        },
        applicationReviews: {
          include: {
            reviewer: {
              select: { fullName: true }
            }
          },
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!app) return res.status(404).json({ error: 'Application not found.' });

    // A member can have several Processing_Fee rows (a rejected manual receipt
    // upload alongside a mobile-money attempt that later succeeded, etc). A Paid
    // one is authoritative — the fee is settled — regardless of anything else
    // that failed before or after it.
    const processingFeeTx = pickAuthoritativeTransaction(app.financialTransactions);

    // Keep legacy applications readable while a deployment is being upgraded.
    // The reviewer-board table is additive; an old database may not have it yet.
    let mentorshipReviews: any[] = [];
    try {
      mentorshipReviews = await prisma.$queryRaw<any[]>`
        SELECT mr.id, mr.application_id AS "applicationId",
               mr.mentorship_assignment_id AS "mentorshipAssignmentId",
               mr.reviewer_id AS "reviewerId", mr.recommendation,
               mr.compliance_status AS "complianceStatus",
               mr.review_period_start AS "reviewPeriodStart",
               mr.review_period_end AS "reviewPeriodEnd",
               mr.review_period_months AS "reviewPeriodMonths",
               mr.proposed_assessment_date AS "proposedAssessmentDate",
               mr.notes, mr.created_at AS "createdAt", mr.updated_at AS "updatedAt",
               json_build_object('fullName', m.full_name, 'systemRole', m.system_role) AS reviewer
        FROM mentorship_reviews mr
        JOIN members m ON m.id = mr.reviewer_id
        WHERE mr.application_id = ${id}::uuid
        ORDER BY mr.created_at ASC
      `;
    } catch (reviewTableError: any) {
      if (!String(reviewTableError?.message || '').toLowerCase().includes('mentorship_reviews')) throw reviewTableError;
      console.warn('[Admin Application Detail] mentorship_reviews table is not deployed yet; returning no board reviews.');
    }

    // Format to match existing payload structure for frontend compatibility
    const formattedApplication = {
      ...app,
      full_name: app.member.fullName,
      email: app.member.email,
      phone_number: app.member.phoneNumber,
      date_of_birth: app.member.dateOfBirth,
      gender: app.member.gender,
      nationality: app.member.nationality,
      national_id_or_passport: app.member.nationalIdOrPassport,
      residency_address: app.member.residencyAddress,
      work_address: app.member.workAddress,
      years_in_profession: app.member.yearsInProfession,
      country_of_origin: app.member.countryOfOrigin,
      membership_id: app.member.membershipId,
      membership_class: app.member.membershipClass,
      training_tracking_number: app.member.trainingTrackingNumber,
      category_name: app.category.categoryName,
      category_code: app.category.categoryCode,
      processing_fee: app.category.processingFee,
      first_year_fee: app.category.firstYearFee,
      annual_renewal_fee: app.category.annualRenewalFee,
      stamp_fee: app.category.stampFee,
      currency: app.category.currency,
      location: app.category.location,
      cat_entity_type: app.category.entityType,
      processing_fee_cleared: processingFeeTx?.status === 'Paid',
      processing_fee_tx_id: processingFeeTx?.id || null,
      processing_fee_status: processingFeeTx?.status || null
    };

    const categoryDocs = [
      ...((app.category?.requiredDocuments as Array<any>) || []),
      ...((app.category?.optionalDocuments as Array<any>) || [])
    ];

    const typeCounts: Record<string, number> = {};
    const categoryDocsWithUid = categoryDocs.map(doc => {
      const base = doc.typeCode || (doc.name ? doc.name.toLowerCase().replace(/[^a-z0-9]/g, "_") : "unknown");
      typeCounts[base] = (typeCounts[base] || 0) + 1;
      const uid = typeCounts[base] > 1 ? `${base}_${typeCounts[base]}` : base;
      return { ...doc, uid };
    });

    const mappedDocuments = app.uploadedDocuments.map((doc: any) => {
      let docName = doc.documentType;
      const matched = categoryDocsWithUid.find(c => c.uid === doc.documentType);
      if (matched && matched.name) {
        docName = matched.name;
      }
      return {
        ...doc,
        documentName: docName
      };
    });

    return res.status(200).json({
      application: formattedApplication,
      education: app.educationRecords,
      employment: app.employmentRecords,
      shareholders: app.firmShareholders,
      mentorship: app.mentorshipAssignment,
      documents: mappedDocuments,
      categoryDocuments: categoryDocsWithUid,
      studentAssociation: app.studentAssociation,
      logbookEntries: app.logbookEntries,
      statusHistory: app.statusHistory,
      applicationReviews: app.applicationReviews,
      mentorshipReviews
    });
  } catch (error: any) {
    console.error('[Admin Application Detail] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching application detail.' });
  }
}

// 4. Assign Reviewer to Application
export async function assignReviewer(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId } = req.body;
  const reviewerId = req.body.reviewerId || req.user.id;

  if (!applicationId) return res.status(400).json({ error: 'Missing applicationId.' });

  try {
    const app = await prisma.application.update({
      where: { id: applicationId },
      data: { assignedReviewerId: reviewerId, updatedAt: new Date() }
    });

    await prisma.auditLog.create({
      data: {
        memberId: app.memberId,
        actionByEmail: req.user.email,
        actionType: 'REVIEWER_ASSIGNED',
        details: `Reviewer ${reviewerId} assigned to application ${applicationId}.`
      }
    });

    return res.status(200).json({ message: 'Reviewer assigned.', application: app });
  } catch (error: any) {
    console.error('[Assign Reviewer] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error assigning reviewer.' });
  }
}

// 5. Get Application Status History (Audit Timeline)
export async function getStatusHistory(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { applicationId } = req.params;

  try {
    const history = await prisma.applicationStatusHistory.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' }
    });
    return res.status(200).json({ history });
  } catch (error: any) {
    console.error('[Get Status History] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching status history.' });
  }
}

// 6. Get Document Version History (Correction comparison audit)
export async function getDocumentVersions(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { applicationId } = req.params;

  try {
    const versions = await prisma.documentVersion.findMany({
      where: { applicationId },
      orderBy: [{ documentType: 'asc' }, { versionNumber: 'desc' }]
    });
    return res.status(200).json({ versions });
  } catch (error: any) {
    console.error('[Get Document Versions] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching document versions.' });
  }
}

// 7. Get Audit Logs (Admin Only)
export async function getAuditLogs(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const userRole = req.user.role.toLowerCase();
  if (userRole !== 'admin') {
    return res.status(403).json({ error: 'Access Denied. Only Admins can view system audit logs.' });
  }

  const { page = '1', limit = '50', actionType } = req.query;
  const skip = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);
  const take = parseInt(limit as string, 10);

  try {
    const whereClause: any = {};
    if (actionType) whereClause.actionType = actionType;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          member: { select: { fullName: true, email: true } }
        }
      }),
      prisma.auditLog.count({ where: whereClause })
    ]);

    return res.status(200).json({
      logs,
      pagination: { total, page: parseInt(page as string, 10), limit: take }
    });
  } catch (error: any) {
    console.error('[Get Audit Logs] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching audit logs.' });
  }
}

// 8. Get APC Assessment History for a Specific Application (Admin Only)
export async function getApcForApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId } = req.params;

  try {
    const assessments = await prisma.apcAssessment.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
      include: {
        application: {
          select: {
            member: {
              select: {
                fullName: true,
                email: true,
              }
            }
          }
        }
      }
    });

    return res.status(200).json({ assessments });
  } catch (error: any) {
    console.error('[Get Admin APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching APC progression records.' });
  }
}

// 8b. Get ALL APC Assessments (System-wide, for dedicated APC module)
export async function getAllApc(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { status, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const whereClause: any = {};
  if (status && status !== 'all') {
    // Support comma-separated statuses e.g. "Passed,Failed,No_Show"
    const statuses = String(status).split(',').map(s => s.trim());
    whereClause.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  }

  try {
    const [assessments, total] = await Promise.all([
      prisma.apcAssessment.findMany({
        where: whereClause,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          member: { select: { fullName: true, email: true, membershipId: true, membershipClass: true, isFellow: true, isHonorary: true, honors: true } },
          application: {
            select: {
              id: true,
              category: { select: { categoryName: true, categoryCode: true, stampFee: true } },
              uploadedDocuments: true,
              mentorshipAssignment: { select: { agreedReviewPeriodStart: true, agreedReviewPeriodEnd: true } }
            }
          }
        }
      }),
      prisma.apcAssessment.count({ where: whereClause })
    ]);

    const formattedAssessments = assessments.map((a: any) => ({
      ...a,
      isFellow: a.member.isFellow,
      isHonorary: a.member.isHonorary,
      honors: a.member.honors || [],
      boardRecommendedPeriodStart: a.application?.mentorshipAssignment?.agreedReviewPeriodStart || null,
      boardRecommendedPeriodEnd: a.application?.mentorshipAssignment?.agreedReviewPeriodEnd || null
    }));

    return res.status(200).json({ assessments: formattedAssessments, pagination: { total, page: Number(page), limit: take } });
  } catch (error: any) {
    console.error('[Get All APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching all APC records.' });
  }
}

// 9. Update System Membership Category Parameters (Admin Only)
export async function updateSystemCategory(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const userRole = req.user.role.toLowerCase();
  if (userRole !== 'admin') {
    return res.status(403).json({ error: 'Access Denied. Only Admins can update system parameters.' });
  }

  const { id } = req.params;
  const { processingFee, firstYearFee, annualRenewalFee, stampFee, requiredDocuments } = req.body;

  try {
    const category = await prisma.membershipCategory.findUnique({ where: { id } });
    if (!category) return res.status(404).json({ error: 'Membership category not found.' });

    const updatedCategory = await prisma.membershipCategory.update({
      where: { id },
      data: {
        ...(processingFee !== undefined && { processingFee }),
        ...(firstYearFee !== undefined && { firstYearFee }),
        ...(annualRenewalFee !== undefined && { annualRenewalFee }),
        ...(stampFee !== undefined && { stampFee }),
        ...(requiredDocuments !== undefined && Array.isArray(requiredDocuments) && { requiredDocuments }),
      }
    });

    await prisma.auditLog.create({
      data: {
        actionByEmail: req.user.email,
        actionType: 'SYSTEM_PARAM_UPDATE',
        details: `Updated parameters for category ${category.categoryCode}`
      }
    });

    return res.status(200).json({ message: 'Category parameters updated successfully.', category: updatedCategory });
  } catch (error: any) {
    console.error('[Update System Category] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error updating category parameters.' });
  }
}

export async function getMembersRegistry(req: AuthenticatedRequest, res: Response) {
  const { q, status, category, location, sortKey = 'name', sortDir = 'asc', page = 1, limit = 10 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    // Built as an AND array (rather than assigning top-level keys directly) so the search
    // OR-group below can't collide with the status filter's own OR-group added further down.
    const andConditions: any[] = [{ membershipId: { not: null } }];

    if (q) {
      const qs = String(q);
      andConditions.push({
        OR: [
          { fullName: { contains: qs, mode: 'insensitive' } },
          { email: { contains: qs, mode: 'insensitive' } },
          { membershipId: { contains: qs, mode: 'insensitive' } },
        ]
      });
    }

    const appFilter: any = { status: 'Approved' };
    let hasAppFilter = false;

    if (category && category !== 'all') {
      appFilter.category = { categoryName: String(category) };
      hasAppFilter = true;
    }
    if (location && location !== 'all') {
      appFilter.practiceLocation = String(location);
      hasAppFilter = true;
    }

    if (hasAppFilter) {
      andConditions.push({ applications: { some: appFilter } });
    }

    // Status filter — mirrors the same Active/Pending Payment/In Mentorship/Expired
    // vocabulary the response below computes and the Members page renders distinct badges
    // for (see memberStatusWhereConditions). This previously only ever recognized the literal
    // string 'active' (and even then applied no actual filter — it just skipped returning an
    // empty list) — every other option (Pending Payment / In Mentorship / Expired)
    // unconditionally came back with zero rows regardless of how many members matched.
    if (status && status !== 'all') {
      // An unrecognized status value returns [] here — behaves like 'all' rather than
      // silently returning nothing, so an unexpected value is at worst a no-op.
      andConditions.push(...memberStatusWhereConditions(String(status)));
    }

    const whereClause: any = { AND: andConditions };

    let orderBy: any = {};
    const dir = String(sortDir).toLowerCase() === 'desc' ? 'desc' : 'asc';

    if (sortKey === 'name') orderBy.fullName = dir;
    else if (sortKey === 'id') orderBy.membershipId = dir;
    else if (sortKey === 'expiry') orderBy.membershipExpiresAt = dir;
    else orderBy.createdAt = dir; // 'joined' and any other fallback

    const [members, total] = await Promise.all([
      prisma.member.findMany({
        where: whereClause,
        skip,
        take,
        orderBy,
        include: {
          applications: {
            where: { status: 'Approved' },
            orderBy: { approvedAt: 'desc' },
            take: 1,
            include: {
              category: true,
              uploadedDocuments: {
                where: { documentType: { in: ['Passport_Photo', 'PassportPhoto'] } },
                take: 1
              }
            }
          },
          financialTransactions: {
            where: { txType: 'Processing_Fee' },
            orderBy: { createdAt: 'desc' }
          }
        }
      }),
      prisma.member.count({ where: whereClause })
    ]);

    const mapped = members.map(m => {
      const app = m.applications[0];
      // A Paid Processing_Fee row is authoritative even if a different, older or
      // newer, attempt for the same fee ended up Failed (rejected receipt upload,
      // failed gateway retry, etc) — see pickAuthoritativeTransaction.
      const processingFeeTx = pickAuthoritativeTransaction(m.financialTransactions);
      const hasPaid = processingFeeTx?.status === 'Paid';
      const isExpired = Boolean(m.membershipExpiresAt && m.membershipExpiresAt < new Date());

      // Mirrors the status filter above and the distinct badges the Members page renders
      // for each of these four values — keep the two in sync.
      let memberStatus: 'Active' | 'Pending Payment' | 'In Mentorship' | 'Expired';
      if (!hasPaid) memberStatus = 'Pending Payment';
      else if (isExpired) memberStatus = 'Expired';
      else if (m.membershipClass === 'Graduate') memberStatus = 'In Mentorship';
      else memberStatus = 'Active';

      return {
        id: m.id,
        fullName: m.fullName,
        email: m.email,
        membershipId: m.membershipId,
        category: app?.category?.categoryName || m.membershipClass || 'N/A',
        categoryId: app?.category?.id || null,
        practiceLocation: app?.practiceLocation || 'Rwandan',
        country: m.countryOfOrigin,
        status: memberStatus,
        expiresAt: m.membershipExpiresAt
          ? m.membershipExpiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
          : 'N/A',
        photoId: app?.uploadedDocuments?.[0]?.id,
        isFellow: m.isFellow,
        isHonorary: m.isHonorary,
        honors: (m as any).honors || [],
        membershipClass: m.membershipClass,
        systemRole: m.systemRole,
      };
    });

    return res.status(200).json({
      members: mapped,
      pagination: { total, page: Number(page), limit: take }
    });
  } catch (error: any) {
    console.error('[Get Members Registry Error]:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching members registry.' });
  }
}

// 9. Send Admin Custom/Bulk Email via SMTP
export async function sendAdminEmail(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  // Mirrors the role list on the route itself (adminRoutes.ts POST /email/send) — this
  // redundant check previously used its own, out-of-sync list (missing admin_assistant and
  // head_reviewer despite the route already allowing them), so requests from those roles hit
  // a confusing "Only Admins can send..." 403 after already clearing RBAC on the way in.
  const userRole = req.user.role.toLowerCase();
  if (!['admin', 'admin_assistant', 'reviewer', 'head_reviewer', 'approver'].includes(userRole)) {
    return res.status(403).json({ error: 'Access Denied. You do not have permission to send broadcast/custom emails.' });
  }

  const { recipientType, recipientEmail, groupFilter, subject, body } = req.body;

  if (!recipientType || !subject || !body) {
    return res.status(400).json({ error: 'Missing required fields: recipientType, subject, or body.' });
  }

  try {
    const { sendRawMail } = await import('../config/mailer');

    const files = req.files as Express.Multer.File[];
    const mailAttachments = files?.map(f => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype
    })) || [];

    if (recipientType === 'single') {
      if (!recipientEmail) {
        return res.status(400).json({ error: 'Recipient email is required for single mode.' });
      }

      await sendRawMail({
        to: recipientEmail,
        subject,
        html: body,
        attachments: mailAttachments
      });

      // Log audit
      await prisma.auditLog.create({
        data: {
          actionByEmail: req.user.email,
          actionType: 'ADMIN_EMAIL_SEND',
          details: `Sent custom email to ${recipientEmail} with subject: "${subject}"`
        }
      });

      return res.status(200).json({ message: 'Email sent successfully.' });

    } else if (recipientType === 'bulk' || recipientType === 'selected') {
      let members: any[] = [];

      if (recipientType === 'selected') {
        const { memberIds } = req.body;
        let ids: string[] = [];
        try {
          ids = typeof memberIds === 'string' ? JSON.parse(memberIds) : memberIds;
        } catch (e) {
          ids = memberIds;
        }

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'memberIds array is required for selected mode.' });
        }

        members = await prisma.member.findMany({
          where: { id: { in: ids } },
          select: { email: true, fullName: true }
        });
      } else {
        if (!groupFilter) {
          return res.status(400).json({ error: 'Group filter is required for bulk mode.' });
        }

        // Shares the exact same Active/Pending Payment/In Mentorship/Expired logic as the
        // Members page filter (see memberStatusWhereConditions) — this previously used its
        // own fabricated conditions: 'active' applied no filter at all (silently emailing
        // everyone regardless of the group picked), 'mentorship' queried a field
        // (`mentorshipAssignment`) that only exists on Application, not Member, so it threw a
        // Prisma error on every attempt, and 'expired' checked yearsInProfession as a
        // "// Simulation" placeholder that was never replaced with real logic.
        const whereClause: any = {
          AND: [{ membershipId: { not: null } }, ...memberStatusWhereConditions(String(groupFilter))]
        };

        members = await prisma.member.findMany({
          where: whereClause,
          select: { email: true, fullName: true }
        });
      }

      if (members.length === 0) {
        return res.status(400).json({ error: 'No recipients found matching the filter.' });
      }

      // Send to all matching members
      const sendPromises = members.map(member => 
        sendRawMail({
          to: member.email,
          subject,
          html: body.replace(/\{\{name\}\}/g, member.fullName),
          attachments: mailAttachments
        }).catch(err => {
          console.error(`Failed to send email to ${member.email}:`, err.message);
        })
      );

      await Promise.all(sendPromises);

      // Log audit
      await prisma.auditLog.create({
        data: {
          actionByEmail: req.user.email,
          actionType: 'ADMIN_EMAIL_BULK_SEND',
          details: `Sent bulk email to ${members.length} members with subject: "${subject}"`
        }
      });

      return res.status(200).json({ message: `Bulk email sent successfully to ${members.length} recipients.` });
    }

    return res.status(400).json({ error: 'Invalid recipientType.' });
  } catch (error: any) {
    console.error('[Send Admin Email Error]:', error.message);
    return res.status(500).json({ error: 'Internal server error while sending email.' });
  }
}

// Fetch internal staff members (Admin, Reviewer, Approver, Teacher)
export async function getStaffMembers(req: AuthenticatedRequest, res: Response) {
  try {
    const staff = await prisma.member.findMany({
      where: {
        systemRole: {
          in: ['Admin', 'Admin_Assistant', 'Head_Reviewer', 'Reviewer', 'Approver', 'Teacher']
        }
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        systemRole: true,
        isLocked: true,
        lockedUntil: true,
        createdAt: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    return res.status(200).json({ staff });
  } catch (error: any) {
    console.error('[Get Staff Members Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching staff members.' });
  }
}

// Create a new staff member account
export async function createStaffMember(req: AuthenticatedRequest, res: Response) {
  const { fullName, email, systemRole } = req.body;
  
  if (!fullName || !email || !systemRole) {
    return res.status(400).json({ error: 'Missing required fields: fullName, email, systemRole' });
  }

  const validRoles = ['Admin', 'Admin_Assistant', 'Head_Reviewer', 'Reviewer', 'Approver', 'Teacher'];
  if (!validRoles.includes(systemRole)) {
    return res.status(400).json({ error: 'Invalid system role provided for staff creation.' });
  }

  if (req.user?.role.toLowerCase() === 'approver' && systemRole !== 'Admin_Assistant') {
    return res.status(403).json({ error: 'Approvers can only create Admin Assistant accounts.' });
  }

  try {
    const existing = await prisma.member.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'A member with this email already exists.' });
    }

    // Generate a temporary 8-character password
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let temporaryPassword = '';
    for (let i = 0; i < 10; i++) {
      temporaryPassword += charset[Math.floor(Math.random() * charset.length)];
    }

    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    const id = uuidv4();

    const newStaff = await prisma.member.create({
      data: {
        id,
        email,
        passwordHash,
        fullName,
        systemRole: systemRole as any,
        isEmailVerified: true, // Pre-verify internal staff
        resetPasswordOtp: 'CHANGE',
        resetPasswordExpires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        systemRole: true,
        createdAt: true
      }
    });

    return res.status(201).json({
      message: 'Staff account created successfully.',
      staff: newStaff,
      temporaryPassword // We return it so the UI can display it
    });
  } catch (error: any) {
    console.error('[Create Staff Member Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while creating staff member.' });
  }
}

// Lock a staff member account instead of deleting
export async function lockStaffMember(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;
  const { durationDays } = req.body;

  try {
    const staff = await prisma.member.findUnique({ where: { id } });
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found.' });
    }

    const validRoles = ['Admin', 'Admin_Assistant', 'Head_Reviewer', 'Reviewer', 'Approver', 'Teacher'];
    if (!staff.systemRole || !validRoles.includes(staff.systemRole)) {
      return res.status(400).json({ error: 'Cannot lock a non-staff member through this endpoint.' });
    }

    // Prevent locking the currently logged-in admin
    if (req.user?.id === id) {
      return res.status(400).json({ error: 'You cannot lock your own account.' });
    }

    const days = parseInt(durationDays, 10);
    if (isNaN(days) || days <= 0) {
      return res.status(400).json({ error: 'Valid durationDays is required.' });
    }

    const lockedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await prisma.member.update({
      where: { id },
      data: { 
        isLocked: true,
        lockedUntil 
      }
    });

    await prisma.auditLog.create({
      data: {
        memberId: id,
        actionByEmail: req.user?.email || 'System',
        actionType: 'STAFF_LOCKED',
        details: `Staff member locked for ${days} days until ${lockedUntil.toISOString()}`
      }
    });

    return res.status(200).json({ message: `Staff member locked successfully for ${days} days.` });
  } catch (error: any) {
    console.error('[Lock Staff Member Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while locking staff member.' });
  }
}

// Unlock a staff member account
export async function unlockStaffMember(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;

  try {
    const staff = await prisma.member.findUnique({ where: { id } });
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found.' });
    }

    await prisma.member.update({
      where: { id },
      data: { 
        isLocked: false,
        lockedUntil: null 
      }
    });

    await prisma.auditLog.create({
      data: {
        memberId: id,
        actionByEmail: req.user?.email || 'System',
        actionType: 'STAFF_UNLOCKED',
        details: `Staff member account unlocked.`
      }
    });

    return res.status(200).json({ message: 'Staff member unlocked successfully.' });
  } catch (error: any) {
    console.error('[Unlock Staff Member Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while unlocking staff member.' });
  }
}

// Promote a Reviewer to Head_Reviewer (demotes existing Head_Reviewer to Reviewer first)
export async function promoteToHeadReviewer(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id } = req.params;

  try {
    const target = await prisma.member.findUnique({ where: { id } });
    if (!target) return res.status(404).json({ error: 'Staff member not found.' });

    if (target.systemRole !== 'Reviewer' && target.systemRole !== 'Head_Reviewer') {
      return res.status(400).json({ error: 'Only Reviewers can be promoted to Head Reviewer.' });
    }

    if (target.systemRole === 'Head_Reviewer') {
      return res.status(400).json({ error: 'This staff member is already the Head Reviewer.' });
    }

    // Find existing Head_Reviewer (if any) and demote them
    const existingHead = await prisma.member.findFirst({
      where: { systemRole: 'Head_Reviewer' }
    });

    await prisma.$transaction(async (tx) => {
      // Demote existing head first
      if (existingHead) {
        await tx.member.update({
          where: { id: existingHead.id },
          data: { systemRole: 'Reviewer' }
        });
      }
      // Promote target
      await tx.member.update({
        where: { id },
        data: { systemRole: 'Head_Reviewer' }
      });
      await tx.auditLog.create({
        data: {
          memberId: id,
          actionByEmail: req.user!.email,
          actionType: 'ROLE_CHANGE',
          details: `Promoted to Head_Reviewer${existingHead ? `. Previous head (${existingHead.email}) revoked.` : '.'}`
        }
      });
    });

    return res.status(200).json({
      message: 'Head Reviewer updated successfully.',
      previousHead: existingHead ? { id: existingHead.id, fullName: existingHead.fullName } : null
    });
  } catch (error: any) {
    console.error('[Promote Head Reviewer Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while updating Head Reviewer.' });
  }
}

// ─── Mentorship Queue ───────────────────────────────────────────────────────

// Get paginated list of Mentorship Upgrade candidates awaiting reviewer-board
// input, final Admin/Approver review, or already completed/corrected.
export async function getMentorshipQueue(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { page = 1, limit = 10, q, status, apcReadiness, location, category, sortKey, sortDir, sort = 'recent' } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    let mentorshipStatusFilter: any;
    const statusQuery = (status as string)?.toLowerCase();

    if (statusQuery === 'all' || !statusQuery) {
      mentorshipStatusFilter = { in: ['Pending_Reviewer_Board', 'Pending_Admin_Review', 'Approved', 'Correction_Required'] };
    } else if (statusQuery === 'pending') {
      mentorshipStatusFilter = { in: ['Pending_Reviewer_Board', 'Pending_Admin_Review'] };
    } else if (['pending_reviewer_board', 'pending_admin_review', 'correction_required'].includes(statusQuery)) {
      mentorshipStatusFilter = String(status);
    } else if (statusQuery === 'approved') {
      mentorshipStatusFilter = 'Approved';
    } else if (statusQuery === 'rejected' || statusQuery === 'flagged') {
      mentorshipStatusFilter = 'Correction_Required';
    }

    const whereClause: any = {
      mentorshipAssignment: { 
        status: mentorshipStatusFilter,
        upgradeRequested: true,
        ...(apcReadiness ? { apcReadiness: String(apcReadiness) } : {})
      }
    };

    if (location) {
      whereClause.category = { location: String(location) };
    }
    if (category) {
      whereClause.category = { ...(whereClause.category || {}), categoryName: { contains: String(category), mode: 'insensitive' } };
    }

    if (q) {
      whereClause.OR = [
        { member: { fullName: { contains: String(q), mode: 'insensitive' } } },
        { member: { email:    { contains: String(q), mode: 'insensitive' } } },
      ];
    }

    const [apps, total] = await Promise.all([
      prisma.application.findMany({
        where: whereClause,
        skip,
        take,
        orderBy: { submittedAt: String(sortDir).toLowerCase() === 'asc' || sort === 'oldest' ? 'asc' : 'desc' },
        include: {
          member:   { select: { fullName: true, email: true, isFellow: true, isHonorary: true, honors: true } },
          category: { select: { categoryName: true, location: true } },
          mentorshipAssignment: {
            select: {
              id: true,
              mentorName: true,
              apcReadiness: true,
              completedDurationMonths: true,
              upgradeRequested: true,
              status: true,
              yearOneReportUrl: true,
              yearTwoReportUrl: true,
              mentorRecommendationUrl: true
            }
          },
          uploadedDocuments: {
            where: { documentType: { in: ['Passport_Photo', 'PassportPhoto'] } },
            take: 1
          }
        }
      }),
      prisma.application.count({ where: whereClause })
    ]);

    const queue = apps.map(app => ({
      id:              app.id,
      member_id:       app.memberId,
      full_name:       app.member.fullName,
      email:           app.member.email,
      category_name:   app.category.categoryName,
      location:        app.category.location,
      submitted_at:    app.submittedAt,
      status:          app.mentorshipAssignment?.status || 'Pending_Admin_Review',
      mentor_name:     app.mentorshipAssignment?.mentorName || 'Unassigned',
      apc_readiness:   app.mentorshipAssignment?.apcReadiness || 'Unknown',
      duration_months: app.mentorshipAssignment?.completedDurationMonths || 0,
      photoId:         app.uploadedDocuments?.[0]?.id,
      isFellow:        app.member.isFellow,
      isHonorary:      app.member.isHonorary,
      honors:          (app.member as any).honors || []
    }));

    return res.status(200).json({
      queue,
      pagination: { total, page: Number(page), limit: take }
    });
  } catch (error: any) {
    console.error('[Mentorship Queue] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching mentorship queue.' });
  }
}

// ─── Mentorship reviewer board ─────────────────────────────────────────────
// Reviewers recommend an APC candidate and propose a date/time. The Head
// Reviewer is the only role that can forward a reviewed upgrade to the final
// Admin/Approver queue, after at least three independent reviews.
export async function submitMentorshipReview(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const role = req.user.role.toLowerCase();
  if (!['reviewer', 'head_reviewer'].includes(role)) {
    return res.status(403).json({ error: 'Only Reviewers and Head Reviewers can submit a mentorship board review.' });
  }

  const { applicationId, notes, proposedAssessmentDate, recommendation = 'Recommend', complianceStatus, reviewPeriodStart, reviewPeriodEnd } = req.body;
  if (!applicationId) return res.status(400).json({ error: 'Missing applicationId.' });

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { mentorshipAssignment: true }
    });
    if (!app?.mentorshipAssignment) return res.status(404).json({ error: 'Mentorship upgrade not found.' });
    if (app.mentorshipAssignment.status !== 'Pending_Reviewer_Board') {
      return res.status(400).json({ error: `This upgrade is not awaiting reviewer-board input. Current status: ${app.mentorshipAssignment.status}.` });
    }

    // The two routes collect entirely different reviewer-board input:
    //  - Professional/Technologist (apcReadiness === 'Ready'): a recommended APC
    //    assessment period, plus an optional note. No compliance verdict.
    //  - Associate (apcReadiness === 'Not_Ready'): a Compliant/Non-compliant verdict
    //    (notes required only when Non-compliant). No assessment period.
    const isApcRoute = app.mentorshipAssignment.apcReadiness === 'Ready';
    let periodStart: Date | null = null;
    let periodEnd: Date | null = null;
    let proposedDate: Date | null = null;
    let verdict: string | null = null;

    if (isApcRoute) {
      periodStart = parseReviewMonth(reviewPeriodStart);
      periodEnd = reviewPeriodEnd ? parseReviewMonth(reviewPeriodEnd) : null;
      if (!periodStart || (reviewPeriodEnd && !periodEnd)) {
        return res.status(400).json({ error: 'Select a valid review start month and optional end month.' });
      }
      if (periodEnd && periodEnd < periodStart) {
        return res.status(400).json({ error: 'The review end month cannot be before the start month.' });
      }
      proposedDate = proposedAssessmentDate ? new Date(proposedAssessmentDate) : null;
      if (proposedDate && Number.isNaN(proposedDate.getTime())) {
        return res.status(400).json({ error: 'The proposed assessment date is invalid.' });
      }
    } else {
      if (!['Compliant', 'Non-compliant'].includes(complianceStatus)) {
        return res.status(400).json({ error: 'Select whether the mentorship submission is Compliant or Non-compliant.' });
      }
      if (complianceStatus === 'Non-compliant' && !notes?.trim()) {
        return res.status(400).json({ error: 'Review notes are required when marking a mentorship submission Non-compliant.' });
      }
      verdict = complianceStatus;
    }

    const existingReview = await prisma.mentorshipReview.findUnique({
      where: { applicationId_reviewerId: { applicationId, reviewerId: req.user.id } }
    });
    if (existingReview) {
      return res.status(409).json({ error: 'You have already submitted a reviewer-board recommendation for this mentorship upgrade.' });
    }

    const review = await prisma.$transaction(async (tx) => {
      const saved = await tx.mentorshipReview.create({
        data: {
          applicationId,
          mentorshipAssignmentId: app.mentorshipAssignment!.id,
          reviewerId: req.user!.id,
          recommendation,
          complianceStatus: verdict,
          reviewPeriodStart: periodStart,
          reviewPeriodEnd: periodEnd,
          proposedAssessmentDate: proposedDate,
          notes: notes?.trim() || null
        }
      });
      await tx.auditLog.create({
        data: {
          memberId: app.memberId,
          actionByEmail: req.user!.email,
          actionType: 'MENTORSHIP_REVIEW_SUBMITTED',
          details: isApcRoute
            ? `${req.user!.role} submitted an APC reviewer-board recommendation${proposedDate ? ` and proposed ${proposedDate.toISOString()}` : ''}.`
            : `${req.user!.role} submitted a ${verdict} mentorship board review.`
        }
      });
      return saved;
    });
    return res.status(200).json({ message: 'Mentorship board review saved.', review });
  } catch (error: any) {
    console.error('[Mentorship Review] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error saving mentorship board review.' });
  }
}

export async function forwardMentorshipToApprover(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  if (req.user.role.toLowerCase() !== 'head_reviewer') {
    return res.status(403).json({ error: 'Only the Head Reviewer can forward a mentorship upgrade to Admin/Approver.' });
  }
  const { applicationId, notes, agreedReviewPeriodStart, agreedReviewPeriodEnd, complianceStatus } = req.body;
  if (!applicationId) return res.status(400).json({ error: 'Missing applicationId.' });

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { mentorshipAssignment: true, mentorshipReviews: true }
    });
    if (!app?.mentorshipAssignment) return res.status(404).json({ error: 'Mentorship upgrade not found.' });
    if (app.mentorshipAssignment.status !== 'Pending_Reviewer_Board') {
      return res.status(400).json({ error: `This upgrade cannot be forwarded from status ${app.mentorshipAssignment.status}.` });
    }
    if (app.mentorshipReviews.length < 3) {
      return res.status(400).json({ error: 'At least 3 reviewer-board submissions are required before forwarding.' });
    }

    // Only the APC route (apcReadiness === 'Ready') has an assessment period to agree on.
    // The Associate route has no assessment period, but instead requires the Head
    // Reviewer's own final Compliant / Non-compliant conclusion for the Admin/Approver.
    const isApcRoute = app.mentorshipAssignment.apcReadiness === 'Ready';
    let agreedPeriodStart: Date | null = null;
    let agreedPeriodEnd: Date | null = null;
    let finalComplianceStatus: string | null = null;
    if (isApcRoute) {
      agreedPeriodStart = parseReviewMonth(agreedReviewPeriodStart);
      agreedPeriodEnd = agreedReviewPeriodEnd ? parseReviewMonth(agreedReviewPeriodEnd) : null;
      if (!agreedPeriodStart || (agreedReviewPeriodEnd && !agreedPeriodEnd)) {
        return res.status(400).json({ error: 'Select a valid final start month and optional end month.' });
      }
      if (agreedPeriodEnd && agreedPeriodEnd < agreedPeriodStart) {
        return res.status(400).json({ error: 'The final end month cannot be before the start month.' });
      }
    } else {
      if (!['Compliant', 'Non-compliant'].includes(complianceStatus)) {
        return res.status(400).json({ error: 'State whether the mentorship upgrade is Compliant or Non-compliant before forwarding.' });
      }
      if (complianceStatus === 'Non-compliant' && !notes?.trim()) {
        return res.status(400).json({ error: 'Forwarding notes are required when concluding Non-compliant.' });
      }
      finalComplianceStatus = complianceStatus;
    }

    const forwardingNotes = notes?.trim() || 'Forwarded by Head Reviewer after completion of the reviewer-board submissions.';

    await prisma.$transaction([
      prisma.mentorshipAssignment.update({
        where: { id: app.mentorshipAssignment.id },
        data: {
          status: 'Pending_Admin_Review',
          adminNotes: forwardingNotes,
          finalComplianceStatus,
          agreedReviewPeriodStart: agreedPeriodStart,
          agreedReviewPeriodEnd: agreedPeriodEnd
        }
      }),
      prisma.auditLog.create({
        data: {
          memberId: app.memberId,
          actionByEmail: req.user.email,
          actionType: 'MENTORSHIP_FORWARDED_TO_APPROVER',
          details: `Head Reviewer forwarded mentorship upgrade to Admin/Approver after ${app.mentorshipReviews.length} board reviews${finalComplianceStatus ? ` — final conclusion: ${finalComplianceStatus}` : ''}. Notes: ${forwardingNotes}`
        }
      })
    ]);
    return res.status(200).json({ message: 'Mentorship upgrade forwarded to the Admin/Approver queue.' });
  } catch (error: any) {
    console.error('[Forward Mentorship] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error forwarding mentorship upgrade.' });
  }
}

// Approve a Mentorship Upgrade: marks the assignment as Approved, creates an
// APC assessment record and returns its ID so the frontend can navigate directly.
export async function approveMentorshipUpgrade(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const userRole = req.user.role.toLowerCase();
  if (!['admin', 'approver'].includes(userRole)) {
    return res.status(403).json({ error: 'Access Denied. Only Admins or Approvers can approve mentorship upgrades.' });
  }

  const { applicationId, notes } = req.body;
  if (!applicationId) return res.status(400).json({ error: 'Missing applicationId.' });

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        member: true,
        category: true,
        mentorshipAssignment: true,
        apcAssessments: { where: { status: 'Requested' }, take: 1 }
      }
    });

    if (!app) return res.status(404).json({ error: 'Application not found.' });
    if (!app.mentorshipAssignment) return res.status(400).json({ error: 'No mentorship record found for this application.' });
    if (app.mentorshipAssignment.status !== 'Pending_Admin_Review') {
      return res.status(400).json({ error: `Mentorship assignment must be in Pending_Admin_Review status. Currently: ${app.mentorshipAssignment.status}` });
    }

    // 1. Mark the mentorship assignment as approved
    await prisma.mentorshipAssignment.update({
      where: { id: app.mentorshipAssignment.id },
      data: { status: 'Approved', adminNotes: notes || null }
    });

    if (app.mentorshipAssignment.apcReadiness === 'Not_Ready') {
      await prisma.auditLog.create({
        data: {
          memberId: app.memberId,
          actionByEmail: req.user.email,
          actionType: 'MENTORSHIP_UPGRADE_APPROVED',
          details: 'Mentorship upgrade approved. Ready for Associate award.'
        }
      });

      return res.status(200).json({
        message: 'Mentorship upgrade approved. Candidate successfully upgraded to Associate.',
        applicationId
      });
    }

    // 2. Create or reuse an APC assessment record in "Requested" state for Professional upgrades
    let apcAssessment = app.apcAssessments[0] || null;
    if (!apcAssessment) {
      apcAssessment = await prisma.apcAssessment.create({
        data: {
          memberId:      app.memberId,
          applicationId: applicationId,
          status:        'Requested'
        }
      });
    }

    // 3. Audit log
    await prisma.auditLog.create({
      data: {
        memberId:        app.memberId,
        actionByEmail:   req.user.email,
        actionType:      'MENTORSHIP_UPGRADE_APPROVED',
        details:         `Mentorship upgrade approved. APC assessment ${apcAssessment.id} created/reused.`
      }
    });

    return res.status(200).json({
      message:         'Mentorship upgrade approved. Candidate moved to APC queue.',
      apcAssessmentId: apcAssessment.id,
      applicationId
    });
  } catch (error: any) {
    console.error('[Approve Mentorship Upgrade] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error approving mentorship upgrade.' });
  }
}

// Flag a Mentorship Upgrade for Correction
export async function flagMentorshipForCorrection(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, notes } = req.body;
  if (!applicationId || !notes) return res.status(400).json({ error: 'Missing applicationId or correction notes.' });

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { member: true, mentorshipAssignment: true }
    });

    if (!app) return res.status(404).json({ error: 'Application not found.' });
    if (!app.mentorshipAssignment) return res.status(400).json({ error: 'No mentorship record found.' });

    await prisma.mentorshipAssignment.update({
      where: { id: app.mentorshipAssignment.id },
      data: { status: 'Correction_Required', adminNotes: notes }
    });

    await prisma.auditLog.create({
      data: {
        memberId:      app.memberId,
        actionByEmail: req.user.email,
        actionType:    'MENTORSHIP_FLAGGED',
        details:       `Mentorship upgrade flagged for correction. Notes: ${notes}`
      }
    });

    try {
      await sendMail(app.member.email, 'mentorship_flagged', {
        name:   app.member.fullName,
        reason: notes
      });
    } catch (e) {}

    return res.status(200).json({ message: 'Mentorship upgrade flagged for correction. Notification sent.' });
  } catch (error: any) {
    console.error('[Flag Mentorship] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error flagging mentorship upgrade.' });
  }
}

export async function getDashboardStats(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const userEmail = req.user!.email;
    const role = req.user!.role;

    async function getEnrichedActivity(whereClause: any) {
      const rawActivity = await prisma.auditLog.findMany({
        where: whereClause,
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: { member: { select: { fullName: true } } }
      });

      const emails = [...new Set(rawActivity.map((a: any) => a.actionByEmail))];
      const actors = await prisma.member.findMany({
        where: { email: { in: emails } },
        select: { email: true, fullName: true }
      });
      const actorMap: Record<string, string> = Object.fromEntries(actors.map((a: any) => [a.email, a.fullName]));

      return rawActivity.map((a: any) => {
        let cleanDetails = a.details ? a.details
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, '')
          .replace(/New\s+ID:\s*\.?/gi, '')
          .replace(/\.\s*\./g, '.')
          .replace(/\s{2,}/g, ' ')
          .replace(/\s+\./g, '.')
          .trim() : '';
        cleanDetails = cleanDetails.replace(/\s+/g, ' ').replace(/ \./g, '.').trim();

        return {
          actionByEmail: actorMap[a.actionByEmail] || a.actionByEmail.split('@')[0],
          actionType: a.actionType,
          details: a.member?.fullName ? `${cleanDetails} — ${a.member.fullName}` : cleanDetails,
          createdAt: a.createdAt
        };
      });
    }

    const stats: any = {};

    if (role === "Admin") {
      stats.admin = {
        totalMembers: await prisma.member.count(),
        pendingApplications: await prisma.application.count({ where: { status: { in: ['Pending', 'Under_Review', 'Pending_Approval'] } } }),
        pendingApc: await prisma.apcAssessment.count({ where: { status: { in: ['Requested', 'Scheduled'] } } }),
        unpaidInvoices: await prisma.financialTransaction.count({ where: { status: 'Unpaid' } }),
        mentorshipQueue: await prisma.mentorshipAssignment.count({ where: { upgradeRequested: true, status: { not: 'Approved' } } }),
      };

      const totalApproved = await prisma.application.count({ where: { status: 'Approved' } });
      const totalRejected = await prisma.application.count({ where: { status: 'Rejected' } });
      const totalSubmitted = await prisma.application.count();
      stats.admin.approvalRate = {
        approved: totalApproved,
        rejected: totalRejected,
        total: totalSubmitted
      };

      const currentYear = new Date().getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);

      const apps = await prisma.application.findMany({
        where: { createdAt: { gte: startOfYear } },
        select: { createdAt: true }
      });

      const approvals = await prisma.auditLog.findMany({
        where: { actionType: 'APPROVE', createdAt: { gte: startOfYear } },
        select: { createdAt: true }
      });

      const monthlyData: Record<string, { month: string, applications: number, approved: number }> = {};
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      
      for (let i = 0; i < 12; i++) {
        const key = `${currentYear}-${i}`;
        monthlyData[key] = { month: monthNames[i], applications: 0, approved: 0 };
      }

      apps.forEach(app => {
        if (app.createdAt) {
          const key = `${app.createdAt.getFullYear()}-${app.createdAt.getMonth()}`;
          if (monthlyData[key]) monthlyData[key].applications++;
        }
      });

      approvals.forEach(approval => {
        if (approval.createdAt) {
          const key = `${approval.createdAt.getFullYear()}-${approval.createdAt.getMonth()}`;
          if (monthlyData[key]) monthlyData[key].approved++;
        }
      });

      stats.admin.applicationsVsApprovals = Object.values(monthlyData);

      stats.admin.recentActivity = await getEnrichedActivity({});

      const rawRecentAdmin = await prisma.application.findMany({
        where: { status: { not: 'Draft' } },
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          member: { select: { fullName: true } },
          category: { select: { categoryName: true } }
        }
      });

      stats.admin.recentApplications = rawRecentAdmin.map(app => ({
        id: app.id,
        applicantName: app.member?.fullName || 'Unknown',
        category: app.category?.categoryName || 'Unknown',
        practiceLocation: app.practiceLocation || 'Local',
        status: app.status
      }));
    }

    if (role === "Admin_Assistant") {
      const currentYear = new Date().getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);
      const assistantApps = await prisma.application.findMany({
        where: { createdAt: { gte: startOfYear } },
        select: { createdAt: true }
      });
      const assistantForwards = await prisma.auditLog.findMany({
        where: {
          actionType: 'APPLICATION_FORWARDED_TO_REVIEWERS',
          createdAt: { gte: startOfYear }
        },
        select: { createdAt: true }
      });
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const monthlyData: Record<string, { month: string, applications: number, approved: number }> = {};

      for (let i = 0; i < 12; i++) {
        monthlyData[`${currentYear}-${i}`] = { month: monthNames[i], applications: 0, approved: 0 };
      }

      assistantApps.forEach(app => {
        if (!app.createdAt) return;
        const key = `${app.createdAt.getFullYear()}-${app.createdAt.getMonth()}`;
        if (monthlyData[key]) monthlyData[key].applications++;
      });

      assistantForwards.forEach(forward => {
        if (!forward.createdAt) return;
        const key = `${forward.createdAt.getFullYear()}-${forward.createdAt.getMonth()}`;
        if (monthlyData[key]) monthlyData[key].approved++;
      });

      const rawRecentAssistant = await prisma.application.findMany({
        where: { status: { in: ['Pending', 'Correction_Required', 'Under_Review'] } },
        take: 6,
        orderBy: { updatedAt: 'desc' },
        include: { member: { select: { fullName: true } }, category: { select: { categoryName: true } } }
      });
      stats.adminAssistant = {
        pendingApplications: await prisma.application.count({ where: { status: 'Pending' } }),
        correctionApplications: await prisma.application.count({ where: { status: 'Correction_Required' } }),
        forwardedApplications: await prisma.application.count({ where: { status: { in: ['Under_Review', 'Pending_Approval', 'Approved', 'Rejected'] } } }),
        applicationsVsApprovals: Object.values(monthlyData),
        recentApplications: rawRecentAssistant.map(app => ({
          id: app.id,
          applicantName: app.member?.fullName || 'Unknown',
          category: app.category?.categoryName || 'Unknown',
          practiceLocation: app.practiceLocation || 'Local',
          status: app.status
        })),
        recentActivity: await getEnrichedActivity({
          actionType: { in: ['APPLICATION_SUBMITTED', 'APPLICATION_RETURNED_FOR_CORRECTION', 'APPLICATION_FORWARDED_TO_REVIEWERS'] }
        })
      };
    }

    if (role === "Reviewer" || role.toLowerCase() === "head_reviewer") {
      // For reviewers: their relevant queue is Under_Review applications
      const myReviewNotes = await prisma.applicationReview.count({ where: { reviewerId: userId } });
      const myForwardedToApprover = await prisma.application.count({ where: { status: { in: ['Pending_Approval', 'Approved'] } } });
      const totalUnderReview = await prisma.application.count({ where: { status: 'Under_Review' } });

      const currentYear = new Date().getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);

      const reviewerApps = await prisma.application.findMany({
        where: { status: { in: ['Under_Review', 'Pending_Approval', 'Approved', 'Rejected', 'Correction_Required'] }, createdAt: { gte: startOfYear } },
        select: { createdAt: true }
      });

      // Graph: applications in reviewer queue vs ones forwarded to Approver
      const reviewerApprovals = await prisma.application.findMany({
        where: { status: { in: ['Pending_Approval', 'Approved'] }, updatedAt: { gte: startOfYear } },
        select: { updatedAt: true }
      });

      const monthlyData: Record<string, { month: string, applications: number, approved: number }> = {};
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      for (let i = 0; i < 12; i++) {
        const key = `${currentYear}-${i}`;
        monthlyData[key] = { month: monthNames[i], applications: 0, approved: 0 };
      }

      reviewerApps.forEach(app => {
        if (app.createdAt) {
          const key = `${app.createdAt.getFullYear()}-${app.createdAt.getMonth()}`;
          if (monthlyData[key]) monthlyData[key].applications++;
        }
      });

      reviewerApprovals.forEach(app => {
        if (app.updatedAt) {
          const key = `${app.updatedAt.getFullYear()}-${app.updatedAt.getMonth()}`;
          if (monthlyData[key]) monthlyData[key].approved++;
        }
      });

      const rawRecent = await prisma.application.findMany({
        where: { status: { in: ['Under_Review', 'Correction_Required'] } },
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          member: { select: { fullName: true } },
          category: { select: { categoryName: true } }
        }
      });

      stats.reviewer = {
        assignedApplications: totalUnderReview,
        pendingReviews: totalUnderReview,
        myReviewed: myReviewNotes,
        reviewRate: {
          forwarded: myForwardedToApprover,
          total: await prisma.application.count({ where: { status: { notIn: ['Draft', 'Pending'] } } })
        },
        totalReceived: await prisma.application.count({ where: { status: { notIn: ['Draft', 'Pending'] } } }),
        applicationsVsApprovals: Object.values(monthlyData),
        recentApplications: rawRecent.map(app => ({
          id: app.id,
          applicantName: app.member?.fullName || 'Unknown',
          category: app.category?.categoryName || 'Unknown',
          practiceLocation: app.practiceLocation || 'Local',
          status: app.status
        })),
        recentActivity: await getEnrichedActivity({
          actionType: { in: ['REVIEWER_ASSIGNED', 'APPROVE', 'REJECT', 'FLAG_FOR_CORRECTION', 'APPLICATION_SUBMITTED', 'REVIEW_NOTE_SUBMITTED', 'APPLICATION_FORWARDED_TO_APPROVER', 'APPLICATION_FORWARDED_TO_REVIEWERS'] }
        })
      };
    }

    if (role === "Approver") {
      const totalApprovedByMe = await prisma.auditLog.count({ where: { actionByEmail: userEmail, actionType: 'APPROVE' } });
      const totalRejectedByMe = await prisma.auditLog.count({ where: { actionByEmail: userEmail, actionType: 'REJECT' } });

      const currentYear = new Date().getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);

      const approverApps = await prisma.application.findMany({
        where: { status: { in: ['Pending_Approval', 'Approved', 'Rejected'] }, updatedAt: { gte: startOfYear } },
        select: { updatedAt: true }
      });

      const approverApprovals = await prisma.auditLog.findMany({
        where: { actionByEmail: userEmail, actionType: 'APPROVE', createdAt: { gte: startOfYear } },
        select: { createdAt: true }
      });

      const monthlyData: Record<string, { month: string, applications: number, approved: number }> = {};
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      for (let i = 0; i < 12; i++) {
        const key = `${currentYear}-${i}`;
        monthlyData[key] = { month: monthNames[i], applications: 0, approved: 0 };
      }

      approverApps.forEach(app => {
        if (app.updatedAt) {
          const key = `${app.updatedAt.getFullYear()}-${app.updatedAt.getMonth()}`;
          if (monthlyData[key]) monthlyData[key].applications++;
        }
      });

      approverApprovals.forEach(app => {
        if (app.createdAt) {
          const key = `${app.createdAt.getFullYear()}-${app.createdAt.getMonth()}`;
          if (monthlyData[key]) monthlyData[key].approved++;
        }
      });

      const rawRecent = await prisma.application.findMany({
        where: { status: 'Pending_Approval' },
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          member: { select: { fullName: true } },
          category: { select: { categoryName: true } }
        }
      });

      const totalSubmitted = await prisma.application.count();
      const totalApprovedSys = await prisma.application.count({ where: { status: 'Approved' } });
      const totalRejectedSys = await prisma.application.count({ where: { status: 'Rejected' } });

      stats.approver = {
        pendingApproval: await prisma.application.count({ where: { status: 'Pending_Approval' } }),
        recentlyApproved: totalApprovedByMe,
        approvalRate: {
          approved: totalApprovedSys,
          rejected: totalRejectedSys,
          total: totalSubmitted
        },
        applicationsVsApprovals: Object.values(monthlyData),
        recentApplications: rawRecent.map(app => ({
          id: app.id,
          applicantName: app.member?.fullName || 'Unknown',
          category: app.category?.categoryName || 'Unknown',
          practiceLocation: app.practiceLocation || 'Local',
          status: app.status
        })),
        recentActivity: await getEnrichedActivity({
          actionType: { in: ['APPROVE', 'REJECT', 'ADMIN_EMAIL_SEND', 'ADMIN_EMAIL_BULK_SEND'] }
        })
      };
    }

    res.status(200).json(stats);
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    res.status(500).json({ error: "Failed to fetch dashboard statistics" });
  }
};

// A member's category/class should never be hand-edited via changeMembershipCategory while
// they already have a membership-change process underway through the normal channels (an APC
// board in progress or awaiting sign-off, a pending mentorship-upgrade review, or an approved
// upgrade already invoiced and awaiting fee payment) — doing so would fight that process for
// the same Member/Application row. Returns null when nothing is in progress.
function getOngoingMembershipChange(app: any): { type: string; label: string; linkType: 'apc' | 'mentorship' | 'application'; linkId: string } | null {
  if (!app) return null;

  if (app.pendingUpgradeClass) {
    return {
      type: 'Pending_Upgrade_Payment',
      label: `An upgrade to ${app.pendingUpgradeClass} has already been approved and is awaiting the member's first-year fee payment`,
      linkType: 'application',
      linkId: app.id
    };
  }

  const activeApc = (app.apcAssessments || []).find((a: any) => ['Requested', 'Scheduled', 'Attended', 'Pending_Approval'].includes(a.status));
  if (activeApc) {
    return {
      type: 'APC_In_Progress',
      label: activeApc.status === 'Pending_Approval'
        ? 'An APC assessment has been graded and is awaiting Admin/Approver confirmation'
        : 'An APC assessment is currently in progress for this member',
      linkType: 'apc',
      linkId: activeApc.id
    };
  }

  const mentorship = app.mentorshipAssignment;
  if (mentorship && ['Pending_Reviewer_Board', 'Pending_Admin_Review'].includes(mentorship.status)) {
    return {
      type: 'Mentorship_Review_In_Progress',
      label: mentorship.status === 'Pending_Reviewer_Board'
        ? 'A mentorship upgrade review is currently before the reviewer board'
        : 'A mentorship upgrade review is awaiting Admin/Approver decision',
      linkType: 'mentorship',
      linkId: app.id
    };
  }

  return null;
}

export async function changeMembershipCategory(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    const { newCategoryId } = req.body;
    
    if (!newCategoryId) return res.status(400).json({ error: 'New category ID is required.' });

    const member = await prisma.member.findUnique({
      where: { id },
      include: {
        applications: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { apcAssessments: true, mentorshipAssignment: true }
        }
      }
    });

    if (!member) return res.status(404).json({ error: 'Member not found.' });

    // Never let a manual category change collide with an upgrade already in flight — it would
    // silently fight the pendingUpgrade*/APC/mentorship-review machinery for the same member.
    // See getOngoingMembershipChange, reused by getMemberById so the admin UI can show/lock
    // this before the request is even attempted.
    const ongoing = getOngoingMembershipChange(member.applications[0]);
    if (ongoing) {
      return res.status(409).json({ error: `Cannot change category: ${ongoing.label}. Resolve that process first.`, ongoingChange: ongoing });
    }

    const category = await prisma.membershipCategory.findUnique({ where: { id: newCategoryId } });
    if (!category) return res.status(404).json({ error: 'Category not found.' });

    let newClass = member.membershipClass;
    if (category.categoryName.toLowerCase().includes('professional')) newClass = 'Professional';
    else if (category.categoryName.toLowerCase().includes('technologist')) newClass = 'Technologist';
    else if (category.categoryName.toLowerCase().includes('graduate')) newClass = 'Graduate';
    else if (category.categoryName.toLowerCase().includes('firm')) newClass = 'Firm_Local_Small'; // fallback mapping for firm

    let newMembershipId = member.membershipId;
    if (newMembershipId) {
       const p = category.categoryCode;
       // ID format is typically RIQS-YYYY-CODE-XXXX
       const parts = newMembershipId.split('-');
       if (parts.length === 4) {
          parts[2] = p;
          newMembershipId = parts.join('-');
       } else {
         const slashParts = newMembershipId.split('/');
         if (slashParts.length === 3) {
            slashParts[1] = p;
            newMembershipId = slashParts.join('/');
         }
       }
    }

    if (member.applications.length > 0) {
      await prisma.application.update({
        where: { id: member.applications[0].id },
        data: { categoryId: category.id }
      });
    }

    const updatedMember = await prisma.member.update({
      where: { id },
      data: {
        membershipClass: newClass as any, // bypassing strict enum check just in case
        membershipId: newMembershipId
      }
    });

    let invoiceUrl = '';
    if (category.firstYearFee.toNumber() > 0) {
      const existingTx = await prisma.financialTransaction.findFirst({
         where: { 
           memberId: id, 
           txType: 'First_Year_Fee', 
           transactionReference: { startsWith: `FYF-${newMembershipId}` }
         }
      });
      if (!existingTx) {
         const tx = await prisma.financialTransaction.create({
           data: {
             memberId: id,
             amount: category.firstYearFee,
             currency: category.currency || 'RWF',
             txType: 'First_Year_Fee',
             status: 'Unpaid',
             transactionReference: `FYF-${newMembershipId}-${Date.now()}`,
             paymentMethod: 'Bank_Transfer'
           }
         });
         invoiceUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/member/invoices/${tx.id}`;
      }
    }

    try {
      const { sendRawMail } = await import('../config/mailer');
      await sendRawMail({
        to: member.email,
        subject: 'Membership Category Updated',
        html: `
          <h3>Membership Update</h3>
          <p>Dear ${member.fullName},</p>
          <p>Your membership category has been successfully updated to <strong>${category.categoryName}</strong>.</p>
          <p>Your new Membership Class is <strong>${newClass}</strong> and your Membership ID is <strong>${newMembershipId}</strong>.</p>
          ${invoiceUrl ? `<p>An invoice for your new category fee has been generated. Please log in to your portal to review and pay it.</p>` : ''}
          <br/>
          <p>Thank you,</p>
          <p>RIQS Administration</p>
        `
      });
    } catch (emailErr: any) {
      console.error('[Change Category] Failed to send email:', emailErr.message);
    }

    res.json({ success: true, message: 'Membership category updated successfully.', member: updatedMember });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error updating membership category.' });
  }
}

export const awardFellowStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const member = await prisma.member.findUnique({
      where: { id },
      include: { applications: { orderBy: { createdAt: 'desc' }, take: 1, include: { category: true } } }
    });

    if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

    const category = member.applications[0]?.category;
    const honors = (category?.supportedHonors as any[]) || [];
    if (!category || !honors.some((h: any) => h.name === 'Fellow')) {
       return res.status(400).json({ success: false, message: "This member's category does not support the Fellow honorable mention." });
    }

    const updatedMember = await prisma.member.update({
      where: { id },
      data: { isFellow: true }
    });

    res.json({ success: true, message: 'Member successfully awarded Fellow status', member: updatedMember });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

export const revokeFellowStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const member = await prisma.member.update({
      where: { id },
      data: { isFellow: false }
    });
    res.json({ success: true, message: 'Fellow status revoked successfully.', member });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

export const awardHonoraryStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const member = await prisma.member.update({ where: { id }, data: { isHonorary: true } });
    res.json({ success: true, message: 'Awarded Honorary status', member });
  } catch (error: any) { res.status(500).json({ success: false, message: 'Server Error' }); }
};

export const revokeHonoraryStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const member = await prisma.member.update({ where: { id }, data: { isHonorary: false } });
    res.json({ success: true, message: 'Revoked Honorary status', member });
  } catch (error: any) { res.status(500).json({ success: false, message: 'Server Error' }); }
};

export const createHonorableMentionMember = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      fullName,
      email,
      phoneNumber,
      categoryCode,
      nationalIdOrPassport,
      dateOfBirth,
      gender,
      countryOfOrigin
    } = req.body;

    if (!fullName || !email || !categoryCode) {
      return res.status(400).json({ error: 'Full name, email, and category code are required.' });
    }

    const existingMember = await prisma.member.findUnique({ where: { email } });
    if (existingMember) {
      return res.status(409).json({ error: 'A member with this email already exists.' });
    }

    let membershipClass: any = 'Visiting_Member';
    let certCode = 'ViQS';
    if (categoryCode === 'LQS') {
      membershipClass = 'Life_Member';
      certCode = 'LiQS';
    } else if (categoryCode === 'HQS') {
      membershipClass = 'Honorary_Member';
      certCode = 'HonQS';
    }

    const currentYear = new Date().getFullYear();
    const count = await prisma.member.count({
      where: { membershipId: { startsWith: `RIQS-${currentYear}-${certCode}-` } }
    });
    const membershipId = `RIQS-${currentYear}-${certCode}-${String(count + 1).padStart(4, '0')}`;

    const isHonorary = categoryCode === 'HQS';

    // Auto-generate password
    const generatedPassword = crypto.randomBytes(4).toString('hex'); // 8 char random password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(generatedPassword, saltRounds);

    const member = await prisma.member.create({
      data: {
        email,
        passwordHash,
        fullName,
        phoneNumber,
        nationalIdOrPassport,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        gender,
        countryOfOrigin,
        membershipClass,
        membershipId,
        isHonorary,
        systemRole: 'Standard',
        isEmailVerified: true
      }
    });

    await prisma.auditLog.create({
      data: {
        memberId: member.id,
        actionByEmail: req.user?.email || 'admin@system.com',
        actionType: 'Admin_Created_Member',
        details: `Admin created ${categoryCode} member ${fullName} (${email})`
      }
    });

    try {
      await sendRawMail({
        to: email,
        subject: `Welcome to RIQS - ${categoryCode} Membership`,
        html: `
          <div style="font-family: sans-serif; color: #333;">
            <h2>Welcome to RIQS</h2>
            <p>Dear ${fullName},</p>
            <p>An administrator has created a ${categoryCode} member account for you on the RIQS portal.</p>
            <p>Your login details are:</p>
            <ul>
              <li><strong>Email:</strong> ${email}</li>
              <li><strong>Password:</strong> ${generatedPassword}</li>
            </ul>
            <p>Please log in and update your password at your earliest convenience.</p>
            <br/>
            <p>Best regards,</p>
            <p>RIQS Administration</p>
          </div>
        `
      });
    } catch (emailError: any) {
      console.error('Failed to send auto-generated password:', emailError.message);
    }

    return res.status(201).json({
      success: true,
      message: `${categoryCode} Member created successfully.`,
      membershipId: member.id,
      temporaryPassword: generatedPassword
    });
  } catch (error: any) {
    console.error('[Create Honorable Mention] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while creating member.' });
  }
};


export const getMemberById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const member = await prisma.member.findUnique({
      where: { id },
      include: {
        applications: {
          orderBy: { createdAt: 'desc' },
          include: { category: true, apcAssessments: true, mentorshipAssignment: true }
        },
        financialTransactions: { orderBy: { createdAt: 'desc' } }
      }
    });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const ongoingChange = getOngoingMembershipChange(member.applications[0]);
    res.json({ ...member, ongoingChange });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

export const updateMemberHonors = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { honors } = req.body;
    
    if (!Array.isArray(honors)) {
      return res.status(400).json({ success: false, message: 'Honors must be an array of strings' });
    }

    const member = await prisma.member.findUnique({
      where: { id },
      include: { applications: { orderBy: { createdAt: 'desc' }, take: 1, include: { category: true } } }
    });

    if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

    const category = member.applications[0]?.category;
    const supportedHonors = (category?.supportedHonors as any[]) || [];
    const supportedNames = supportedHonors.map((h: any) => typeof h === 'string' ? h : h.name);

    // Validate that all provided honors are supported by the category
    for (const h of honors) {
      if (!supportedNames.includes(h)) {
        return res.status(400).json({ success: false, message: `Honor '${h}' is not supported by the member's current category.` });
      }
    }

    // Sync legacy booleans
    const isFellow = honors.includes('Fellow');
    const isHonorary = honors.includes('Honorary Member') || honors.includes('Honorary');

    const updatedMember = await prisma.member.update({
      where: { id },
      data: {
        honors,
        isFellow,
        isHonorary
      }
    });

    res.json({ success: true, message: 'Member honors successfully updated', member: updatedMember });
  } catch (error: any) {
    console.error('[Update Honors] Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
