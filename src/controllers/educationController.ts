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

// 3.5 Update an education record
export async function updateEducationRecord(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id } = req.params;
  const { institution, qualificationType, fieldOfStudy, startDate, endDate } = req.body;

  try {
    const record = await prisma.educationRecord.findUnique({
      where: { id },
      include: { application: true }
    });

    if (!record) return res.status(404).json({ error: 'Education record not found.' });
    if (record.application.memberId !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });
    if (record.application.status === 'Approved') {
      return res.status(400).json({ error: 'Cannot edit education records post-approval. You may only add new qualifications.' });
    }

    const updatedRecord = await prisma.educationRecord.update({
      where: { id },
      data: {
        institution: institution || record.institution,
        qualificationType: qualificationType || record.qualificationType,
        fieldOfStudy: fieldOfStudy || record.fieldOfStudy,
        startDate: startDate ? new Date(startDate) : record.startDate,
        endDate: endDate ? new Date(endDate) : record.endDate
      }
    });

    return res.status(200).json({ message: 'Education record updated.', education: updatedRecord });
  } catch (error: any) {
    console.error('[Update Education] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error updating education record.' });
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
    applicationId, options, mentorshipPlan
  } = req.body;

  if (!applicationId) return res.status(400).json({ error: 'Missing applicationId.' });

  if (options && (!Array.isArray(options) || options.length > 5)) {
    return res.status(400).json({ error: 'options must be an array of up to 5 mentor objects.' });
  }

  try {
    const app = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!app) return res.status(404).json({ error: 'Application not found.' });
    if (app.memberId !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });

    let filledOptions: any[] = [];

    if (options && Array.isArray(options)) {
      filledOptions = await Promise.all(
        options.map(async (pm: any) => {
          if (!pm.regNumber) return pm;
          const member = await prisma.member.findUnique({
            where: { membershipId: pm.regNumber }
          });
          if (member) {
            return {
              regNumber: pm.regNumber,
              name: member.fullName,
              contact: member.phoneNumber || member.email
            };
          }
          return pm;
        })
      );
    }

    const newRecord = await prisma.mentorshipAssignment.upsert({
      where: { applicationId },
      update: {
        preferredMentors: filledOptions,
        mentorshipPlan: mentorshipPlan || null,
        mentorRegistrationNumber: null,
        mentorName: null,
        mentorContact: null,
        mentorQualification: null,
        mentorClass: null,
        mentorEmployer: null
      },
      create: {
        applicationId,
        preferredMentors: filledOptions,
        mentorshipPlan: mentorshipPlan || null
      }
    });

    // Clean up response for frontend
    const responseData = {
      ...newRecord,
      options: newRecord.preferredMentors || [],
      preferredPracticeAreas: undefined,
      preferredMentors: undefined,
      isSelfAssigned: undefined,
      requestedInstitutionalAssignment: undefined
    };

    return res.status(200).json({ message: 'Mentorship assignment saved.', mentorship: responseData });
  } catch (error: any) {
    console.error('[Upsert Mentorship] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error saving mentorship assignment.' });
  }
}

// 6. Delete a single preferred mentorship option
export async function deleteMentorshipOption(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, regNumber } = req.params;

  try {
    const mentorship = await prisma.mentorshipAssignment.findUnique({
      where: { applicationId },
      include: { application: true }
    });

    if (!mentorship) return res.status(404).json({ error: 'Mentorship assignment not found.' });
    if (mentorship.application.memberId !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });

    let options = (mentorship.preferredMentors as any[]) || [];
    options = options.filter(opt => opt.regNumber !== regNumber);

    const updated = await prisma.mentorshipAssignment.update({
      where: { id: mentorship.id },
      data: {
        preferredMentors: options,
        mentorRegistrationNumber: null,
        mentorName: null,
        mentorContact: null
      }
    });

    const responseData = {
      ...updated,
      options: updated.preferredMentors || [],
      preferredPracticeAreas: undefined,
      preferredMentors: undefined
    };

    return res.status(200).json({ message: 'Mentorship option removed.', mentorship: responseData });
  } catch (error: any) {
    console.error('[Delete Mentorship Option] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error deleting mentorship option.' });
  }
}

// 7. Update a single preferred mentorship option
export async function updateMentorshipOption(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, oldRegNumber } = req.params;
  const { regNumber } = req.body;

  if (!regNumber) return res.status(400).json({ error: 'Missing new regNumber.' });

  try {
    const mentorship = await prisma.mentorshipAssignment.findUnique({
      where: { applicationId },
      include: { application: true }
    });

    if (!mentorship) return res.status(404).json({ error: 'Mentorship assignment not found.' });
    if (mentorship.application.memberId !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });

    let options = (mentorship.preferredMentors as any[]) || [];
    const index = options.findIndex(opt => opt.regNumber === oldRegNumber);

    if (index === -1) {
      return res.status(404).json({ error: 'Mentorship option not found.' });
    }

    // Lookup new member
    const member = await prisma.member.findUnique({ where: { membershipId: regNumber } });
    if (!member) {
      return res.status(404).json({ error: `Member with regNumber ${regNumber} not found.` });
    }

    options[index] = {
      regNumber: regNumber,
      name: member.fullName,
      contact: member.phoneNumber || member.email
    };

    const updated = await prisma.mentorshipAssignment.update({
      where: { id: mentorship.id },
      data: {
        preferredMentors: options,
        mentorRegistrationNumber: null,
        mentorName: null,
        mentorContact: null
      }
    });

    const responseData = {
      ...updated,
      options: updated.preferredMentors || [],
      preferredPracticeAreas: undefined,
      preferredMentors: undefined
    };

    return res.status(200).json({ message: 'Mentorship option updated.', mentorship: responseData });
  } catch (error: any) {
    console.error('[Update Mentorship Option] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error updating mentorship option.' });
  }
}
