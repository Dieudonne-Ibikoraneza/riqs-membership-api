import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma, supabaseAdmin } from '../config/db';
import { sendMail } from '../config/mailer';

interface ProposedEducationInput {
  institution: string;
  qualificationType: string;
  fieldOfStudy: string;
  startDate: string;
  endDate: string;
  certificateIndex?: number;
}

interface ProposedEmploymentInput {
  companyName: string;
  jobTitle: string;
  startDate: string;
  endDate?: string;
  isCurrent?: boolean;
}

function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// 1. Member submits a profile edit request (name, addresses, photo, new
// education/employment history). Nothing is applied until an Admin or
// Admin Assistant approves it.
export async function submitProfileEditRequest(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  // At most one ProfileEditRequest ever exists per member — a resubmission
  // updates that same row instead of creating a new one, so there is never
  // more than one "current" request to reason about (member-side display,
  // admin queue, or restoring after a rejection).
  const existingRequest = await prisma.profileEditRequest.findFirst({
    where: { memberId: req.user.id }
  });
  if (existingRequest?.status === 'Pending') {
    return res.status(409).json({ error: 'You already have a profile update request awaiting review. Please wait for it to be resolved before submitting another.' });
  }

  const { fullName, memberNotes, nationalIdOrPassport, dateOfBirth, gender } = req.body;
  // Address fields are submitted as JSON ({district, sector, cell, village})
  // for Rwandan members, or a plain string for non-Rwandan members.
  const residencyAddress = parseJsonField<any>(req.body.residencyAddress, req.body.residencyAddress || null);
  const workAddress = parseJsonField<any>(req.body.workAddress, req.body.workAddress || null);
  const education = parseJsonField<ProposedEducationInput[]>(req.body.education, []);
  const employment = parseJsonField<ProposedEmploymentInput[]>(req.body.employment, []);

  if (!fullName && !residencyAddress && !workAddress && !nationalIdOrPassport && !dateOfBirth && !gender && education.length === 0 && employment.length === 0) {
    const files = (req.files as Express.Multer.File[]) || [];
    const hasPhoto = files.some(f => f.fieldname === 'photo');
    if (!hasPhoto) {
      return res.status(400).json({ error: 'Submit at least one change: name, address, identity details, photo, education, or employment.' });
    }
  }

  try {
    const files = (req.files as Express.Multer.File[]) || [];
    const filesByField = new Map(files.map(f => [f.fieldname, f]));

    // Resubmitting after a rejection updates the same row (see below) — if
    // the member doesn't reselect a photo/certificate that was already
    // attached last time, fall back to what's already on the existing row
    // instead of wiping it out with null.
    const previousEducation = (existingRequest?.proposedEducation as any[]) || [];

    let proposedProfilePhotoUrl: string | null = existingRequest?.proposedProfilePhotoUrl || null;
    const photoFile = filesByField.get('photo');
    if (photoFile) {
      const uniqueName = `photo_${Date.now()}_${photoFile.originalname.replace(/\s+/g, '_')}`;
      const filePath = `profile-edit-requests/${req.user.id}/${uniqueName}`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from('riqs-membership')
        .upload(filePath, photoFile.buffer, { contentType: photoFile.mimetype, upsert: true });
      if (uploadError) throw new Error(`Photo upload failed: ${uploadError.message}`);
      proposedProfilePhotoUrl = filePath;
    }

    const proposedEducation = [];
    for (let i = 0; i < education.length; i++) {
      const entry = education[i];
      if (!entry.institution || !entry.qualificationType || !entry.startDate || !entry.endDate) continue;
      const certFile = filesByField.get(`certificate_${i}`);
      let certificateUrl: string | null = null;
      if (certFile) {
        const uniqueName = `certificate_${Date.now()}_${certFile.originalname.replace(/\s+/g, '_')}`;
        const filePath = `profile-edit-requests/${req.user.id}/${uniqueName}`;
        const { error: uploadError } = await supabaseAdmin.storage
          .from('riqs-membership')
          .upload(filePath, certFile.buffer, { contentType: certFile.mimetype, upsert: true });
        if (uploadError) throw new Error(`Certificate upload failed: ${uploadError.message}`);
        certificateUrl = filePath;
      } else {
        // No new file for this entry this time — if it matches an entry
        // already on the existing request (same institution/qualification/
        // dates), carry over its certificate instead of dropping it.
        const previousMatch = previousEducation.find(p =>
          p.institution === entry.institution &&
          p.qualificationType === entry.qualificationType &&
          p.startDate === entry.startDate &&
          p.endDate === entry.endDate
        );
        certificateUrl = previousMatch?.certificateUrl || null;
      }
      proposedEducation.push({
        institution: entry.institution,
        qualificationType: entry.qualificationType,
        fieldOfStudy: entry.fieldOfStudy || '',
        startDate: entry.startDate,
        endDate: entry.endDate,
        certificateUrl
      });
    }

    const proposedEmployment = employment
      .filter(e => e.companyName && e.jobTitle && e.startDate)
      .map(e => ({
        companyName: e.companyName,
        jobTitle: e.jobTitle,
        startDate: e.startDate,
        endDate: e.isCurrent ? null : (e.endDate || null),
        isCurrent: !!e.isCurrent
      }));

    const proposedData = {
      status: 'Pending',
      proposedFullName: fullName || null,
      proposedResidencyAddress: residencyAddress || undefined,
      proposedWorkAddress: workAddress || undefined,
      proposedProfilePhotoUrl,
      proposedNationalIdOrPassport: nationalIdOrPassport || null,
      proposedDateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      proposedGender: gender || null,
      proposedEducation: proposedEducation.length > 0 ? proposedEducation : undefined,
      proposedEmployment: proposedEmployment.length > 0 ? proposedEmployment : undefined,
      memberNotes: memberNotes || null,
      // Resubmitting after a rejection clears the old outcome and counts as
      // a fresh submission for display/sorting purposes.
      reviewNotes: null,
      reviewedByEmail: null,
      reviewedAt: null,
      createdAt: new Date()
    };

    const request = existingRequest
      ? await prisma.profileEditRequest.update({ where: { id: existingRequest.id }, data: proposedData })
      : await prisma.profileEditRequest.create({ data: { memberId: req.user.id, ...proposedData } });

    return res.status(201).json({ message: 'Profile update request submitted for review.', request });
  } catch (error: any) {
    console.error('[Submit Profile Edit Request] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error submitting profile update request.' });
  }
}

// 2. Member views their own profile edit request — at most one ever exists.
export async function getMyProfileEditRequests(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    const requests = await prisma.profileEditRequest.findMany({
      where: { memberId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 1
    });
    return res.status(200).json({ requests });
  } catch (error: any) {
    console.error('[Get My Profile Edit Requests] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching profile update requests.' });
  }
}

// 3. Admin / Admin Assistant: paginated queue of profile edit requests
export async function getProfileEditRequests(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { status = 'Pending', page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const whereClause: any = {};
  if (status && status !== 'all') {
    whereClause.status = status;
  }

  try {
    const [requests, total] = await Promise.all([
      prisma.profileEditRequest.findMany({
        where: whereClause,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          member: {
            select: {
              fullName: true, email: true, membershipId: true, membershipClass: true,
              residencyAddress: true, workAddress: true, profilePhotoUrl: true
            }
          }
        }
      }),
      prisma.profileEditRequest.count({ where: whereClause })
    ]);

    return res.status(200).json({ requests, total, page: Number(page), limit: Number(limit) });
  } catch (error: any) {
    console.error('[Get Profile Edit Requests] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching profile update requests.' });
  }
}

// 4. Admin / Admin Assistant: approve or reject a profile edit request
export async function reviewProfileEditRequest(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id } = req.params;
  const { decision, reviewNotes } = req.body; // decision: 'Approve' | 'Reject'

  if (!['Approve', 'Reject'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision. Must be Approve or Reject.' });
  }

  try {
    const request = await prisma.profileEditRequest.findUnique({
      where: { id },
      include: { member: true }
    });
    if (!request) return res.status(404).json({ error: 'Profile update request not found.' });
    if (request.status !== 'Pending') {
      return res.status(400).json({ error: `This request has already been ${request.status.toLowerCase()}.` });
    }

    if (decision === 'Reject') {
      if (!reviewNotes?.trim()) return res.status(400).json({ error: 'Please provide a reason for rejecting this request.' });

      await prisma.profileEditRequest.update({
        where: { id },
        data: { status: 'Rejected', reviewNotes: reviewNotes.trim(), reviewedByEmail: req.user.email, reviewedAt: new Date() }
      });

      sendMail(request.member.email, 'profile_edit_rejected', {
        name: request.member.fullName,
        reason: reviewNotes.trim()
      }).catch(console.error);

      return res.status(200).json({ message: 'Profile update request rejected.' });
    }

    // Approve: apply the proposed changes to the Member record and create
    // new education/employment history rows.
    await prisma.$transaction(async (tx) => {
      const memberUpdateData: any = {};
      if (request.proposedFullName) memberUpdateData.fullName = request.proposedFullName;
      if (request.proposedResidencyAddress !== null && request.proposedResidencyAddress !== undefined) {
        memberUpdateData.residencyAddress = request.proposedResidencyAddress;
      }
      if (request.proposedWorkAddress !== null && request.proposedWorkAddress !== undefined) {
        memberUpdateData.workAddress = request.proposedWorkAddress;
      }
      if (request.proposedProfilePhotoUrl) memberUpdateData.profilePhotoUrl = request.proposedProfilePhotoUrl;
      if (request.proposedNationalIdOrPassport) memberUpdateData.nationalIdOrPassport = request.proposedNationalIdOrPassport;
      if (request.proposedDateOfBirth) memberUpdateData.dateOfBirth = request.proposedDateOfBirth;
      if (request.proposedGender) memberUpdateData.gender = request.proposedGender;

      if (Object.keys(memberUpdateData).length > 0) {
        await tx.member.update({ where: { id: request.memberId }, data: memberUpdateData });
      }

      const proposedEducation = (request.proposedEducation as any[]) || [];
      for (const entry of proposedEducation) {
        await tx.educationRecord.create({
          data: {
            memberId: request.memberId,
            institution: entry.institution,
            qualificationType: entry.qualificationType,
            fieldOfStudy: entry.fieldOfStudy || '',
            startDate: new Date(entry.startDate),
            endDate: new Date(entry.endDate),
            certificateUrl: entry.certificateUrl || null
          }
        });
      }

      const proposedEmployment = (request.proposedEmployment as any[]) || [];
      for (const entry of proposedEmployment) {
        await tx.employmentRecord.create({
          data: {
            memberId: request.memberId,
            companyName: entry.companyName,
            jobTitle: entry.jobTitle,
            startDate: new Date(entry.startDate),
            endDate: entry.endDate ? new Date(entry.endDate) : null,
            isCurrent: !!entry.isCurrent
          }
        });
      }

      // Once applied, the request no longer needs to exist as a pending
      // artifact — the data now lives on the Member record directly.
      await tx.profileEditRequest.delete({ where: { id } });

      await tx.auditLog.create({
        data: {
          memberId: request.memberId,
          actionByEmail: req.user!.email,
          actionType: 'PROFILE_EDIT_APPROVED',
          details: `Profile update request ${id} approved and applied.`
        }
      });
    });

    sendMail(request.member.email, 'profile_edit_approved', {
      name: request.member.fullName
    }).catch(console.error);

    return res.status(200).json({ message: 'Profile update request approved and applied.' });
  } catch (error: any) {
    console.error('[Review Profile Edit Request] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error reviewing profile update request.' });
  }
}
