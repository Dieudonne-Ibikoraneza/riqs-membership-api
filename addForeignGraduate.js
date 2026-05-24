const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  try {
    await prisma.membershipCategory.create({
      data: {
        location: 'Foreign',
        entityType: 'Individual',
        categoryName: 'Foreign Graduate Quantity Surveyor',
        categoryCode: 'FGQS',
        processingFee: 30.00,
        currency: 'USD',
        firstYearFee: 100.00,
        annualRenewalFee: 100.00,
        stampFee: 0.00
      }
    });
    console.log('Added Foreign Graduate');
  } catch (e) {
    console.log('Already exists or error:', e.message);
  }
}

run().finally(() => prisma.$disconnect());
