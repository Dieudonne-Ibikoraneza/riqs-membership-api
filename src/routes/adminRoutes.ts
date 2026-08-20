import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';

const upload = multer({ storage: multer.memoryStorage() });
import { requireRoles } from '../middleware/rbac';
import { uploadRateLimiter } from '../middleware/rateLimiter';
import {
  getReviewQueue, handleReviewDecision,
  handleReviewerAction, handleApproverDecision,
  getApplicationDetail, assignReviewer,
  getStatusHistory, getDocumentVersions,
  getAuditLogs, updateSystemCategory, getMembersRegistry, sendAdminEmail, getApcForApplication, getAllApc,
  getStaffMembers, createStaffMember, lockStaffMember, unlockStaffMember, promoteToHeadReviewer,
  getMentorshipQueue, approveMentorshipUpgrade, flagMentorshipForCorrection, submitMentorshipReview, forwardMentorshipToApprover,
  getDashboardStats, awardFellowStatus, revokeFellowStatus, awardHonoraryStatus, revokeHonoraryStatus, createHonorableMentionMember, getMemberById, changeMembershipCategory, updateMemberHonors
} from '../controllers/adminController';

import {
  getAdminTickets, getAdminTicketDetails, adminReplyToTicket, updateTicketStatus
} from '../controllers/adminTicketController';

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
router.get('/queue', requireAuth, requireRoles(['admin', 'admin_assistant', 'reviewer', 'head_reviewer', 'approver']), getReviewQueue);

/**
 * @openapi
 * /api/v1/admin/stats:
 *   get:
 *     summary: Dashboard Statistics
 *     description: Returns role-based statistics for Admin, Reviewer, and Approver dashboards.
 *     tags:
 *       - Administrative Dashboard
 *     responses:
 *       200:
 *         description: Successfully retrieved statistics
 *       401:
 *         description: Access Denied
 *       500:
 *         description: Internal server error
 */
router.get('/stats', requireAuth, requireRoles(['admin', 'admin_assistant', 'reviewer', 'head_reviewer', 'approver']), getDashboardStats);

/**
 * @openapi
 * /api/v1/admin/members:
 *   get:
 *     summary: Paginated Members Registry (Admin/Reviewer/Approver only)
 *     description: Returns a paginated, filterable directory of all approved members.
 *     tags:
 *       - Administrative Dashboard
 */
router.get('/members', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), getMembersRegistry);
router.get('/members/:id', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), getMemberById);

/**
 * @openapi
 * /api/v1/admin/members/{id}/award-fellow:
 *   post:
 *     summary: Award Fellow Status
 *     description: Upgrades a Professional member to Fellow status.
 *     tags:
 *       - Administrative Dashboard
 */
router.post('/members/:id/award-fellow', requireAuth, requireRoles(['admin', 'approver']), awardFellowStatus);

/**
 * @openapi
 * /api/v1/admin/members/{id}/revoke-fellow:
 *   post:
 *     summary: Revoke Fellow Status
 *     description: Revokes Fellow status.
 *     tags:
 *       - Administrative Dashboard
 */
router.post('/members/:id/revoke-fellow', requireAuth, requireRoles(['admin', 'approver']), revokeFellowStatus);

/**
 * @openapi
 * /api/v1/admin/members/{id}/award-honorary:
 *   post:
 *     summary: Award Honorary Status
 *     description: Awards Honorary badge.
 *     tags:
 *       - Administrative Dashboard
 */
router.post('/members/:id/award-honorary', requireAuth, requireRoles(['admin', 'approver']), awardHonoraryStatus);

/**
 * @openapi
 * /api/v1/admin/members/{id}/revoke-honorary:
 *   post:
 *     summary: Revoke Honorary Status
 *     description: Revokes Honorary badge.
 *     tags:
 *       - Administrative Dashboard
 */
router.post('/members/:id/revoke-honorary', requireAuth, requireRoles(['admin', 'approver']), revokeHonoraryStatus);



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
router.get('/applications/:id', requireAuth, requireRoles(['admin', 'admin_assistant', 'reviewer', 'head_reviewer', 'approver']), getApplicationDetail);

/**
 * @openapi
 * /api/v1/admin/decision:
 *   post:
 *     summary: Commit Reviewer Decision (Admin/Reviewer only)
 *     description: Commit reviewer outcome (Approve, Flag, Reject). Approving generates dynamic sequence ID "RIQS-[YEAR]-[CODE]-[SEQ]" and upgrades member roll class under a single transaction, sending the application decision email.
 *     tags:
 *       - Administrative Dashboard
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
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
router.post('/decision', requireAuth, requireRoles(['admin']), handleReviewDecision);

/**
 * @openapi
 * /api/v1/admin/assign-reviewer:
 *   post:
 *     summary: Assign Reviewer to Application (Admin/Reviewer only)
 *     description: Allocates a specific staff reviewer profile. If a Reviewer calls this without a reviewerId, they "pick up" the application for themselves.
 *     tags:
 *       - Administrative Dashboard
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
 *               reviewerId:
 *                 type: string
 *                 format: uuid
 *                 description: Optional. If omitted, automatically assigns the application to the reviewer making the request.
 *     responses:
 *       200:
 *         description: Reviewer assigned
 *       404:
 *         description: Application not found
 *       500:
 *         description: Internal server error
 */
router.post('/assign-reviewer', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), assignReviewer);

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
router.get('/history/:applicationId', requireAuth, requireRoles(['admin', 'admin_assistant', 'reviewer', 'head_reviewer', 'approver']), getStatusHistory);

/**
 * @openapi
 * /api/v1/admin/apc/{applicationId}:
 *   get:
 *     summary: Fetch APC Assessment history for an application (Admin only)
 *     description: Returns all APC assessments scheduled or graded for this application's member.
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
 *         description: Successfully fetched APC history
 *       500:
 *         description: Internal server error
 */
router.get('/apc/:applicationId', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), getApcForApplication);
// Admins and Approvers both manage the APC queue: viewing records, scheduling
// boards, and recording assessment results. The controller endpoints enforce
// the same role policy for schedule/grade mutations.
router.get('/apc', requireAuth, requireRoles(['admin', 'approver']), getAllApc);

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
router.get('/document-versions/:applicationId', requireAuth, requireRoles(['admin', 'admin_assistant', 'reviewer', 'head_reviewer', 'approver']), getDocumentVersions);

/**
 * @openapi
 * /api/v1/admin/reviewer-action:
 *   post:
 *     summary: Reviewer First-Stage Action
 *     description: A Reviewer can StartReview (pick up), ReturnForCorrection, or ForwardToApprover.
 *     tags:
 *       - Administrative Dashboard
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *               - action
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               action:
 *                 type: string
 *                 enum: [StartReview, ReturnForCorrection, ForwardToApprover]
 *               notes:
 *                 type: string
 *                 description: Required when using ReturnForCorrection. Optional for ForwardToApprover.
 *     responses:
 *       200:
 *         description: Reviewer action processed
 *       400:
 *         description: Invalid state or missing fields
 *       403:
 *         description: Not a Reviewer
 */
router.post('/reviewer-action', requireAuth, requireRoles(['admin', 'admin_assistant', 'reviewer', 'head_reviewer']), handleReviewerAction);

/**
 * @openapi
 * /api/v1/admin/approver-decision:
 *   post:
 *     summary: Approver Final Decision
 *     description: Approver makes the final call — Approve (issues RIQS membership ID) or Reject. Application must be in Pending_Approval status.
 *     tags:
 *       - Administrative Dashboard
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *               - action
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               action:
 *                 type: string
 *                 enum: [Approve, Reject]
 *               notes:
 *                 type: string
 *                 description: Required when rejecting.
 *     responses:
 *       200:
 *         description: Approver decision committed
 *       400:
 *         description: Invalid state or missing fields
 *       403:
 *         description: Not an Approver
 */
router.post('/approver-decision', requireAuth, requireRoles(['admin', 'approver']), handleApproverDecision);

/**
 * @openapi
 * /api/v1/admin/audit-logs:
 *   get:
 *     summary: View System Audit Logs
 *     description: Returns a paginated list of system audit logs (Admin only).
 *     tags:
 *       - Administrative Dashboard
 *     responses:
 *       200:
 *         description: Successfully fetched audit logs
 */
router.get('/audit-logs', requireAuth, requireRoles(['admin']), getAuditLogs);

/**
 * @openapi
 * /api/v1/admin/system/categories/{id}:
 *   put:
 *     summary: Update Membership Category Parameters
 *     description: Updates fees and required documents for a category (Admin only).
 *     tags:
 *       - Administrative Dashboard
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               processingFee:
 *                 type: number
 *               firstYearFee:
 *                 type: number
 *               annualRenewalFee:
 *                 type: number
 *               stampFee:
 *                 type: number
 *               requiredDocuments:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Category parameters updated successfully
 */
router.put('/system/categories/:id', requireAuth, requireRoles(['admin']), updateSystemCategory);

router.post('/email/send', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), uploadRateLimiter, upload.array('attachments'), sendAdminEmail);

/**
 * @openapi
 * /api/v1/admin/staff:
 *   get:
 *     summary: Fetch Admin Staff Registry
 *     description: Returns a list of all internal staff (Admin, Reviewer, Approver, Teacher).
 *     tags:
 *       - Administrative Dashboard
 */
router.get('/staff', requireAuth, requireRoles(['admin', 'approver']), getStaffMembers);

/**
 * @openapi
 * /api/v1/admin/staff:
 *   post:
 *     summary: Create New Admin Staff
 *     description: Creates a new internal staff member. Auto-generates and returns a temporary password.
 *     tags:
 *       - Administrative Dashboard
 */
router.post('/staff', requireAuth, requireRoles(['admin', 'approver']), createStaffMember);

/**
 * @openapi
 * /api/v1/admin/staff/{id}/lock:
 *   patch:
 *     summary: Lock Admin Staff
 *     description: Locks an internal staff member account for a specified duration.
 *     tags:
 *       - Administrative Dashboard
 */
router.patch('/staff/:id/lock', requireAuth, requireRoles(['admin']), lockStaffMember);

/**
 * @openapi
 * /api/v1/admin/staff/{id}/unlock:
 *   patch:
 *     summary: Unlock Admin Staff
 *     description: Unlocks a previously locked internal staff member account.
 *     tags:
 *       - Administrative Dashboard
 */
router.patch('/staff/:id/unlock', requireAuth, requireRoles(['admin']), unlockStaffMember);
router.patch('/staff/:id/promote-head-reviewer', requireAuth, requireRoles(['admin']), promoteToHeadReviewer);

router.post('/members/:id/award-fellow', requireAuth, requireRoles(['admin', 'approver']), awardFellowStatus);
router.post('/members/:id/revoke-fellow', requireAuth, requireRoles(['admin', 'approver']), revokeFellowStatus);
router.post('/members/:id/change-category', requireAuth, requireRoles(['admin', 'approver']), changeMembershipCategory);
router.post('/members/:id/honors', requireAuth, requireRoles(['admin', 'approver']), updateMemberHonors);
router.post('/members/honorable-mention', requireAuth, requireRoles(['admin', 'approver']), createHonorableMentionMember);

/**
 * ----------------------------------------------------
 * SUPPORT TICKETS MANAGEMENT
 * ----------------------------------------------------
 */
router.get('/tickets', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), getAdminTickets);
router.get('/tickets/:id', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), getAdminTicketDetails);
router.post('/tickets/:id/replies', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), adminReplyToTicket);
router.patch('/tickets/:id/status', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), updateTicketStatus);

// Mentorship Queue endpoints
router.get('/mentorship/queue', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), getMentorshipQueue);
router.post('/mentorship/review', requireAuth, requireRoles(['reviewer', 'head_reviewer']), submitMentorshipReview);
router.post('/mentorship/forward', requireAuth, requireRoles(['head_reviewer']), forwardMentorshipToApprover);
router.post('/mentorship/approve', requireAuth, requireRoles(['admin', 'approver']), approveMentorshipUpgrade);
router.post('/mentorship/flag', requireAuth, requireRoles(['admin', 'reviewer', 'head_reviewer', 'approver']), flagMentorshipForCorrection);

export default router;
