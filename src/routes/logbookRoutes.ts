import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import { sanitizeUpload } from "../middleware/sanitizer";
import {
  submitLogbookEntry,
  getLogbookEntries,
  getMentorshipProgress,
  uploadAnnualReport,
  requestUpgrade,
  submitMentorRecommendation,
  adminReviewUpgrade
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

// Admin routes
router.put("/upgrade/:applicationId/admin-review", requireAuth, requireRole("Admin"), adminReviewUpgrade);

export default router;
