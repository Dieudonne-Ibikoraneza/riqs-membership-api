import { PrismaClient, MemberClass, SystemRole } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();
const email = process.env.ADMIN_ASSISTANT_EMAIL ?? "assistant@riqs.com";
const password = process.env.ADMIN_ASSISTANT_PASSWORD ?? "";
const fullName = process.env.ADMIN_ASSISTANT_NAME ?? "Admin Assistant";

if (!password) {
  throw new Error("ADMIN_ASSISTANT_PASSWORD is required");
}

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);
  const assistant = await prisma.member.upsert({
    where: { email },
    update: {
      passwordHash,
      fullName,
      systemRole: SystemRole.Admin_Assistant,
      isEmailVerified: true,
      isLocked: false,
      lockedUntil: null,
    },
    create: {
      email,
      passwordHash,
      fullName,
      systemRole: SystemRole.Admin_Assistant,
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

  console.log("Admin Assistant user is ready:", assistant);
}

main()
  .catch((error) => {
    console.error("Failed to create Admin Assistant user:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
