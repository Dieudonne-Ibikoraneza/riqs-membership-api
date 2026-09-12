import { Request, Response } from 'express';
import { prisma } from '../config/db';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { AuthenticatedRequest } from '../middleware/auth';
import { sendMail, sendRawMail } from '../config/mailer';
import { isTeacherOwnerOfApplication } from '../utils/teacherAccess';
import { TransactionType, PaymentMethod, TransactionStatus } from '@prisma/client';
import * as intouchPay from '../services/intouchPayService';
import { applyGatewayFeeResult } from './paymentController';

// Mirrors the wizard's own documentChecklist bucketing (frontend/src/app/teacher/application/[id]/page.tsx)
// so the key this check requires is exactly the key the wizard actually uploads documents under.
// A "degree"/"diploma" doc always shares the "degree" slot; a doc literally about a photo shares
// the "photo" slot (satisfied by the dedicated passport-photo widget, which uploads as
// "PassportPhoto" — aliased below); everything else uses its own typeCode (or a slug of its name
// for legacy string-only entries) so distinct requirements never collide into the same key.
function deriveDocKey(doc: any): string {
  const name = typeof doc === 'string' ? doc : (doc?.name || '');
  const typeCode = typeof doc === 'object' ? doc?.typeCode : undefined;
  const lower = name.toLowerCase();
  if (lower.includes('degree') || lower.includes('diploma')) return 'degree';
  if (lower.includes('photo')) return 'photo';
  return typeCode || lower.replace(/[^a-z0-9]/g, '_');
}

function findMissingRequiredDocs(category: { requiredDocuments: any }, uploadedDocuments: { documentType: string }[]) {
  const requiredDocsRaw = category.requiredDocuments;
  const requiredDocs = Array.isArray(requiredDocsRaw) ? requiredDocsRaw : [];
  const uploadedTypes = uploadedDocuments.map((d) => d.documentType);

  return requiredDocs
    .map((doc: any) => ({ key: deriveDocKey(doc), label: typeof doc === 'string' ? doc : (doc?.name || deriveDocKey(doc)) }))
    .filter(({ key }: { key: string }) => {
      if (key === 'photo') return !uploadedTypes.includes('photo') && !uploadedTypes.includes('PassportPhoto');
      return !uploadedTypes.includes(key);
    });
}

// Shared by the manual submit path and the Mobile Money gateway's success callback (see
// paymentController.applyGatewayFeeResult) — a student application always skips straight to
// Pending_Approval (no Reviewer phase), unlike the general applicant flow's finalizeApplicationSubmission.
export async function finalizeStudentApplicationSubmission(applicationId: string, actorEmail?: string) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { category: true, uploadedDocuments: true, member: true }
  });

  if (!app || !app.category || !app.member) {
    return { message: 'Application not found.', alreadyFinalized: true };
  }

  if (!app.status || !['Draft', 'Correction_Required'].includes(app.status)) {
    return { message: 'Application already submitted.', application: app, alreadyFinalized: true };
  }

  const missing = findMissingRequiredDocs(app.category, app.uploadedDocuments);
  if (missing.length > 0) {
    const err: any = new Error(`Cannot submit application. Missing required documents: ${missing.map((m) => m.label).join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const oldStatus = app.status;
  const resolvedActor = actorEmail
    || (await prisma.auditLog.findFirst({ where: { actionType: 'Teacher_Registered_Student', details: { contains: applicationId } } }))?.actionByEmail
    || app.member.email;

  await prisma.$transaction([
    prisma.application.update({
      where: { id: applicationId },
      data: { status: 'Pending_Approval', submittedAt: new Date(), updatedAt: new Date() }
    }),
    prisma.applicationStatusHistory.create({
      data: {
        applicationId,
        changedByEmail: resolvedActor,
        oldStatus,
        newStatus: 'Pending_Approval',
        reviewerNotes: 'Auto-forwarded to Approver by Teacher registration.'
      }
    })
  ]);

  return { message: 'Student application submitted and forwarded to Approver.', alreadyFinalized: false };
}

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

  if (!email || !fullName || !practiceLocation) {
    return res.status(400).json({ error: 'Email, full name, and practice location are required.' });
  }

  try {
    const existingMember = await prisma.member.findUnique({ where: { email } });
    if (existingMember) {
      return res.status(409).json({ error: 'User with this email already exists.' });
    }

    // Auto-generate password
    const generatedPassword = crypto.randomBytes(4).toString('hex'); // 8 char random password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(generatedPassword, saltRounds);

    // Find the category for Student / Individual / Location
    const category = await prisma.membershipCategory.findFirst({
      where: {
        entityType: 'Individual',
        location: practiceLocation,
        categoryName: { contains: 'Student' }
      }
    });

    if (!category) {
      return res.status(400).json({ error: 'System configuration error: Student category not found for ' + practiceLocation });
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
        memberId: student.id,
        actionByEmail: req.user.email,
        actionType: 'Teacher_Registered_Student',
        details: `Teacher registered student ${fullName} (${email}) and initiated application ${application.id}`
      }
    });

    // Send email with the generated password
    try {
      await sendRawMail({
        to: email,
        subject: 'RIQS Student Portal Access',
        html: `
          <div style="font-family: sans-serif; color: #333;">
            <h2>RIQS Student Portal Access</h2>
            <p>Dear ${fullName},</p>
            <p>Your teacher has created an account for you on the RIQS portal to initiate your student application.</p>
            <p>Your login details are:</p>
            <ul>
              <li><strong>Email:</strong> ${email}</li>
              <li><strong>Password:</strong> ${generatedPassword}</li>
            </ul>
            <p>Please log in and update your password, then complete your application.</p>
            <br/>
            <p>Best regards,</p>
            <p>RIQS Administration</p>
          </div>
        `
      });
    } catch (emailError: any) {
      console.error('Failed to send auto-generated password to student:', emailError.message);
    }

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
      include: { category: true }
    });
    if (!app || !app.category) return res.status(404).json({ error: 'Application not found.' });

    if (req.user.role.toLowerCase() !== 'admin') {
      const owns = await isTeacherOwnerOfApplication(req.user.email, applicationId);
      if (!owns) return res.status(404).json({ error: 'Application not found.' });
    }

    // Processing-Fee Payment Gate — mirrors applicantController.submitApplication's gate.
    // Pending_Verification counts too (a manually-uploaded proof, verified alongside review),
    // not just Paid — see that function's comment for why.
    const fee = Number(app.category.processingFee || 0);
    if (fee > 0) {
      const clearedFee = await prisma.financialTransaction.findFirst({
        where: { applicationId, txType: 'Processing_Fee', status: { in: ['Paid', 'Pending_Verification'] }, amount: fee }
      });
      if (!clearedFee) {
        return res.status(402).json({
          error: 'Processing fee payment is required before this application can be submitted.',
          code: 'PAYMENT_REQUIRED'
        });
      }
    }

    const result = await finalizeStudentApplicationSubmission(applicationId, req.user.email);
    return res.status(200).json(result);
  } catch (error: any) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('[Teacher Submit Student App] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error submitting student application.' });
  }
}

// ─── Processing Fee — Mobile Money gateway (teacher-initiated on behalf of the student) ────────
// Mirrors paymentController.initiateProcessingFeePayment/getProcessingFeePaymentStatus, but those
// scope the application lookup to `memberId: req.user.id` — the payer there IS the applicant. Here
// the payer is the teacher and the application belongs to their student, so ownership is verified
// via the Teacher_Registered_Student audit trail instead, and the resulting FinancialTransaction is
// still recorded against the student's own memberId (so it shows up on their record/receipts).
export async function initiateStudentProcessingFeePayment(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id: applicationId } = req.params;
  const { mobilephone } = req.body;
  if (!mobilephone) return res.status(400).json({ error: 'mobilephone is required.' });

  try {
    const application = await prisma.application.findFirst({
      where: { id: applicationId, status: { in: ['Draft', 'Correction_Required'] } },
      include: { category: true }
    });
    if (!application || !application.category) {
      return res.status(404).json({ error: 'Application not found or not eligible for payment.' });
    }

    if (req.user.role.toLowerCase() !== 'admin') {
      const owns = await isTeacherOwnerOfApplication(req.user.email, applicationId);
      if (!owns) return res.status(404).json({ error: 'Application not found or not eligible for payment.' });
    }

    const fee = Number(application.category.processingFee || 0);
    if (fee <= 0) {
      return res.status(400).json({ error: 'This category has no processing fee — you can submit directly.' });
    }

    const clearedFee = await prisma.financialTransaction.findFirst({
      where: { applicationId, txType: 'Processing_Fee', status: 'Paid', amount: fee }
    });
    if (clearedFee) {
      return res.status(200).json({ status: 'Paid', transactionId: clearedFee.id, message: 'Processing fee already paid.' });
    }

    const existingMomo = await prisma.financialTransaction.findFirst({
      where: { applicationId, txType: 'Processing_Fee', paymentMethod: 'Mobile_Money', providerTransactionId: { not: null } },
      orderBy: { createdAt: 'desc' }
    });

    if (existingMomo?.status === 'Pending_Verification') {
      return res.status(409).json({
        error: 'A payment request is already in progress for this application.',
        transactionId: existingMomo.id
      });
    }

    const requesttransactionid = `PROC-${applicationId.slice(0, 8)}-${Date.now()}`;

    const { data } = await intouchPay.requestPayment({ amount: fee, mobilephone, requesttransactionid });
    console.log('[Initiate Student Processing Fee Payment] IntouchPay response:', { requesttransactionid, mobilephone, amount: fee, data });

    if (!data?.success) {
      return res.status(422).json({ error: data?.message || 'Payment request was rejected by the mobile money gateway.' });
    }

    const txData = {
      memberId: application.memberId,
      applicationId,
      amount: fee,
      currency: application.category.currency || 'RWF',
      txType: 'Processing_Fee' as TransactionType,
      paymentMethod: 'Mobile_Money' as PaymentMethod,
      transactionReference: requesttransactionid,
      providerTransactionId: requesttransactionid,
      status: 'Pending_Verification' as TransactionStatus,
      rejectionReason: null
    };

    const transaction = existingMomo
      ? await prisma.financialTransaction.update({ where: { id: existingMomo.id }, data: txData })
      : await prisma.financialTransaction.create({ data: txData });

    return res.status(200).json({
      status: 'Pending',
      transactionId: transaction.id,
      message: data.message || 'Payment request sent. The student (or whoever holds that Mobile Money number) should approve the prompt on their phone.'
    });
  } catch (err: any) {
    console.error('[Initiate Student Processing Fee Payment] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error initiating payment.' });
  }
}

export async function getStudentProcessingFeePaymentStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id: applicationId, transactionId } = req.params;

  try {
    if (req.user.role.toLowerCase() !== 'admin') {
      const owns = await isTeacherOwnerOfApplication(req.user.email, applicationId);
      if (!owns) return res.status(404).json({ error: 'Transaction not found.' });
    }

    let transaction = await prisma.financialTransaction.findFirst({
      where: { id: transactionId, applicationId, txType: 'Processing_Fee' }
    });
    if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });

    if (transaction.status === 'Pending_Verification' && transaction.providerTransactionId) {
      try {
        const { data } = await intouchPay.getTransactionStatus({ requesttransactionid: transaction.providerTransactionId });
        if (data?.success && data?.status) {
          transaction = await applyGatewayFeeResult(transaction, data.status, data.statusdesc);
        }
      } catch (pollErr: any) {
        console.warn('[Student Processing Fee Status] Gateway status poll failed:', pollErr.message);
      }
    }

    return res.status(200).json({
      status: transaction.status,
      transactionId: transaction.id,
      applicationId: transaction.applicationId,
      rejectionReason: transaction.rejectionReason
    });
  } catch (error: any) {
    console.error('[Student Processing Fee Status] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error checking payment status.' });
  }
}

export async function getTeacherStudents(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    // A teacher might have registered multiple students.
    // We can find them by looking at AuditLogs where this teacher registered a student,
    // or we can add a 'registeredById' to the member table.
    // Since we don't have 'registeredById', we can extract student emails from audit logs.
    // `memberId` on these logs is the *student's* id (the subject of the action), not the
    // teacher's — the teacher who performed the registration is recorded in `actionByEmail`.
    const logs = await prisma.auditLog.findMany({
      where: {
        actionByEmail: req.user.email,
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

    if (req.user.role.toLowerCase() !== 'admin') {
      const owns = await isTeacherOwnerOfApplication(req.user.email, id);
      if (!owns) return res.status(404).json({ error: 'Application not found.' });
    }

    return res.status(200).json({ application: app });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal error' });
  }
}
