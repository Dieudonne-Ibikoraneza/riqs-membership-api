import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  addEducationRecord, getEducationRecords, deleteEducationRecord,
  upsertStudentAssociation, upsertMentorship, updateEducationRecord
} from '../controllers/educationController';

const router = Router();

/**
 * @openapi
 * /api/v1/education:
 *   post:
 *     summary: Add an Education Record
 *     description: Adds a qualification record (University, degree level, field, dates) to an application. Enforces audit tracking if added post-approval (Phase B).
 *     tags:
 *       - Education & Mentorship
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *               - institution
 *               - qualificationType
 *               - fieldOfStudy
 *               - startDate
 *               - endDate
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               institution:
 *                 type: string
 *                 example: University of Rwanda
 *               qualificationType:
 *                 type: string
 *                 example: Bachelor of Science
 *               fieldOfStudy:
 *                 type: string
 *                 example: Quantity Surveying
 *               startDate:
 *                 type: string
 *                 format: date
 *                 example: "2018-09-01"
 *               endDate:
 *                 type: string
 *                 format: date
 *                 example: "2022-07-01"
 *     responses:
 *       201:
 *         description: Education record successfully registered
 *       400:
 *         description: Missing fields or input constraints failed
 *       403:
 *         description: Access denied (Not your application)
 *       500:
 *         description: Internal server error
 */
router.post('/', requireAuth, addEducationRecord);

/**
 * @openapi
 * /api/v1/education/{applicationId}:
 *   get:
 *     summary: Get all Education Records for Application
 *     description: Retrieves the repeatable list of education qualifications logged for a specific application.
 *     tags:
 *       - Education & Mentorship
 *     parameters:
 *       - in: path
 *         name: applicationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Application UUID
 *     responses:
 *       200:
 *         description: Successfully retrieved education list
 *       500:
 *         description: Internal server error
 */
router.get('/:applicationId', requireAuth, getEducationRecords);

/**
 * @openapi
 * /api/v1/education/{id}:
 *   put:
 *     summary: Update an Education Record
 *     tags:
 *       - Education & Mentorship
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID of the education record to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               institution:
 *                 type: string
 *               qualificationType:
 *                 type: string
 *               fieldOfStudy:
 *                 type: string
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               endDate:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Education record updated
 *       400:
 *         description: Validation error
 *       403:
 *         description: Not authorized to update this record
 *       404:
 *         description: Record not found
 */
router.put('/:id', requireAuth, updateEducationRecord);

/**
 * @openapi
 * /api/v1/education/{id}:
 *   delete:
 *     summary: Delete an Education Record
 *     description: Deletes a specific qualification record. Locked in Phase B (Post-Approval) to maintain regulatory compliance.
 *     tags:
 *       - Education & Mentorship
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Education Record UUID
 *     responses:
 *       200:
 *         description: Record deleted
 *       400:
 *         description: Cannot delete records post-approval
 *       403:
 *         description: Access Denied
 *       404:
 *         description: Record not found
 */
router.delete('/:id', requireAuth, deleteEducationRecord);

/**
 * @openapi
 * /api/v1/education/student-association:
 *   put:
 *     summary: Upsert Student Association Verification
 *     description: Configures the student association details (association name, membership code, active duration) required by graduates.
 *     tags:
 *       - Education & Mentorship
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *               - associationName
 *               - membershipNumber
 *               - registrationDate
 *               - activeYears
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               associationName:
 *                 type: string
 *                 example: RQSSA
 *               membershipNumber:
 *                 type: string
 *                 example: RQSSA-2022-0081
 *               registrationDate:
 *                 type: string
 *                 format: date
 *                 example: "2020-01-10"
 *               activeYears:
 *                 type: integer
 *                 example: 3
 *     responses:
 *       200:
 *         description: Student association validation details saved
 *       400:
 *         description: Missing fields
 *       500:
 *         description: Internal server error
 */
router.put('/student-association', requireAuth, upsertStudentAssociation);

/**
 * @openapi
 * /api/v1/education/mentorship:
 *   put:
 *     summary: Configure Mentorship Assignments
 *     description: Upserts preferred mentorship settings (identifying a private mentor OR submitting an institutional assignment request).
 *     tags:
 *       - Education & Mentorship
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
 *               options:
 *                 type: array
 *                 maxItems: 5
 *                 items:
 *                   type: object
 *                   properties:
 *                     regNumber:
 *                       type: string
 *                     name:
 *                       type: string
 *                     contact:
 *                       type: string
 *               mentorshipPlan:
 *                 type: string
 *                 example: "Detailed training schedule focusing on commercial management."
 *     responses:
 *       200:
 *         description: Mentorship assignment config saved
 *       500:
 *         description: Internal server error
 */
router.put('/mentorship', requireAuth, upsertMentorship);

export default router;
