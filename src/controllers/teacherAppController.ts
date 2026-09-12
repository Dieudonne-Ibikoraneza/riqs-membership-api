import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { isTeacherOwnerOfApplication } from '../utils/teacherAccess';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

// Verify that the caller has access to this student's application: an Admin can
// touch any application, but a Teacher only the ones they personally registered.
async function verifyTeacherAccess(user: { id: string; email: string; role: string }, applicationId: string) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { member: true }
  });
  if (!app) return null;

  if (user.role.toLowerCase() === 'admin') return app;

  const owns = await isTeacherOwnerOfApplication(user.email, applicationId);
  return owns ? app : null;
}

export async function updateStudentPersonalDetails(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id } = req.params;
  const data = req.body;

  try {
    const app = await verifyTeacherAccess(req.user, id);
    if (!app) return res.status(404).json({ error: 'Application not found or access denied.' });

    await prisma.member.update({
      where: { id: app.memberId },
      data: {
        fullName: data.fullName,
        phoneNumber: data.phoneNumber,
        dateOfBirth: data.dob ? new Date(data.dob) : undefined,
        nationalIdOrPassport: data.nationalIdOrPassport,
        residencyAddress: data.residencyAddress,
        workAddress: data.workAddress,
        yearsInProfession: data.yearsInProfession ? parseInt(data.yearsInProfession) : undefined,
        countryOfOrigin: data.countryOfOrigin
      }
    });

    return res.status(200).json({ message: 'Personal details updated successfully.' });
  } catch (error: any) {
    console.error('Update personal details error:', error);
    return res.status(500).json({ error: 'Failed to update personal details.' });
  }
}

export async function addStudentEducation(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id } = req.params;
  const data = req.body;

  try {
    const app = await verifyTeacherAccess(req.user, id);
    if (!app) return res.status(404).json({ error: 'Application not found.' });

    const record = await prisma.educationRecord.create({
      data: {
        applicationId: id,
        institution: data.institution,
        fieldOfStudy: data.fieldOfStudy,
        qualificationType: data.qualificationType,
        startDate: data.startDate ? new Date(data.startDate) : new Date(),
        endDate: data.endDate ? new Date(data.endDate) : new Date()
      }
    });

    return res.status(201).json({ message: 'Education record added.', education: record });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to add education.' });
  }
}

export async function deleteStudentEducation(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id, recordId } = req.params;

  try {
    const app = await verifyTeacherAccess(req.user, id);
    if (!app) return res.status(404).json({ error: 'Application not found.' });

    await prisma.educationRecord.delete({ where: { id: recordId } });
    return res.status(200).json({ message: 'Education record deleted.' });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to delete education.' });
  }
}

export async function addStudentEmployment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id } = req.params;
  const data = req.body;

  try {
    const app = await verifyTeacherAccess(req.user, id);
    if (!app) return res.status(404).json({ error: 'Application not found.' });

    const record = await prisma.employmentRecord.create({
      data: {
        applicationId: id,
        companyName: data.companyName,
        jobTitle: data.jobTitle,
        startDate: data.startDate ? new Date(data.startDate) : new Date(),
        endDate: data.endDate ? new Date(data.endDate) : null,
        isCurrent: data.isCurrent || false
      }
    });

    return res.status(201).json({ message: 'Employment record added.', employmentRecord: record });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to add employment.' });
  }
}

export async function deleteStudentEmployment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id, recordId } = req.params;

  try {
    const app = await verifyTeacherAccess(req.user, id);
    if (!app) return res.status(404).json({ error: 'Application not found.' });

    await prisma.employmentRecord.delete({ where: { id: recordId } });
    return res.status(200).json({ message: 'Employment record deleted.' });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to delete employment.' });
  }
}

export async function saveStudentMentorship(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id } = req.params;
  const { plan, options } = req.body;

  try {
    const app = await verifyTeacherAccess(req.user, id);
    if (!app) return res.status(404).json({ error: 'Application not found.' });

    await prisma.mentorshipAssignment.upsert({
      where: { applicationId: id },
      update: { mentorshipPlan: plan, preferredMentors: options },
      create: { applicationId: id, mentorshipPlan: plan, preferredMentors: options }
    });

    return res.status(200).json({ message: 'Mentorship saved.' });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to save mentorship.' });
  }
}

export async function deleteStudentMentorshipOption(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id, regNumber } = req.params;

  try {
    const app = await verifyTeacherAccess(req.user, id);
    if (!app) return res.status(404).json({ error: 'Application not found.' });

    const mentorship = await prisma.mentorshipAssignment.findUnique({ where: { applicationId: id } });
    if (mentorship) {
      const existingOptions = (mentorship.preferredMentors as any[]) || [];
      const newOptions = existingOptions.filter((o: any) => o.regNumber !== regNumber);
      await prisma.mentorshipAssignment.update({
        where: { id: mentorship.id },
        data: { preferredMentors: newOptions }
      });
    }

    return res.status(200).json({ message: 'Mentorship option removed.' });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to remove mentorship option.' });
  }
}

export async function uploadStudentDocument(req: AuthenticatedRequest, res: Response) {
  if (!req.file || !req.user) return res.status(400).json({ error: 'Access Denied. Active session or file payload is missing.' });
  const { id } = req.params;
  const { documentType } = req.body;
  if (!documentType) return res.status(400).json({ error: 'Missing documentType.' });

  const file = req.file;
  const uniqueName = `${documentType}_${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;
  const filePath = `applications/${id}/${uniqueName}`;

  try {
    const app = await verifyTeacherAccess(req.user, id);
    if (!app) return res.status(404).json({ error: 'Application not found or access denied.' });

    const { supabaseAdmin } = require('../config/db');
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('riqs-membership')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (uploadError) throw new Error(uploadError.message);

    const doc = await prisma.uploadedDocument.create({
      data: {
        applicationId: id,
        documentType,
        fileName: file.originalname,
        fileUrl: filePath,
        fileSizeBytes: file.size || 0,
      }
    });

    return res.status(200).json({ message: 'Document uploaded.', document: doc });
  } catch (error: any) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Failed to upload document.' });
  }
}
