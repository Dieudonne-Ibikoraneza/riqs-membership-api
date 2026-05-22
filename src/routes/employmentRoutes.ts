import { Router } from 'express';
import { addEmployment, deleteEmployment } from '../controllers/employmentController';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * @openapi
 * /api/v1/employment:
 *   post:
 *     summary: Add an Employment Record
 *     description: Adds a new employment entry (current or previous) to the member's application.
 *     tags:
 *       - Employment & Career
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *               - companyName
 *               - jobTitle
 *               - startDate
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               companyName:
 *                 type: string
 *               jobTitle:
 *                 type: string
 *               startDate:
 *                 type: string
 *                 format: date
 *               endDate:
 *                 type: string
 *                 format: date
 *               isCurrent:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Employment record added successfully
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Application not found
 *       500:
 *         description: Internal server error
 */
router.post('/', requireAuth, addEmployment);

/**
 * @openapi
 * /api/v1/employment/{id}:
 *   delete:
 *     summary: Delete an Employment Record
 *     description: Removes a specific employment record from the application.
 *     tags:
 *       - Employment & Career
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Employment Record UUID
 *     responses:
 *       200:
 *         description: Employment record deleted successfully
 *       404:
 *         description: Record not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id', requireAuth, deleteEmployment);

export default router;
