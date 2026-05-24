import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRoles } from '../middleware/rbac';
import { sanitizeUpload } from '../middleware/sanitizer';

import {
  registerStudent,
  submitStudentApplication,
  getTeacherStudents,
  getTeacherApplicationDetail,
} from '../controllers/teacherController';

import {
  updateStudentPersonalDetails,
  addStudentEducation,
  deleteStudentEducation,
  addStudentEmployment,
  deleteStudentEmployment,
  saveStudentMentorship,
  deleteStudentMentorshipOption,
  uploadStudentDocument,
} from '../controllers/teacherAppController';

const router = Router();

// ─── Student Management ───────────────────────────────────────────────────────

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

// ─── Application Detail ───────────────────────────────────────────────────────

router.get('/application/:id', requireAuth, requireRoles(['teacher', 'admin']), getTeacherApplicationDetail);

// ─── Student Application Updates ─────────────────────────────────────────────

router.put('/application/:id/personal', requireAuth, requireRoles(['teacher', 'admin']), updateStudentPersonalDetails);

router.post('/application/:id/education', requireAuth, requireRoles(['teacher', 'admin']), addStudentEducation);
router.delete('/application/:id/education/:recordId', requireAuth, requireRoles(['teacher', 'admin']), deleteStudentEducation);

router.post('/application/:id/employment', requireAuth, requireRoles(['teacher', 'admin']), addStudentEmployment);
router.delete('/application/:id/employment/:recordId', requireAuth, requireRoles(['teacher', 'admin']), deleteStudentEmployment);

router.post('/application/:id/mentorship', requireAuth, requireRoles(['teacher', 'admin']), saveStudentMentorship);
router.delete('/application/:id/mentorship/:regNumber', requireAuth, requireRoles(['teacher', 'admin']), deleteStudentMentorshipOption);

router.post('/application/:id/upload', requireAuth, requireRoles(['teacher', 'admin']), sanitizeUpload, uploadStudentDocument);

export default router;
