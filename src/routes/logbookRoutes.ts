import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { sanitizeUpload } from "../middleware/sanitizer";
import {
  submitLogbookEntry,
  getLogbookEntries,
  getMentorshipProgress,
  uploadAnnualReport,
  requestUpgrade,
  submitMentorRecommendation
} from "../controllers/logbookController";
import { uploadRateLimiter } from '../middleware/rateLimiter';

const router = Router();

// Routes for both Mentor and Mentee
router.get("/:applicationId/entries", requireAuth, getLogbookEntries);
router.get("/:applicationId/progress", requireAuth, getMentorshipProgress);

// Mentee routes
router.post("/entry", requireAuth, uploadRateLimiter, sanitizeUpload, submitLogbookEntry);
router.post("/annual-report", requireAuth, uploadRateLimiter, sanitizeUpload, uploadAnnualReport);
router.post("/request-upgrade", requireAuth, requestUpgrade);

// Mentor routes
router.post("/mentor-recommendation", requireAuth, submitMentorRecommendation);

// NOTE: the legacy `PUT /upgrade/:applicationId/admin-review` route was removed —
// it let any Admin flip a mentorship upgrade straight to Approved/Rejected without
// going through the reviewer board or Head Reviewer forwarding step at all (it didn't
// even check the assignment's current status). It was never called from the frontend;
// use /admin/mentorship/approve and /admin/mentorship/flag instead, which enforce the
// full Reviewer Board → Head Reviewer → Admin/Approver flow.

export default router;
