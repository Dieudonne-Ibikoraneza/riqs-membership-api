import { PrismaClient, SystemRole, MemberClass } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  await prisma.membershipCategory.createMany({
    data: [
      // Local Individuals
      { location: 'Local', entityType: 'Individual', categoryName: 'Graduate Quantity Surveying Technologist (Route 1)', categoryCode: 'GQST', processingFee: 10000.00, currency: 'RWF', firstYearFee: 50000.00, annualRenewalFee: 70000.00, stampFee: 0.00 },
      { location: 'Local', entityType: 'Individual', categoryName: 'Graduate Quantity Surveyor (Route 2)', categoryCode: 'GQS', processingFee: 10000.00, currency: 'RWF', firstYearFee: 50000.00, annualRenewalFee: 100000.00, stampFee: 50000.00 },
      { location: 'Local', entityType: 'Individual', categoryName: 'Quantity Surveying Technologist (Route 3)', categoryCode: 'QST', processingFee: 10000.00, currency: 'RWF', firstYearFee: 0.00, annualRenewalFee: 100000.00, stampFee: 0.00 },
      { location: 'Local', entityType: 'Individual', categoryName: 'Professional Quantity Surveyor (Route 4)', categoryCode: 'PQS', processingFee: 10000.00, currency: 'RWF', firstYearFee: 0.00, annualRenewalFee: 200000.00, stampFee: 50000.00 },
      // Foreign Individuals
      { location: 'Foreign', entityType: 'Individual', categoryName: 'Foreign Quantity Surveying Technologist', categoryCode: 'FQST', processingFee: 30.00, currency: 'USD', firstYearFee: 100.00, annualRenewalFee: 100.00, stampFee: 0.00 },
      { location: 'Foreign', entityType: 'Individual', categoryName: 'Foreign Professional Quantity Surveyor', categoryCode: 'FPQS', processingFee: 50.00, currency: 'USD', firstYearFee: 200.00, annualRenewalFee: 200.00, stampFee: 0.00 },
      // Local Firms
      { location: 'Local', entityType: 'Firm', categoryName: 'Local Small Firm (<50M Rwf)', categoryCode: 'LF-SM', processingFee: 50000.00, currency: 'RWF', firstYearFee: 300000.00, annualRenewalFee: 300000.00, stampFee: 0.00 },
      { location: 'Local', entityType: 'Firm', categoryName: 'Local Medium Firm (50-100M Rwf)', categoryCode: 'LF-MD', processingFee: 100000.00, currency: 'RWF', firstYearFee: 500000.00, annualRenewalFee: 500000.00, stampFee: 0.00 },
      { location: 'Local', entityType: 'Firm', categoryName: 'Local Large Firm (>100M Rwf)', categoryCode: 'LF-LG', processingFee: 200000.00, currency: 'RWF', firstYearFee: 1000000.00, annualRenewalFee: 1000000.00, stampFee: 0.00 },
      // Foreign Firms
      { location: 'Foreign', entityType: 'Firm', categoryName: 'Foreign Small Firm (<100K USD)', categoryCode: 'FF-SM', processingFee: 100.00, currency: 'USD', firstYearFee: 1000.00, annualRenewalFee: 1000.00, stampFee: 0.00 },
      { location: 'Foreign', entityType: 'Firm', categoryName: 'Foreign Medium Firm (100-500K USD)', categoryCode: 'FF-MD', processingFee: 200.00, currency: 'USD', firstYearFee: 2000.00, annualRenewalFee: 2000.00, stampFee: 0.00 },
      { location: 'Foreign', entityType: 'Firm', categoryName: 'Foreign Large Firm (>500K USD)', categoryCode: 'FF-LG', processingFee: 400.00, currency: 'USD', firstYearFee: 3000.00, annualRenewalFee: 3000.00, stampFee: 0.00 },
    ],
    skipDuplicates: true
  });
  console.log('Database seeded with membership categories.');

  // Create testing users for different system roles
  const defaultPassword = 'Password123!';
  const passwordHash = await bcrypt.hash(defaultPassword, 10);

  const testUsers = [
    {
      email: 'dieudonne.ibikoraneza+admin@gmail.com',
      fullName: 'Dieudonne Admin',
      systemRole: SystemRole.Admin,
      membershipClass: MemberClass.Professional,
      membershipId: 'RIQS-2010-PRO-0001',
      isEmailVerified: true,
      passwordHash
    },
    {
      email: 'dieudonne.ibikoraneza+reviewer@gmail.com',
      fullName: 'Dieudonne Reviewer',
      systemRole: SystemRole.Reviewer,
      membershipClass: MemberClass.Professional,
      membershipId: 'RIQS-2015-PRO-0002',
      isEmailVerified: true,
      passwordHash
    },
    {
      email: 'dieudonne.ibikoraneza+approver@gmail.com',
      fullName: 'Dieudonne Approver',
      systemRole: SystemRole.Approver,
      membershipClass: MemberClass.Professional,
      membershipId: 'RIQS-2015-PRO-0003',
      isEmailVerified: true,
      passwordHash
    },
    {
      email: 'dieudonne.ibikoraneza+teacher@gmail.com',
      fullName: 'Dieudonne Teacher',
      systemRole: SystemRole.Teacher,
      membershipClass: MemberClass.Professional,
      membershipId: 'RIQS-2012-PRO-0003',
      isEmailVerified: true,
      passwordHash
    },
    {
      email: 'dieudonne.ibikoraneza+mentor@gmail.com',
      fullName: 'Dieudonne Mentor',
      systemRole: SystemRole.Mentor,
      membershipClass: MemberClass.Technologist,
      membershipId: 'RIQS-2018-TECH-0001',
      isEmailVerified: true,
      passwordHash
    }
  ];

  for (const user of testUsers) {
    await prisma.member.upsert({
      where: { email: user.email },
      update: {},
      create: user
    });
  }
  
  console.log('Database seeded with testing users (Admin, Reviewer, Approver, Teacher, Mentor).');
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
