import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const member = await prisma.member.findFirst({
    where: { membershipId: 'RIQS-2026-TechQS-0001' },
    include: { applications: { orderBy: { updatedAt: 'desc' }, take: 1 } }
  });

  if (!member) {
    console.log("Could not find the member with ID RIQS-2026-TechQS-0001");
    return;
  }

  const app = member.applications[0];
  if (!app) return;

  const tcqsCategory = await prisma.membershipCategory.findFirst({
    where: { categoryCode: 'TcQS' }
  });

  if (tcqsCategory) {
    await prisma.application.update({
      where: { id: app.id },
      data: { categoryId: tcqsCategory.id }
    });
    console.log("Successfully fixed category to TcQS for application", app.id);
  } else {
    console.log("TcQS category not found in DB.");
  }
}

main().finally(() => prisma.$disconnect());
