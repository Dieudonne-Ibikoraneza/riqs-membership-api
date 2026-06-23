import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { sendMail } from '../config/mailer';
import { ApplicationStatus } from '@prisma/client';
import { getCertificateCode, deriveMemberClass } from '../utils/membershipUtils';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

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
    const isApprover = userRole === 'approver';

    // 2. Process View mode (Tabs)
    if (view === 'queue') {
      if (isApprover) {
        if (!status) whereClause.status = 'Pending_Approval';
      } else {
        if (!status) {
          whereClause.OR = [
            { status: 'Pending' },
            { mentorshipAssignment: { status: 'Pending_Admin_Review' } }
          ];
          whereClause.assignedReviewerId = null;
        } else {
          whereClause.status = status;
          whereClause.assignedReviewerId = null;
        }
      }
    } else if (view === 'assigned') {
      if (isApprover) {
        whereClause.assignedReviewerId = '00000000-0000-0000-0000-000000000000';
      } else {
        if (!status) {
          whereClause.OR = [
            { status: { in: ['Pending', 'Under_Review', 'Correction_Required'] } },
            { mentorshipAssignment: { status: 'Pending_Admin_Review' } }
          ];
        } else {
          whereClause.status = status;
        }
        whereClause.assignedReviewerId = req.user?.id;
      }
    } else if (view === 'all') {
      if (isApprover && !status) {
        whereClause.status = { in: ['Pending_Approval', 'Approved', 'Rejected'] };
      } else if (!status) {
        whereClause.status = { not: 'Draft' };
      }
    } else {
      // Default fallback if view not provided (for backward compatibility)
      if (isApprover) {
        if (!status) whereClause.status = 'Pending_Approval';
      } else {
        if (!status) {
          whereClause.OR = [
            { status: 'Pending' },
            { mentorshipAssignment: { status: 'Pending_Admin_Review' } }
          ];
          whereClause.assignedReviewerId = null;
        } else {
          whereClause.status = status;
          whereClause.assignedReviewerId = null;
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
          member: { select: { fullName: true, email: true } },
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
      status: app.mentorshipAssignment?.status === 'Pending_Admin_Review' ? 'Mentorship_Upgrade' : app.status,
      submitted_at: app.submittedAt,
      full_name: app.member.fullName,
      email: app.member.email,
      category_name: app.category.categoryName,
      location: app.category.location,
      reviewer: app.assignedReviewer?.fullName || 'Unassigned',
      photoId: app.uploadedDocuments?.[0]?.id,
      apcRequested: (app as any).apcAssessments?.length > 0
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
        })
      ]);

      try { await sendMail(app.member.email, "rejected", { name: app.member.fullName, reason: notes }); } catch (e) {}
      return res.status(200).json({ message: 'Application declined. Notification sent.' });

    } else if (action === 'Approve') {
      const currentYear = new Date().getFullYear();

      // Derive the certificate-friendly code (e.g. PrQS, LF, FF)
      const certCode = getCertificateCode(app.category.categoryCode);

      // To prevent duplicate IDs, find the latest membership ID assigned this year for this certCode
      const prefix = `RIQS-${currentYear}-${certCode}-`;
      const latestMember = await prisma.member.findFirst({
        where: {
          membershipId: { startsWith: prefix }
        },
        orderBy: { membershipId: 'desc' }
      });

      let sequenceNumber = 1;
      if (latestMember && latestMember.membershipId) {
        const parts = latestMember.membershipId.split('-');
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) {
          sequenceNumber = lastSeq + 1;
        }
      }

      const paddedSequence = String(sequenceNumber).padStart(4, '0');
      // DB format uses dashes (safe for unique constraint); certificate displays slashes
      const generatedMembershipId = `${prefix}${paddedSequence}`;

      // Derive the professional tier (MemberClass) from the category code
      const memberClass = deriveMemberClass(app.category.categoryCode);

      await prisma.$transaction([
        prisma.application.update({
          where: { id: applicationId },
          data: { status: 'Approved', approvedAt: new Date(), updatedAt: new Date() }
        }),
        prisma.member.update({
          where: { id: app.memberId },
          data: { membershipId: generatedMembershipId, membershipClass: memberClass, updatedAt: new Date() }
        }),
        prisma.applicationStatusHistory.create({
          data: {
            applicationId,
            changedByEmail: req.user.email,
            oldStatus: oldStatus || 'Draft',
            newStatus: 'Approved',
            reviewerNotes: 'Application formally approved by Registrar.'
          }
        }),
        prisma.auditLog.create({
          data: {
            memberId: app.memberId,
            actionByEmail: req.user.email,
            actionType: 'APPROVE',
            details: `Approved application. Membership ID: ${generatedMembershipId}`
          }
        })
      ]);

      try { await sendMail(app.member.email, "approved", { name: app.member.fullName, membershipId: generatedMembershipId, category: app.category.categoryName }); } catch (e) {}
      return res.status(200).json({ message: 'Application successfully approved.', membershipId: generatedMembershipId });
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
  if (!['reviewer', 'admin'].includes(userRole)) {
    return res.status(403).json({ error: 'Access Denied. Only Reviewers can perform first-stage review actions.' });
  }

  const { applicationId, action, notes } = req.body;
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

    if (action === 'StartReview') {
      if (app.status !== 'Pending') {
        return res.status(400).json({ error: `Cannot start review. Application is in "${app.status}" status.` });
      }
      await prisma.$transaction([
        prisma.application.update({
          where: { id: applicationId },
          data: { status: 'Under_Review', assignedReviewerId: req.user.id, updatedAt: new Date() }
        }),
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user.email, oldStatus: oldStatus!, newStatus: 'Under_Review' }
        })
      ]);
      return res.status(200).json({ message: 'Application picked up. Review has started.' });

    } else if (action === 'ReturnForCorrection') {
      if (!notes) return res.status(400).json({ error: 'Correction remarks are mandatory.' });
      if (app.status !== 'Under_Review') {
        return res.status(400).json({ error: `Cannot return. Application is in "${app.status}" status.` });
      }
      await prisma.$transaction([
        prisma.application.update({ where: { id: applicationId }, data: { status: 'Correction_Required', updatedAt: new Date() } }),
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user.email, oldStatus: 'Under_Review', newStatus: 'Correction_Required', reviewerNotes: notes }
        })
      ]);
      try { await sendMail(app.member.email, "correctionRequired", { name: app.member.fullName, reviewerNotes: notes }); } catch (e) {}
      return res.status(200).json({ message: 'Application returned to applicant for correction.' });

    } else if (action === 'ForwardToApprover') {
      if (app.status !== 'Under_Review') {
        return res.status(400).json({ error: `Cannot forward. Application is in "${app.status}" status.` });
      }
      await prisma.$transaction([
        prisma.application.update({ where: { id: applicationId }, data: { status: 'Pending_Approval', updatedAt: new Date() } }),
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user.email, oldStatus: 'Under_Review', newStatus: 'Pending_Approval', reviewerNotes: notes || null }
        })
      ]);
      return res.status(200).json({ message: 'Application forwarded to Approver queue.' });
    }

    return res.status(400).json({ error: 'Invalid action. Valid reviewer actions: StartReview, ReturnForCorrection, ForwardToApprover.' });
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

      const currentYear = new Date().getFullYear();
      const certCode = getCertificateCode(app.category.categoryCode);

      const count = await prisma.application.count({
        where: {
          status: 'Approved',
          approvedAt: { gte: new Date(`${currentYear}-01-01`), lte: new Date(`${currentYear}-12-31`) },
          category: {
            categoryCode: {
              in: Object.entries({
                'GQS': 'GradQS', 'GQST': 'GradQS', 'QST': 'TechQS', 'FQST': 'TechQS',
                'PQS': 'PrQS', 'FPQS': 'PrQS',
                'LF-SM': 'LF', 'LF-MD': 'LF', 'LF-LG': 'LF',
                'FF-SM': 'FF', 'FF-MD': 'FF', 'FF-LG': 'FF',
              }).filter(([, v]) => v === certCode).map(([k]) => k)
            }
          }
        }
      });

      const generatedMembershipId = `RIQS-${currentYear}-${certCode}-${String(count + 1).padStart(4, '0')}`;
      const memberClass = deriveMemberClass(app.category.categoryCode);

      const txOps: any[] = [
        prisma.application.update({ where: { id: applicationId }, data: { status: 'Approved', approvedAt: new Date(), updatedAt: new Date() } }),
        prisma.member.update({ 
          where: { id: app.memberId }, 
          data: { 
            membershipId: generatedMembershipId, 
            membershipClass: memberClass, 
            ...(app.member.systemRole === 'Standard' && (memberClass.includes('Technologist') || memberClass.includes('Professional')) ? { systemRole: 'Mentor' } : {}),
            updatedAt: new Date() 
          } 
        }),
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user.email, oldStatus, newStatus: 'Approved', reviewerNotes: notes || 'Approved by Approver.' }
        }),
        prisma.auditLog.create({
          data: { memberId: app.memberId, actionByEmail: req.user.email, actionType: 'APPROVE', details: `Final approval. Membership ID: ${generatedMembershipId}` }
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
              transactionReference: `INV-${generatedMembershipId}-${currentYear}`,
              status: 'Unpaid'
            }
          })
        );
      }

      await prisma.$transaction(txOps);

      try { await sendMail(app.member.email, "approved", { name: app.member.fullName, membershipId: generatedMembershipId, category: app.category.categoryName }); } catch (e) {}
      
      if (app.category.firstYearFee && Number(app.category.firstYearFee) > 0) {
        try { await sendMail(app.member.email, "invoice_generated", { name: app.member.fullName, txType: "First Year Membership Fee", amount: app.category.firstYearFee, currency: app.category.currency || 'RWF', reference: `INV-${generatedMembershipId}-${currentYear}` }); } catch (e) {}
      }
      
      return res.status(200).json({ message: 'Application approved. Membership ID issued.', membershipId: generatedMembershipId });

    } else if (action === 'Reject') {
      if (!notes) return res.status(400).json({ error: 'Rejection notes are mandatory.' });

      await prisma.$transaction([
        prisma.application.update({ where: { id: applicationId }, data: { status: 'Rejected', updatedAt: new Date() } }),
        prisma.applicationStatusHistory.create({
          data: { applicationId, changedByEmail: req.user.email, oldStatus, newStatus: 'Rejected', reviewerNotes: notes }
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
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    if (!app) return res.status(404).json({ error: 'Application not found.' });

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
      processing_fee_cleared: app.financialTransactions?.[0]?.status === 'Cleared',
      processing_fee_tx_id: app.financialTransactions?.[0]?.id || null,
      processing_fee_status: app.financialTransactions?.[0]?.status || null
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
      studentAssociation: app.studentAssociation,
      logbookEntries: app.logbookEntries,
      statusHistory: app.statusHistory
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
          member: { select: { fullName: true, email: true, membershipId: true, membershipClass: true } },
          application: {
            select: {
              id: true,
              category: { select: { categoryName: true, categoryCode: true, stampFee: true } },
              uploadedDocuments: true
            }
          }
        }
      }),
      prisma.apcAssessment.count({ where: whereClause })
    ]);

    return res.status(200).json({ assessments, pagination: { total, page: Number(page), limit: take } });
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
    const whereClause: any = {
      membershipId: { not: null }
    };

    if (q) {
      const qs = String(q);
      whereClause.OR = [
        { fullName: { contains: qs, mode: 'insensitive' } },
        { email: { contains: qs, mode: 'insensitive' } },
        { membershipId: { contains: qs, mode: 'insensitive' } },
      ];
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
      whereClause.applications = {
        some: appFilter
      };
    }

    // Status filter mock handling
    if (status && status !== 'all') {
      if (String(status).toLowerCase() !== 'active') {
        return res.status(200).json({
          members: [],
          pagination: { total: 0, page: Number(page), limit: take }
        });
      }
    }

    let orderBy: any = {};
    const dir = String(sortDir).toLowerCase() === 'desc' ? 'desc' : 'asc';
    
    if (sortKey === 'name') orderBy.fullName = dir;
    else if (sortKey === 'id') orderBy.membershipId = dir;
    else orderBy.createdAt = dir; // default/fallback

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
            orderBy: { createdAt: 'desc' },
            take: 1
          },
          _count: {
            select: {
              financialTransactions: {
                where: { txType: 'Annual_Renewal', status: 'Cleared' }
              }
            }
          }
        }
      }),
      prisma.member.count({ where: whereClause })
    ]);

    const mapped = members.map(m => {
      const app = m.applications[0];
      const processingFeeTx = m.financialTransactions?.[0];
      const memberStatus = processingFeeTx?.status === 'Cleared' ? 'Active' : 'Pending Payment';

      // FOR TESTING: Dynamic Expiry Calculation: 5 minutes from approval + 5 minutes for each cleared renewal
      const baseDate = app?.approvedAt || m.createdAt || new Date();
      const renewalsCount = m._count?.financialTransactions || 0;
      const expiryDate = new Date(baseDate);
      // Instead of years, we add 5-minute increments for testing
      expiryDate.setMinutes(expiryDate.getMinutes() + ((1 + renewalsCount) * 5));

      // Adjust for Local Time (Rwandan Time / CAT is UTC+2)
      expiryDate.setHours(expiryDate.getHours() + 2);

      // Format to show time as well (YYYY-MM-DD HH:mm:ss) so the 5-minute jumps are visible
      const formattedExpiry = expiryDate.toISOString().replace('T', ' ').substring(0, 19);

      return {
        id: m.id,
        fullName: m.fullName,
        email: m.email,
        membershipId: m.membershipId,
        category: app?.category?.categoryName || m.membershipClass || 'N/A',
        practiceLocation: app?.practiceLocation || 'Rwandan',
        country: m.countryOfOrigin,
        status: memberStatus,
        expiresAt: formattedExpiry,
        photoId: app?.uploadedDocuments?.[0]?.id
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

  const userRole = req.user.role.toLowerCase();
  if (!['admin', 'reviewer', 'approver'].includes(userRole)) {
    return res.status(403).json({ error: 'Access Denied. Only Admins can send broadcast/custom emails.' });
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

        const whereClause: any = {
          membershipId: { not: null }
        };

        if (groupFilter === 'active') {
          // Active members in db (all approved)
        } else if (groupFilter === 'mentorship') {
          whereClause.mentorshipAssignment = { some: {} };
        } else if (groupFilter === 'expired') {
          whereClause.yearsInProfession = { gt: 10 }; // Simulation for expired
        }

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
          in: ['Admin', 'Reviewer', 'Approver', 'Teacher']
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

  const validRoles = ['Admin', 'Reviewer', 'Approver', 'Teacher'];
  if (!validRoles.includes(systemRole)) {
    return res.status(400).json({ error: 'Invalid system role provided for staff creation.' });
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

    const validRoles = ['Admin', 'Reviewer', 'Approver', 'Teacher'];
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

// ─── Mentorship Queue ───────────────────────────────────────────────────────

// Get paginated list of Mentorship Upgrade candidates (applications whose
// mentorshipAssignment.status === 'Pending_Admin_Review')
export async function getMentorshipQueue(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { page = 1, limit = 10, q, status } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  try {
    let mentorshipStatusFilter: any;
    const statusQuery = (status as string)?.toLowerCase();

    if (statusQuery === 'all' || !statusQuery) {
      mentorshipStatusFilter = { in: ['Pending_Admin_Review', 'Approved', 'Correction_Required'] };
    } else if (statusQuery === 'pending') {
      mentorshipStatusFilter = 'Pending_Admin_Review';
    } else if (statusQuery === 'approved') {
      mentorshipStatusFilter = 'Approved';
    } else if (statusQuery === 'rejected' || statusQuery === 'flagged') {
      mentorshipStatusFilter = 'Correction_Required';
    }

    const whereClause: any = {
      mentorshipAssignment: { 
        status: mentorshipStatusFilter,
        upgradeRequested: true
      }
    };

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
        orderBy: { submittedAt: 'desc' },
        include: {
          member:   { select: { fullName: true, email: true } },
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
      photoId:         app.uploadedDocuments?.[0]?.id
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
      const targetCategoryName = app.category.categoryName.includes("Technologist")
        ? "Associate Quantity Surveying Technologist"
        : "Associate Quantity Surveyor";

      const targetCategory = await prisma.membershipCategory.findFirst({
        where: { categoryName: targetCategoryName }
      });

      await prisma.application.update({
        where: { id: applicationId },
        data: {
          categoryId: targetCategory?.id || app.categoryId
        }
      });

      await prisma.member.update({
        where: { id: app.memberId },
        data: { membershipClass: 'Associate' }
      });

      await prisma.auditLog.create({
        data: {
          memberId: app.memberId,
          actionByEmail: req.user.email,
          actionType: 'MENTORSHIP_UPGRADE_APPROVED',
          details: 'Mentorship upgrade approved. Direct upgrade to Associate.'
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

    // 4. Notify the candidate
    try {
      await sendMail(app.member.email, 'mentorship_approved', {
        name: app.member.fullName
      });
    } catch (e) {}

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

    if (role === "Reviewer") {
      // Reviewer rate = how many they forwarded to Pending_Approval/Approved vs total assigned
      const myForwarded = await prisma.application.count({ where: { assignedReviewerId: userId, status: { in: ['Pending_Approval', 'Approved'] } } });
      const myTotalAssigned = await prisma.application.count({ where: { assignedReviewerId: userId } });

      const currentYear = new Date().getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);

      const reviewerApps = await prisma.application.findMany({
        where: { createdAt: { gte: startOfYear } },
        select: { createdAt: true }
      });

      // Graph: applications assigned to reviewer vs ones they forwarded to Pending_Approval
      const reviewerApprovals = await prisma.application.findMany({
        where: { assignedReviewerId: userId, status: { in: ['Pending_Approval', 'Approved'] }, updatedAt: { gte: startOfYear } },
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
        where: { OR: [{ status: 'Pending' }, { assignedReviewerId: userId, status: 'Under_Review' }] },
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          member: { select: { fullName: true } },
          category: { select: { categoryName: true } }
        }
      });

      stats.reviewer = {
        assignedApplications: await prisma.application.count({ where: { assignedReviewerId: userId, status: 'Under_Review' } }),
        pendingReviews: await prisma.application.count({ where: { status: 'Pending' } }),
        myReviewed: await prisma.application.count({ where: { assignedReviewerId: userId, status: { notIn: ['Under_Review', 'Pending'] } } }),
        reviewRate: {
          forwarded: myForwarded,
          total: myTotalAssigned
        },
        totalReceived: await prisma.application.count(),
        applicationsVsApprovals: Object.values(monthlyData),
        recentApplications: rawRecent.map(app => ({
          id: app.id,
          applicantName: app.member?.fullName || 'Unknown',
          category: app.category?.categoryName || 'Unknown',
          practiceLocation: app.practiceLocation || 'Local',
          status: app.status
        })),
        recentActivity: await getEnrichedActivity({})
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

      stats.approver = {
        pendingApproval: await prisma.application.count({ where: { status: 'Pending_Approval' } }),
        recentlyApproved: totalApprovedByMe,
        approvalRate: {
          approved: totalApprovedByMe,
          rejected: totalRejectedByMe,
          total: totalApprovedByMe + totalRejectedByMe
        },
        applicationsVsApprovals: Object.values(monthlyData),
        recentApplications: rawRecent.map(app => ({
          id: app.id,
          applicantName: app.member?.fullName || 'Unknown',
          category: app.category?.categoryName || 'Unknown',
          practiceLocation: app.practiceLocation || 'Local',
          status: app.status
        })),
        recentActivity: await getEnrichedActivity({})
      };
    }

    res.status(200).json(stats);
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    res.status(500).json({ error: "Failed to fetch dashboard statistics" });
  }
};
