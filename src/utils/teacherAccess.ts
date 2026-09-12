import { prisma } from '../config/db';

/**
 * A teacher may only manage applications for students they personally
 * registered. Registration writes a Teacher_Registered_Student audit log
 * keyed by the teacher's email (actionByEmail) with the application id
 * embedded in `details` — that's the only record of the teacher/student
 * link, since Application has no direct "registeredByTeacherId" column.
 */
export async function isTeacherOwnerOfApplication(teacherEmail: string, applicationId: string): Promise<boolean> {
  const log = await prisma.auditLog.findFirst({
    where: {
      actionByEmail: teacherEmail,
      actionType: 'Teacher_Registered_Student',
      details: { contains: applicationId },
    },
  });
  return !!log;
}
