import { MemberClass } from '@prisma/client';

/**
 * Maps a category code (from MembershipCategory) to a human-readable certificate code.
 *
 * DB format:          RIQS-2025-PrQS-0001   (dashes — safe for DB unique constraints)
 * Certificate format: RIQS/2025/PrQS/0001   (slashes — used on printed certificates)
 */
const CERT_CODE_MAP: Record<string, string> = {
  // Local individuals
  'GrQS':  'GrQS',
  'GrQST': 'GrQS',
  'TcQS':  'TcQS',
  'PrQS':  'PrQS',
  // Associate paths
  'AsQS':  'AsQS',
  'AsQST': 'AsQS',
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
  if (['PQS', 'FPQS'].includes(categoryCode))       return MemberClass.Professional;
  if (['QST', 'FQST'].includes(categoryCode))       return MemberClass.Technologist;
  if (['GQS', 'GQST'].includes(categoryCode))       return MemberClass.Graduate;
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
  Reviewer: 'Can review and make decisions on submitted applications.',
  Teacher:  'Professional member who can sponsor/introduce student applicants.',
  Mentor:   'Professional member assigned to guide Graduate or Technologist applicants.',
  Standard: 'Normal registered member — can submit and track their own application.',
  Student:  'Student member — introduced by a teacher, limited to student-level application.',
};
