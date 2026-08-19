import { PrismaClient, MemberClass, SystemRole } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const email = process.env.ADMIN_EMAIL ?? "nsamuel204@gmail.com";
const password = process.env.ADMIN_PASSWORD ?? "";

if (!password) {
  throw new Error("ADMIN_PASSWORD is required");
}

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await prisma.member.upsert({
    where: { email },
    update: {
      passwordHash,
      systemRole: SystemRole.Admin,
      isEmailVerified: true,
      isLocked: false,
      lockedUntil: null,
    },
    create: {
      email,
      passwordHash,
      fullName: "Samuel Nsamuel",
      systemRole: SystemRole.Admin,
      membershipClass: MemberClass.Professional,
      isEmailVerified: true,
      isLocked: false,
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      systemRole: true,
      isEmailVerified: true,
    },
  });

  console.log("Admin user is ready:", admin);
}

main()
  .catch((error) => {
    console.error("Failed to create admin user:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
