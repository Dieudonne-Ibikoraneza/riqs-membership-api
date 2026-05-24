import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRoles } from '../middleware/rbac';
import { registerStudent, submitStudentApplication, getTeacherStudents, getTeacherApplicationDetail } from '../controllers/teacherController';

const router = Router();

/**
 * @openapi
 * /api/v1/teacher/students:
 *   get:
 *     summary: Get all students registered by the teacher
 *     tags:
 *       - Teacher Dashboard
 */
router.get('/students', requireAuth, requireRoles(['teacher', 'admin']), getTeacherStudents);

/**
 * @openapi
 * /api/v1/teacher/register-student:
 *   post:
 *     summary: Register a new student and start their application
 *     tags:
 *       - Teacher Dashboard
 */
router.post('/register-student', requireAuth, requireRoles(['teacher', 'admin']), registerStudent);

/**
 * @openapi
 * /api/v1/teacher/submit-student-application:
 *   post:
 *     summary: Submit a student application and forward directly to Approver
 *     tags:
 *       - Teacher Dashboard
 */
router.post('/submit-student-application', requireAuth, requireRoles(['teacher', 'admin']), submitStudentApplication);


router.get('/application/:id', requireAuth, requireRoles(['teacher', 'admin']), getTeacherApplicationDetail);

export default router;
