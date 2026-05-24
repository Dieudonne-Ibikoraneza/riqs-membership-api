import { Request, Response } from 'express';
import { prisma } from '../config/db';
import bcrypt from 'bcrypt';
import { AuthenticatedRequest } from '../middleware/auth';
import { mailTemplates, sendMail } from '../config/mailer';

export async function registerStudent(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const {
    email,
    password,
    fullName,
    phoneNumber,
    dob,
    nationality,
    gender,
    residencyAddress,
    nationalIdOrPassport,
    practiceLocation
  } = req.body;

  if (!email || !password || !fullName || !practiceLocation) {
    return res.status(400).json({ error: 'Email, password, full name, and practice location are required.' });
  }

  try {
    const existingMember = await prisma.member.findUnique({ where: { email } });
    if (existingMember) {
      return res.status(409).json({ error: 'User with this email already exists.' });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Find the category for Graduate / Individual / Location
    const category = await prisma.membershipCategory.findFirst({
      where: {
        entityType: 'Individual',
        location: practiceLocation,
        categoryName: { contains: 'Graduate' }
      }
    });

    if (!category) {
      return res.status(400).json({ error: 'System configuration error: Graduate category not found for ' + practiceLocation });
    }

    // Create the student member account
    const student = await prisma.member.create({
      data: {
        email,
        passwordHash,
        fullName,
        phoneNumber,
        dateOfBirth: dob ? new Date(dob) : null,
        nationality,
        gender,
        residencyAddress,
        nationalIdOrPassport,
        systemRole: 'Standard',
        isEmailVerified: true // Auto-verified since registered by teacher
      }
    });

    // Create the Application Draft
    const application = await prisma.application.create({
      data: {
        memberId: student.id,
        categoryId: category.id,
        entityType: 'Individual',
        practiceLocation,
        status: 'Draft'
      }
    });

    // Log the action
    await prisma.auditLog.create({
      data: {
        memberId: req.user.id,
        actionByEmail: req.user.email,
        actionType: 'Teacher_Registered_Student',
        details: `Teacher registered student ${fullName} (${email}) and initiated application ${application.id}`
      }
    });

    return res.status(201).json({
      message: 'Student registered and application draft created successfully.',
      student: { id: student.id, email: student.email, fullName: student.fullName },
      application
    });
  } catch (error: any) {
    console.error('[Teacher Register Student] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error registering student.' });
  }
}

export async function submitStudentApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId } = req.body;
  if (!applicationId) return res.status(400).json({ error: 'Missing applicationId.' });

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        category: true,
        uploadedDocuments: true,
        member: true
      }
    });

    if (!app) return res.status(404).json({ error: 'Application not found.' });

    // Validate required documents
    const requiredTypes = app.category.requiredDocuments;
    const uploadedTypes = app.uploadedDocuments.map((d: any) => d.documentType);
    const missing = requiredTypes.filter((rt: any) => !uploadedTypes.includes(rt));

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Cannot submit application. Missing required documents: ${missing.join(', ')}.`
      });
    }

    const oldStatus = app.status;

    // Transition straight to Pending_Approval (skipping Reviewer phase)
    await prisma.$transaction([
      prisma.application.update({
        where: { id: applicationId },
        data: {
          status: 'Pending_Approval',
          submittedAt: new Date(),
          updatedAt: new Date()
        }
      }),
      prisma.applicationStatusHistory.create({
        data: {
          applicationId,
          changedByEmail: req.user.email,
          oldStatus,
          newStatus: 'Pending_Approval',
          reviewerNotes: 'Auto-forwarded to Approver by Teacher registration.'
        }
      })
    ]);

    try {
      await sendMail(app.member.email, mailTemplates.welcome(app.member.fullName));
    } catch (e) {
      console.error('Failed to send confirmation email', e);
    }

    return res.status(200).json({ message: 'Student application submitted and forwarded to Approver.' });
  } catch (error: any) {
    console.error('[Teacher Submit Student App] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error submitting student application.' });
  }
}

export async function getTeacherStudents(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    // A teacher might have registered multiple students.
    // We can find them by looking at AuditLogs where this teacher registered a student,
    // or we can add a 'registeredById' to the member table. 
    // Since we don't have 'registeredById', we can extract student emails from audit logs.
    const logs = await prisma.auditLog.findMany({
      where: {
        memberId: req.user.id,
        actionType: 'Teacher_Registered_Student'
      }
    });

    const studentEmails = logs.map((l: any) => {
      const match = l.details?.match(/\((.*?)\)/);
      return match ? match[1] : null;
    }).filter((e: any) => e !== null) as string[];

    const students = await prisma.member.findMany({
      where: { email: { in: studentEmails } },
      include: {
        applications: {
          include: { category: true }
        }
      }
    });

    const mapped = students.map((s: any) => ({
      id: s.id,
      fullName: s.fullName,
      email: s.email,
      applicationId: s.applications[0]?.id,
      status: s.applications[0]?.status,
      categoryName: s.applications[0]?.category?.categoryName,
      createdAt: s.createdAt
    }));

    return res.status(200).json({ students: mapped });
  } catch (error: any) {
    console.error('[Get Teacher Students] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching students.' });
  }
}

export async function getTeacherApplicationDetail(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
  const { id } = req.params;
  try {
    const app = await prisma.application.findUnique({
      where: { id },
      include: { category: true, member: true, educationRecords: true, employmentRecords: true, mentorshipAssignment: true, studentAssociation: true, uploadedDocuments: true, statusHistory: { orderBy: { createdAt: 'desc' } } }
    });
    if (!app) return res.status(404).json({ error: 'Application not found.' });
    return res.status(200).json({ application: app });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal error' });
  }
}
