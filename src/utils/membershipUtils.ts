import { MemberClass } from '@prisma/client';

/**
 * Maps a category code (from MembershipCategory) to a human-readable certificate code.
 *
 * DB format:          RIQS-2025-PrQS-0001   (dashes — safe for DB unique constraints)
 * Certificate format: RIQS/2025/PrQS/0001   (slashes — used on printed certificates)
 */
const CERT_CODE_MAP: Record<string, string> = {
  // Local individuals
  'StQS':  'StQS',
  // 'GradQS'/'GradQST' (not the bare 'GrQS'/'GrQST' categoryCode) — also keeps the two
  // Graduate routes in separate membership-ID number sequences instead of colliding on one.
  'GrQS':  'GradQS',
  'GrQST': 'GradQST',
  'TcQS':  'TcQS',
  'PrQS':  'PrQS',
  // Associate paths
  'AsQS':  'AsQS',
  'AsQST': 'AsQS',
  // Honorable Mentions
  'FQS':   'FQS',
  'LQS':   'LQS',
  'HQS':   'HQS',
  'VQS':   'VQS',
  // Foreign individuals
  'F-TcQS': 'TcQS',
  'F-PrQS': 'PrQS',
  // Local firms
  'LF-SM': 'LF',
  'LF-MD': 'LF',
  'LF-LG': 'LF',
  // Foreign firms
  'FF-SM': 'FF',
  'FF-MD': 'FF',
  'FF-LG': 'FF',
};

/**
 * Returns the certificate-display code for a given category code.
 * Falls back to the raw categoryCode if no mapping exists.
 */
export function getCertificateCode(categoryCode: string): string {
  return CERT_CODE_MAP[categoryCode] ?? categoryCode;
}

/**
 * Converts a DB membership ID (dashes) to certificate display format (slashes).
 *
 * Example: RIQS-2025-PrQS-0001  →  RIQS/2025/PrQS/0001
 */
export function formatForCertificate(membershipId: string): string {
  return membershipId.replace(/-/g, '/');
}

/**
 * Converts a certificate-display membership ID (slashes) back to DB format (dashes).
 *
 * Example: RIQS/2025/PrQS/0001  →  RIQS-2025-PrQS-0001
 */
export function formatForDb(certificateId: string): string {
  return certificateId.replace(/\//g, '-');
}

/**
 * Derives the MemberClass (professional tier) from a category code.
 *
 * membershipClass reflects the member's professional level based on experience,
 * NOT their system role (which controls what actions they can perform).
 */
export function deriveMemberClass(categoryCode: string): MemberClass {
  if (['PrQS', 'F-PrQS'].includes(categoryCode))       return MemberClass.Professional;
  if (['TcQS', 'F-TcQS'].includes(categoryCode))       return MemberClass.Technologist;
  if (['GrQS', 'GrQST'].includes(categoryCode))        return MemberClass.Graduate;
  if (['AsQS', 'AsQST'].includes(categoryCode))        return MemberClass.Associate;
  if (categoryCode === 'StQS') return MemberClass.Student;
  if (categoryCode === 'FQS')  return MemberClass.Fellow;
  if (categoryCode === 'LQS')  return MemberClass.Life_Member;
  if (categoryCode === 'HQS')  return MemberClass.Honorary_Member;
  if (categoryCode === 'VQS')  return MemberClass.Visiting_Member;
  if (categoryCode === 'LF-SM') return MemberClass.Firm_Local_Small;
  if (categoryCode === 'LF-MD') return MemberClass.Firm_Local_Medium;
  if (categoryCode === 'LF-LG') return MemberClass.Firm_Local_Large;
  if (categoryCode === 'FF-SM') return MemberClass.Firm_Foreign_Small;
  if (categoryCode === 'FF-MD') return MemberClass.Firm_Foreign_Medium;
  if (categoryCode === 'FF-LG') return MemberClass.Firm_Foreign_Large;
  return MemberClass.Graduate; // safe default
}

/**
 * Maps a SystemRole to a human-readable description of what that role can do.
 * Useful for API docs / admin UI display.
 */
export const SYSTEM_ROLE_DESCRIPTIONS: Record<string, string> = {
  Admin:    'Full system access — can approve/reject applications, manage members, and configure the registry.',
  Admin_Assistant: 'Front-desk application operations — verifies submissions, requests corrections, and forwards applications to the reviewer committee. Cannot approve, reject, or change system settings.',
  Reviewer: 'Can review and make decisions on submitted applications.',
  Teacher:  'Professional member who can sponsor/introduce student applicants.',
  Mentor:   'Professional member assigned to guide Graduate or Technologist applicants.',
  Standard: 'Normal registered member — can submit and track their own application.',
  Student:  'Student member — introduced by a teacher, limited to student-level application.',
};

/**
 * A member can end up with several FinancialTransaction rows for the same fee
 * (txType) on the same application: a manual receipt upload the admin later
 * rejected, a mobile-money gateway attempt that failed then succeeded on
 * retry, etc. Naively taking the most-recently-created row surfaces a stale
 * Failed/Unpaid attempt even after a later row for the same fee actually
 * cleared it. A transaction that has been Paid is authoritative — the fee is
 * settled — regardless of how many other attempts for it failed before or
 * after. Only when none of them succeeded do we fall back to the most recent
 * one so the member/admin sees the latest outstanding attempt.
 *
 * `txs` must already be for a single txType, ordered by createdAt desc (most
 * recent first) — the same shape every existing `orderBy: { createdAt: 'desc' }`
 * financialTransactions query already produces.
 */
export function pickAuthoritativeTransaction<T extends { status: string | null }>(txs: T[]): T | null {
  if (!txs || txs.length === 0) return null;
  return txs.find(t => t.status === 'Paid') || txs[0];
}

/**
 * Prisma AND-conditions for a member "status" bucket — the same Active / Pending Payment /
 * In Mentorship / Expired vocabulary the admin Members page filters and badges by, and that
 * the Email System's bulk-recipient group filter also needs. Shared here so both stay in
 * sync: getMembersRegistry previously computed this correctly for display but the status
 * *filter* itself was a stub that returned an empty list for anything but 'active' (and did
 * nothing for that either), while sendAdminEmail's bulk-send group filter used entirely
 * fabricated conditions — 'mentorship' queried a field that doesn't exist on Member at all
 * (an instant Prisma error), 'expired' checked yearsInProfession as a "// Simulation", and
 * 'active' applied no filter, so every "bulk send" was really "send to everyone" regardless
 * of which group was picked.
 *
 * Accepts both the Members page's display labels ("Pending Payment", "In Mentorship") and
 * the Email page's single-word group filter tokens ("pending", "mentorship") — matching is
 * case-insensitive. Returns an empty array for an unrecognized value so callers can treat
 * that as "no filter" or "invalid", whichever fits their endpoint.
 */
export function memberStatusWhereConditions(rawStatus: string): any[] {
  const normalized = (rawStatus || '').trim().toLowerCase();
  const now = new Date();
  const hasPaidProcessingFee = { financialTransactions: { some: { txType: 'Processing_Fee', status: 'Paid' } } };
  const notExpired = { OR: [{ membershipExpiresAt: null }, { membershipExpiresAt: { gte: now } }] };

  if (normalized === 'active') {
    return [hasPaidProcessingFee, notExpired, { NOT: { membershipClass: 'Graduate' } }];
  }
  if (normalized === 'pending payment' || normalized === 'pending') {
    return [{ financialTransactions: { none: { txType: 'Processing_Fee', status: 'Paid' } } }];
  }
  if (normalized === 'expired') {
    return [hasPaidProcessingFee, { membershipExpiresAt: { lt: now } }];
  }
  if (normalized === 'in mentorship' || normalized === 'mentorship') {
    return [hasPaidProcessingFee, notExpired, { membershipClass: 'Graduate' }];
  }
  return [];
}
