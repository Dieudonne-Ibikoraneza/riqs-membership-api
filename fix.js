const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  await prisma.$executeRaw`UPDATE applications SET assigned_reviewer_id = NULL WHERE assigned_reviewer_id NOT IN (SELECT id FROM members)`;
  console.log('Fixed');
}
run();
