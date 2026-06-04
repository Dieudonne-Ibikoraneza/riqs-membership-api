import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getApplication, createOrUpdateApplication, upsertShareholders, upsertStudentAssociation, submitApplication } from '../controllers/applicantController';

const router = Router();

/**
 * @openapi
 * /api/v1/applicants/profile:
 *   get:
 *     summary: Retrieve complete Application Packet
 *     description: Fetches the entire application state (demographics, classifications, educations, partner lists, current mentorship configurations, and document details) for the logged-in member.
 *     tags:
 *       - Applicant Portal
 *     responses:
 *       200:
 *         description: Application packet found and retrieved
 *       401:
 *         description: Unauthenticated session
 *       500:
 *         description: Internal server error
 */
router.get('/profile', requireAuth, getApplication);

/**
 * @openapi
 * /api/v1/applicants/application:
 *   patch:
 *     summary: Auto-save Wizard Draft (Phase A)
 *     description: Silent background patches for auto-saving form classifiers and employment metadata. Enforces strict Phase B category locking once approved.
 *     tags:
 *       - Applicant Portal
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - practiceLocation
 *               - entityType
 *               - categoryId
 *             properties:
 *               practiceLocation:
 *                 type: string
 *                 enum: [Rwandan, Non_Rwandan]
 *                 example: Rwandan
 *               entityType:
 *                 type: string
 *                 enum: [Individual, Firm]
 *                 example: Individual
 *               categoryId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Application draft successfully auto-saved
 *       400:
 *         description: Classifiers missing or compliance category locks violated (Phase B edit lock)
 *       500:
 *         description: Internal server error
 */
router.patch('/application', requireAuth, createOrUpdateApplication);

/**
 * @openapi
 * /api/v1/applicants/student-association:
 *   put:
 *     summary: Upsert Student Association Record
 *     description: Saves or updates the student association details for Route 1 and Route 2 applicants.
 *     tags:
 *       - Applicant Portal
 *     responses:
 *       200:
 *         description: Successfully saved
 */
router.put('/student-association', requireAuth, upsertStudentAssociation);

/**
 * @openapi
 * /api/v1/applicants/shareholders:
 *   put:
 *     summary: Enforce and save Partner Shareholder Allocations
 *     description: Re-writes firm shareholder percentages. Critically validates that the sum of all shareholders equals exactly 100.00% (allowing float divisions).
 *     tags:
 *       - Applicant Portal
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *               - shareholders
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               shareholders:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - fullName
 *                     - email
 *                     - phoneNumber
 *                     - shareholdingPercentage
 *                   properties:
 *                     fullName:
 *                       type: string
 *                       example: John Smith
 *                     email:
 *                       type: string
 *                       example: john@firm.com
 *                     phoneNumber:
 *                       type: string
 *                       example: "+250788111222"
 *                     citizenship:
 *                       type: string
 *                       example: Rwandan
 *                     shareholdingPercentage:
 *                       type: number
 *                       example: 50.00
 *                     riqsMembershipId:
 *                       type: string
 *                       example: RIQS-2022-CORP-0012
 *     responses:
 *       200:
 *         description: Shareholder percentages successfully verified and locked
 *       400:
 *         description: Missing fields, invalid share parameters, or total share sum !== 100.00%
 *       500:
 *         description: Internal server error
 */
router.put('/shareholders', requireAuth, upsertShareholders);

/**
 * @openapi
 * /api/v1/applicants/submit:
 *   post:
 *     summary: Complete and submit draft to Admin Queue
 *     description: Finalizes and locks Phase A wizard draft. Moves status to 'Pending' and triggers reviewer queue notification alerts.
 *     tags:
 *       - Applicant Portal
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
 *         description: Application locked and successfully submitted
 *       400:
 *         description: Invalid state transition (not in Draft/Correction Required state)
 *       500:
 *         description: Internal server error
 */
router.post('/submit', requireAuth, submitApplication);

export default router;
