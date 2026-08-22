import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRoles } from '../middleware/rbac';
import {
  getAPCStatus,
  registerAPC,
  gradeAPC,
  awardAssociate,
  updateMemberProfile,
  getMentorshipProgress,
  getMentees,
  requestAPC,
  bulkScheduleApc
} from '../controllers/progressionController';

const router = Router();

/**
 * @openapi
 * /api/v1/progression/apc/status:
 *   get:
 *     summary: Retrieve APC scheduling and results progression records
 *     description: Returns the APC status array, dates, panel examiners, interview scores, and licensing status for the logged-in member.
 *     tags:
 *       - Progression & APC
 *     responses:
 *       200:
 *         description: Successfully fetched APC assessment history
 *       500:
 *         description: Internal server error
 */
router.get('/apc/status', requireAuth, getAPCStatus);

/**
 * @openapi
 * /api/v1/progression/apc/request:
 *   post:
 *     summary: Request an APC Upgrade (Graduate only)
 *     description: Creates an ApcAssessment record with status 'Requested' for the Admin to schedule.
 *     tags:
 *       - Progression & APC
 *     responses:
 *       201:
 *         description: APC Upgrade requested successfully
 *       500:
 *         description: Internal server error
 */
router.post('/apc/request', requireAuth, requestAPC);

/**
 * @openapi
 * /api/v1/progression/apc/register:
 *   post:
 *     summary: Schedule a new APC Board (Admin, Approver, or Admin Assistant)
 *     description: Assigns a candidate an assessment period (one month, or a month range) for their Assessment of Professional Competency. The exact date and time are confirmed separately by the Secretariat.
 *     tags:
 *       - Progression & APC
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *               - assessmentPeriodStart
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               assessmentPeriodStart:
 *                 type: string
 *                 example: "2026-09"
 *               assessmentPeriodEnd:
 *                 type: string
 *                 example: "2026-10"
 *     responses:
 *       201:
 *         description: APC Board scheduled successfully
 *       400:
 *         description: Missing fields
 *       500:
 *         description: Internal server error
 */
router.post('/apc/register', requireAuth, requireRoles(['admin', 'approver', 'admin_assistant']), registerAPC);

/**
 * @openapi
 * /api/v1/progression/apc/grade:
 *   post:
 *     summary: Grade an APC Assessment (Admin or Approver)
 *     description: Records the pass/fail result, exam notes, and score. Passing automatically triggers a dynamic membership class upgrade in their profile database.
 *     tags:
 *       - Progression & APC
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - assessmentId
 *               - status
 *             properties:
 *               assessmentId:
 *                 type: string
 *                 format: uuid
 *               status:
 *                 type: string
 *                 enum: [Attended, Passed, Failed, No Show]
 *                 example: Passed
 *               scorePercentage:
 *                 type: number
 *                 example: 82.50
 *               assessmentNotes:
 *                 type: string
 *                 example: "Demonstrated excellent competencies in cost planning and contract administration."
 *               stampFeePaid:
 *                 type: boolean
 *                 default: false
 *               licenseIssued:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: APC assessment successfully graded and class upgraded
 *       400:
 *         description: Missing parameters or invalid status
 *       404:
 *         description: Assessment not found
 *       500:
 *         description: Internal server error
 */
router.post('/apc/grade', requireAuth, requireRoles(['admin', 'approver', 'admin_assistant']), gradeAPC);

/**
 * @openapi
 * /api/v1/progression/apc/bulk-schedule:
 *   post:
 *     summary: Bulk schedule APC assessments (Admin, Approver, or Admin Assistant)
 *     description: Schedule multiple APC assessments with a common assessment period.
 *     tags:
 *       - Progression & APC
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationIds
 *               - assessmentPeriodStart
 *             properties:
 *               applicationIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *               assessmentPeriodStart:
 *                 type: string
 *                 example: "2026-09"
 *               assessmentPeriodEnd:
 *                 type: string
 *                 example: "2026-10"
 *     responses:
 *       200:
 *         description: Bulk scheduling completed
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Internal server error
 */
router.post('/apc/bulk-schedule', requireAuth, requireRoles(['admin', 'approver', 'admin_assistant']), bulkScheduleApc);

/**
 * @openapi
 * /api/v1/progression/associate/award:
 *   post:
 *     summary: Award Associate class to a Graduate after 2-year mentorship (Admin only)
 *     description: Upgrades a Route 1 or Route 2 Graduate to Associate QS Technologist or Associate QS respectively, without requiring APC. Issues a new membership ID.
 *     tags:
 *       - Progression & APC
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Associate class awarded and new membership ID issued
 *       400:
 *         description: Invalid category or application state
 *       404:
 *         description: Application not found
 *       500:
 *         description: Internal server error
 */
router.post('/associate/award', requireAuth, requireRoles(['admin', 'approver']), awardAssociate);

/**
 * @openapi
 * /api/v1/progression/profile/update:
 *   patch:
 *     summary: Update member profile editable fields (Phase B)
 *     description: Enables members to update legal names post-approval. To prevent identity fraud, this triggers an instant, mandatory entry in the audit trail ledger.
 *     tags:
 *       - Progression & APC
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fullName
 *             properties:
 *               fullName:
 *                 type: string
 *                 example: "Dieudonne I. Ibikoraneza"
 *     responses:
 *       200:
 *         description: Name updated. Security audit trail generated.
 *       400:
 *         description: Invalid parameters
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Internal server error
 */
router.patch('/profile/update', requireAuth, updateMemberProfile);

/**
 * @openapi
 * /api/v1/progression/mentorship/progress:
 *   get:
 *     summary: Retrieve mentorship progress tracker for current member
 *     description: Returns the duration logs and status of active mentorship training assignments.
 *     tags:
 *       - Progression & APC
 *     responses:
 *       200:
 *         description: Mentorship progress parsed successfully
 *       500:
 *         description: Internal server error
 */
router.get('/mentorship/progress', requireAuth, getMentorshipProgress);

/**
 * @openapi
 * /api/v1/progression/mentees:
 *   get:
 *     summary: Retrieve list of mentees for the logged-in mentor
 *     tags:
 *       - Progression & APC
 *     responses:
 *       200:
 *         description: List of mentees retrieved successfully
 *       500:
 *         description: Internal server error
 */
router.get('/mentees', requireAuth, requireRoles(['mentor', 'admin']), getMentees);

export default router;
