import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';

// 1. Add Education Record (Repeatable — supports multiple degrees per application)
export async function addEducationRecord(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, institution, qualificationType, fieldOfStudy, startDate, endDate } = req.body;

  if (!applicationId || !institution || !qualificationType || !fieldOfStudy || !startDate || !endDate) {
    return res.status(400).json({ error: 'Missing required education fields: institution, qualificationType, fieldOfStudy, startDate, endDate.' });
  }

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { memberId: true, status: true }
    });

    if (!app) return res.status(404).json({ error: 'Application not found.' });
    if (app.memberId !== req.user.id) return res.status(403).json({ error: 'Access Denied. Not your application.' });

    const newEducation = await prisma.educationRecord.create({
      data: {
        applicationId,
        institution,
        qualificationType,
        fieldOfStudy,
        startDate: new Date(startDate),
        endDate: new Date(endDate)
      }
    });

    if (app.status === 'Approved') {
      await prisma.auditLog.create({
        data: {
          memberId: req.user.id,
          actionByEmail: req.user.email,
          actionType: 'PHASE_B_EDUCATION_ADD',
          details: `Added education record: ${institution} — ${qualificationType}`
        }
      });
    }

    return res.status(201).json({ message: 'Education record added.', education: newEducation });
  } catch (error: any) {
    console.error('[Add Education] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error adding education record.' });
  }
}

// 2. Get all education records for an application
export async function getEducationRecords(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { applicationId } = req.params;

  try {
    const records = await prisma.educationRecord.findMany({
      where: { applicationId },
      orderBy: { startDate: 'desc' }
    });
    return res.status(200).json({ education: records });
  } catch (error: any) {
    console.error('[Get Education] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching education records.' });
  }
}

// 3. Delete an education record
export async function deleteEducationRecord(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id } = req.params;

  try {
    const record = await prisma.educationRecord.findUnique({
      where: { id },
      include: { application: true }
    });

    if (!record) return res.status(404).json({ error: 'Education record not found.' });
    if (record.application.memberId !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });
    if (record.application.status === 'Approved') {
      return res.status(400).json({ error: 'Cannot delete education records post-approval. You may only add new qualifications.' });
    }

    await prisma.educationRecord.delete({ where: { id } });
    return res.status(200).json({ message: 'Education record deleted.' });
  } catch (error: any) {
    console.error('[Delete Education] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error deleting education record.' });
  }
}

// 4. Upsert Student Association Record (1:1 per application)
export async function upsertStudentAssociation(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, associationName, membershipNumber, registrationDate, activeYears } = req.body;

  if (!applicationId || !associationName || !membershipNumber || !registrationDate || !activeYears) {
    return res.status(400).json({ error: 'Missing required student association fields.' });
  }

  try {
    const app = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!app) return res.status(404).json({ error: 'Application not found.' });
    if (app.memberId !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });

    const newRecord = await prisma.studentAssociationRecord.upsert({
      where: { applicationId },
      update: {
        associationName,
        membershipNumber,
        registrationDate: new Date(registrationDate),
        activeYears
      },
      create: {
        applicationId,
        associationName,
        membershipNumber,
        registrationDate: new Date(registrationDate),
        activeYears
      }
    });

    return res.status(200).json({ message: 'Student association record saved.', association: newRecord });
  } catch (error: any) {
    console.error('[Upsert Student Association] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error saving student association.' });
  }
}

// 5. Upsert Mentorship Assignment (1:1 per application)
export async function upsertMentorship(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const {
    applicationId, preferredMentors, mentorshipPlan,
    isSelfAssigned, requestedInstitutionalAssignment, preferredPracticeAreas
  } = req.body;

  if (!applicationId) return res.status(400).json({ error: 'Missing applicationId.' });

  if (preferredMentors && (!Array.isArray(preferredMentors) || preferredMentors.length > 5)) {
    return res.status(400).json({ error: 'preferredMentors must be an array of up to 5 mentor objects.' });
  }

  try {
    const app = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!app) return res.status(404).json({ error: 'Application not found.' });
    if (app.memberId !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });

    const newRecord = await prisma.mentorshipAssignment.upsert({
      where: { applicationId },
      update: {
        isSelfAssigned: isSelfAssigned !== undefined ? isSelfAssigned : true,
        requestedInstitutionalAssignment: requestedInstitutionalAssignment || false,
        preferredPracticeAreas: preferredPracticeAreas || [],
        preferredMentors: preferredMentors || [],
        mentorshipPlan: mentorshipPlan || null
      },
      create: {
        applicationId,
        isSelfAssigned: isSelfAssigned !== undefined ? isSelfAssigned : true,
        requestedInstitutionalAssignment: requestedInstitutionalAssignment || false,
        preferredPracticeAreas: preferredPracticeAreas || [],
        preferredMentors: preferredMentors || [],
        mentorshipPlan: mentorshipPlan || null
      }
    });

    return res.status(200).json({ message: 'Mentorship assignment saved.', mentorship: newRecord });
  } catch (error: any) {
    console.error('[Upsert Mentorship] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error saving mentorship assignment.' });
  }
}
