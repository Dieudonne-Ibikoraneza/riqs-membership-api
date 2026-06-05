import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  getCompetencies,
  createCompetency,
  updateCompetency,
  deleteCompetency,
  submitLogbookEntry,
  getLogbookEntries,
  getLogbookProgress,
  reviewLogbookEntry
} from "../controllers/logbookController";

const router = Router();

// Routes for both Mentor and Mentee
router.get("/competencies", requireAuth, getCompetencies);
router.post("/competencies", requireAuth, requireRole("Admin"), createCompetency);
router.put("/competencies/:id", requireAuth, requireRole("Admin"), updateCompetency);
router.delete("/competencies/:id", requireAuth, requireRole("Admin"), deleteCompetency);
router.get("/:applicationId/entries", requireAuth, getLogbookEntries);
router.get("/:applicationId/progress", requireAuth, getLogbookProgress);

// Mentee routes
router.post("/entry", requireAuth, submitLogbookEntry);

// Mentor routes
router.patch("/entry/review", requireAuth, reviewLogbookEntry);

export default router;
