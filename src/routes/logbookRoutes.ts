import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  getCompetencies,
  submitLogbookEntry,
  getLogbookEntries,
  getLogbookProgress,
  reviewLogbookEntry
} from "../controllers/logbookController";

const router = Router();

// Routes for both Mentor and Mentee
router.get("/competencies", requireAuth, getCompetencies);
router.get("/:applicationId/entries", requireAuth, getLogbookEntries);
router.get("/:applicationId/progress", requireAuth, getLogbookProgress);

// Mentee routes
router.post("/entry", requireAuth, submitLogbookEntry);

// Mentor routes
router.patch("/entry/review", requireAuth, reviewLogbookEntry);

export default router;
