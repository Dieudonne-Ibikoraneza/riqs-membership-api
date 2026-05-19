import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRoles } from '../middleware/rbac';
import {
  getReviewQueue, handleReviewDecision,
  getApplicationDetail, assignReviewer,
  getStatusHistory, getDocumentVersions
} from '../controllers/adminController';

const router = Router();

/**
 * @openapi
 * /api/v1/admin/queue:
 *   get:
 *     summary: Paginated Administrative Registry Queue (Admin/Reviewer only)
 *     description: Returns a paginated, filterable queue listing of submitted applications. Custom access control enforced.
 *     tags:
 *       - Administrative Dashboard
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter queue list by state (Pending, Draft, etc.)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Retreived queue successfully
 *       401:
 *         description: Access Denied
 *       500:
 *         description: Internal server error
 */
router.get('/queue', requireAuth, requireRoles(['admin', 'reviewer']), getReviewQueue);

/**
 * @openapi
 * /api/v1/admin/applications/{id}:
 *   get:
 *     summary: Get Full Application Detail Packet (Admin/Reviewer only)
 *     description: Gathers all nested application data, education rows, partners, mentorship logs, files, and audit changes for the left-right review workspace.
 *     tags:
 *       - Administrative Dashboard
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Application UUID
 *     responses:
 *       200:
 *         description: Application detail found
 *       404:
 *         description: Application not found
 *       500:
 *         description: Internal server error
 */
router.get('/applications/:id', requireAuth, requireRoles(['admin', 'reviewer']), getApplicationDetail);

/**
 * @openapi
 * /api/v1/admin/decision:
 *   post:
 *     summary: Commit Reviewer Decision (Admin/Reviewer only)
 *     description: Commit reviewer outcome (Approve, Flag, Reject). Approving generates dynamic sequence ID "RIQS-[YEAR]-[CODE]-[SEQ]" and upgrades member roll class under single transaction, sending automated welcome template emails.
 *     tags:
 *       - Administrative Dashboard
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: OBJECT
 *             required:
 *               - applicationId
 *               - action
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               action:
 *                 type: string
 *                 enum: [Approve, Flag, Reject]
 *                 example: Approve
 *               notes:
 *                 type: string
 *                 description: Mandatory description notes if flagging or rejecting application.
 *                 example: "Verification note."
 *     responses:
 *       200:
 *         description: Review action successfully resolved
 *       400:
 *         description: Missing fields or validation rules violated
 *       404:
 *         description: Application not found
 *       500:
 *         description: Internal server error
 */
router.post('/decision', requireAuth, requireRoles(['admin', 'reviewer']), handleReviewDecision);

/**
 * @openapi
 * /api/v1/admin/assign-reviewer:
 *   post:
 *     summary: Assign Reviewer to Application (Admin only)
 *     description: Allocates a specific staff reviewer profile to balance application workloads.
 *     tags:
 *       - Administrative Dashboard
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: OBJECT
 *             required:
 *               - applicationId
 *               - reviewerId
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               reviewerId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Reviewer assigned
 *       404:
 *         description: Application not found
 *       500:
 *         description: Internal server error
 */
router.post('/assign-reviewer', requireAuth, requireRoles(['admin']), assignReviewer);

/**
 * @openapi
 * /api/v1/admin/history/{applicationId}:
 *   get:
 *     summary: Fetch Status Change History timeline (Admin/Reviewer only)
 *     description: Displays audit trails for review actions, date transitions, and staff notes.
 *     tags:
 *       - Administrative Dashboard
 *     parameters:
 *       - in: path
 *         name: applicationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Successfully fetched timeline
 *       500:
 *         description: Internal server error
 */
router.get('/history/:applicationId', requireAuth, requireRoles(['admin', 'reviewer']), getStatusHistory);

/**
 * @openapi
 * /api/v1/admin/document-versions/{applicationId}:
 *   get:
 *     summary: Fetch document upload history for comparisons (Admin/Reviewer only)
 *     description: Returns a listing of all historical version numbers and file URLs for comparative audit of flagged corrections.
 *     tags:
 *       - Administrative Dashboard
 *     parameters:
 *       - in: path
 *         name: applicationId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Successfully fetched document version histories
 *       500:
 *         description: Internal server error
 */
router.get('/document-versions/:applicationId', requireAuth, requireRoles(['admin', 'reviewer']), getDocumentVersions);

export default router;
