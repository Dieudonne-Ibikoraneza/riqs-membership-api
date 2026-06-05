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

const router = Router();

// Routes for both Mentor and Mentee
router.get("/:applicationId/entries", requireAuth, getLogbookEntries);
router.get("/:applicationId/progress", requireAuth, getMentorshipProgress);

// Mentee routes
router.post("/entry", requireAuth, sanitizeUpload, submitLogbookEntry);
router.post("/annual-report", requireAuth, sanitizeUpload, uploadAnnualReport);
router.post("/request-upgrade", requireAuth, requestUpgrade);

// Mentor routes
router.post("/mentor-recommendation", requireAuth, sanitizeUpload, submitMentorRecommendation);

// Admin routes
router.put("/upgrade/:applicationId/admin-review", requireAuth, requireRole("Admin"), adminReviewUpgrade);

export default router;
