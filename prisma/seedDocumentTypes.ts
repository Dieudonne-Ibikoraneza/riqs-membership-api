import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Predefined Document Type Buckets
 * These are system-level categories that drive backend behavior.
 * Admins select from these when configuring document requirements for a category.
 * The `name` is the display label for the type bucket shown in the Admin UI.
 * The `code` is the machine-readable key used in logic.
 * `isPaymentProof: true` triggers automatic Processing_Fee transaction creation on upload.
 */
const documentTypeBuckets = [
  {
    code: 'payment',
    name: 'Payment',
    isPaymentProof: true,
    appliesTo: 'Both',
  },
  {
    code: 'application_letter',
    name: 'Application Letter',
    isPaymentProof: false,
    appliesTo: 'Both',
  },
  {
    code: 'cv',
    name: 'CV / Resume',
    isPaymentProof: false,
    appliesTo: 'Both',
  },
  {
    code: 'certificate',
    name: 'Certificate',
    isPaymentProof: false,
    appliesTo: 'Both',
  },
  {
    code: 'transcript',
    name: 'Transcript',
    isPaymentProof: false,
    appliesTo: 'Individual',
  },
  {
    code: 'id_passport',
    name: 'ID / Passport',
    isPaymentProof: false,
    appliesTo: 'Both',
  },
  {
    code: 'photo',
    name: 'Passport Photo',
    isPaymentProof: false,
    appliesTo: 'Individual',
  },
  {
    code: 'logbook',
    name: 'Logbook',
    isPaymentProof: false,
    appliesTo: 'Individual',
  },
  {
    code: 'report',
    name: 'Report / Annual Report',
    isPaymentProof: false,
    appliesTo: 'Firm',
  },
  {
    code: 'business_registration',
    name: 'Business Registration Document',
    isPaymentProof: false,
    appliesTo: 'Firm',
  },
  {
    code: 'tax_clearance',
    name: 'Tax Clearance',
    isPaymentProof: false,
    appliesTo: 'Firm',
  },
  {
    code: 'permit',
    name: 'Visa / Work Permit',
    isPaymentProof: false,
    appliesTo: 'Individual',
  },
  {
    code: 'other',
    name: 'Other',
    isPaymentProof: false,
    appliesTo: 'Both',
  },
];

async function main() {
  console.log('Seeding document type buckets...');

  // Clear old granular seeds and replace with type buckets
  await prisma.documentType.deleteMany({});

  for (const bucket of documentTypeBuckets) {
    await prisma.documentType.create({ data: bucket });
  }

  console.log(`Seeded ${documentTypeBuckets.length} document type buckets.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
