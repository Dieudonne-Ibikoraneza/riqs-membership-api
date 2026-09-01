import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { sendRawMail } from '../config/mailer';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { deriveMemberClass, getCertificateCode } from '../utils/membershipUtils';
import { nextMembershipId } from './progressionController';

// Bulk-onboards real, already-registered members from the legacy Excel roster. Unlike every
// other admin member-creation path this can create dozens/hundreds of real login credentials
// and send that many real emails in one request, so each row is handled independently — one
// bad row (unknown category, duplicate email, etc.) is reported and skipped rather than ever
// aborting the whole batch.
const importRowSchema = z.object({
  sourceSheet: z.enum(['PROF_TECH', 'GRADUATE']),
  fullName: z.string().min(1),
  email: z.string().email(),
  phoneNumber: z.string().optional().nullable(),
  categoryCode: z.string().min(1),
  membershipIdOverride: z.string().optional().nullable(),
  registrationYear: z.number().int(),
  membershipExpiresAt: z.string().min(1),
});

const importRequestSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(500),
});

type ImportRow = z.infer<typeof importRowSchema>;

interface ImportRowResult {
  rowIndex: number;
  fullName: string;
  email: string;
  status: 'created' | 'skipped' | 'failed';
  membershipId?: string;
  reason?: string;
}

async function importOneRow(row: ImportRow, actionByEmail: string): Promise<ImportRowResult> {
  const base = { rowIndex: -1, fullName: row.fullName, email: row.email };

  try {
    const category = await prisma.membershipCategory.findFirst({
      where: { categoryCode: row.categoryCode, entityType: 'Individual' },
    });
    if (!category) {
      return { ...base, status: 'failed', reason: `Unknown category code "${row.categoryCode}".` };
    }

    // Case-insensitive — the same real member could already exist with different email casing
    // than however it happened to be typed in the source spreadsheet.
    const normalizedEmail = row.email.trim().toLowerCase();
    const existingByEmail = await prisma.member.findFirst({ where: { email: { equals: normalizedEmail, mode: 'insensitive' } } });
    if (existingByEmail) {
      return { ...base, status: 'skipped', reason: 'Email already registered.' };
    }

    let membershipId = row.membershipIdOverride || undefined;
    if (membershipId) {
      const existingById = await prisma.member.findUnique({ where: { membershipId } });
      if (existingById) {
        return { ...base, status: 'skipped', reason: `Membership ID ${membershipId} already exists.` };
      }
    } else {
      const certCode = getCertificateCode(row.categoryCode);
      membershipId = await nextMembershipId(`RIQS-${row.registrationYear}-${certCode}-`);
    }

    const membershipClass = deriveMemberClass(row.categoryCode);
    const tempPassword = crypto.randomBytes(4).toString('hex');
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const approvedAt = new Date(`${row.registrationYear}-01-01T00:00:00.000Z`);
    const membershipExpiresAt = new Date(row.membershipExpiresAt);
    const transactionReference = `IMPORT-${membershipId}`;

    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          fullName: row.fullName,
          phoneNumber: row.phoneNumber || undefined,
          membershipClass,
          membershipId,
          membershipExpiresAt,
          systemRole: 'Standard',
          isEmailVerified: true,
          // Forces the existing "must change password on first login" flow — the same
          // mechanism used for newly-created staff accounts (authController.ts already
          // checks this sentinel and the frontend already redirects to /forgot-password).
          resetPasswordOtp: 'CHANGE',
          resetPasswordExpires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
      });

      const application = await tx.application.create({
        data: {
          memberId: created.id,
          practiceLocation: category.location,
          entityType: 'Individual',
          categoryId: category.id,
          status: 'Approved',
          submittedAt: approvedAt,
          approvedAt,
          currentStep: 10,
        },
      });

      // A Paid Processing_Fee transaction is what the admin Members page's "Active" status
      // bucket actually checks for (memberStatusWhereConditions in membershipUtils.ts) —
      // without one, an imported member with a real membershipId and an Approved application
      // would still show up as "Pending Payment" in that view, misrepresenting their standing.
      await tx.financialTransaction.create({
        data: {
          memberId: created.id,
          applicationId: application.id,
          amount: category.processingFee,
          currency: category.currency || 'RWF',
          txType: 'Processing_Fee',
          paymentMethod: 'Manual_Cash',
          transactionReference,
          status: 'Paid',
          clearedAt: approvedAt,
        },
      });

      return created;
    });

    await prisma.auditLog.create({
      data: {
        memberId: member.id,
        actionByEmail,
        actionType: 'Bulk_Imported_Member',
        details: `Bulk-imported from legacy roster (${row.sourceSheet}): ${row.fullName} (${row.email}) as ${row.categoryCode}, membership ID ${membershipId}.`,
      },
    });

    sendRawMail({
      to: row.email,
      subject: 'Welcome to RIQS — Your Member Portal Account',
      html: `
        <div style="font-family: sans-serif; color: #333;">
          <h2>Welcome to the RIQS Member Portal</h2>
          <p>Dear ${row.fullName},</p>
          <p>Your RIQS membership record has been migrated into the new online member portal. Your membership ID is <strong>${membershipId}</strong>.</p>
          <p>Your login details are:</p>
          <ul>
            <li><strong>Email:</strong> ${row.email}</li>
            <li><strong>Temporary Password:</strong> ${tempPassword}</li>
          </ul>
          <p>You will be asked to set a new password the first time you log in.</p>
          <br/>
          <p>Best regards,</p>
          <p>RIQS Administration</p>
        </div>
      `,
    }).catch((err: any) => {
      console.error(`[Bulk Import] Failed to send welcome email to ${row.email}:`, err.message);
      prisma.auditLog.create({
        data: {
          memberId: member.id,
          actionByEmail: 'system@riqs.rw',
          actionType: 'EMAIL_SEND_FAILED',
          details: `Failed to send the bulk-import welcome email to ${row.email}: ${err.message}`,
        },
      }).catch(() => {});
    });

    return { ...base, status: 'created', membershipId };
  } catch (error: any) {
    console.error('[Bulk Import] Row failed:', error.message);
    return { ...base, status: 'failed', reason: error.message || 'Unknown error creating this member.' };
  }
}

export async function bulkImportMembers(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const parsed = importRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid import payload.', details: parsed.error.flatten() });
  }

  const { rows } = parsed.data;
  const results: ImportRowResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const result = await importOneRow(rows[i], req.user.email);
    result.rowIndex = i;
    results.push(result);
  }

  const summary = {
    total: results.length,
    created: results.filter(r => r.status === 'created').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'failed').length,
  };

  return res.status(200).json({ summary, results });
}
