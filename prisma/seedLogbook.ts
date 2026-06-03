import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const competencies = [
  {
    name: "Cost Planning & Estimation",
    description: "Preparation of cost plans, estimates, and elemental cost analyses.",
    targetHours: 400
  },
  {
    name: "Contract Administration",
    description: "Administering standard forms of contract, valuations, and variations.",
    targetHours: 400
  },
  {
    name: "Procurement & Tender Evaluation",
    description: "Preparation of tender documents, evaluation, and reporting.",
    targetHours: 300
  },
  {
    name: "Project Management",
    description: "Managing project lifecycle, stakeholder coordination, and reporting.",
    targetHours: 200
  },
  {
    name: "Quantification & Costing",
    description: "Measurement of construction works and bill of quantities preparation.",
    targetHours: 500
  }
];

async function main() {
  console.log("Seeding Logbook Competencies...");

  for (const comp of competencies) {
    await prisma.competency.upsert({
      where: { name: comp.name },
      update: {
        description: comp.description,
        targetHours: comp.targetHours
      },
      create: {
        name: comp.name,
        description: comp.description,
        targetHours: comp.targetHours
      }
    });
  }

  console.log("Competencies seeded successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
