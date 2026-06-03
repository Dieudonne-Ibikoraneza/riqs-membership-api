import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  getCompetencies,
  submitLogbookEntry,
  getLogbookEntries,
  getLogbookProgress,
  reviewLogbookEntry
} from "../controllers/logbookController";

const router = Router();

// Routes for both Mentor and Mentee
router.get("/competencies", authenticate, getCompetencies);
router.get("/:applicationId/entries", authenticate, getLogbookEntries);
router.get("/:applicationId/progress", authenticate, getLogbookProgress);

// Mentee routes
router.post("/entry", authenticate, submitLogbookEntry);

// Mentor routes
router.patch("/entry/review", authenticate, reviewLogbookEntry);

export default router;
