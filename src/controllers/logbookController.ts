import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { supabaseAdmin } from "../config/db";
import { AuthenticatedRequest } from "../middleware/auth";

const prisma = new PrismaClient();

const submitLogSchema = z.object({
  applicationId: z.string().uuid(),
  period: z.string().min(1)
});

export const submitLogbookEntry = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file || !req.user) {
      return res.status(400).json({ error: "Access Denied. File payload is missing." });
    }

    const data = submitLogSchema.parse(req.body);

    const app = await prisma.application.findUnique({
      where: { id: data.applicationId }
    });

    if (!app || app.memberId !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized access to application logbook" });
    }

    const file = req.file;
    const uniqueName = `logbook_${Date.now()}_${file.originalname.replace(/\s+/g, "_")}`;
    const filePath = `applications/${data.applicationId}/${uniqueName}`;

    const { error: storageError } = await supabaseAdmin.storage
      .from("riqs-membership")
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: "3600",
        upsert: true
      });

    if (storageError) {
      return res.status(500).json({ error: `Storage upload failure: ${storageError.message}` });
    }

    const logEntry = await prisma.logbookEntry.create({
      data: {
        applicationId: data.applicationId,
        period: data.period,
        documentUrl: filePath
      }
    });

    res.status(201).json(logEntry);
  } catch (error: any) {
    console.error("Error submitting logbook entry:", error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.issues });
    } else {
      res.status(500).json({ error: "Failed to submit logbook entry" });
    }
  }
};

export const getLogbookEntries = async (req: Request, res: Response) => {
  try {
    const { applicationId } = req.params;

    const entries = await prisma.logbookEntry.findMany({
      where: { applicationId },
      orderBy: { createdAt: "desc" }
    });

    res.json(entries);
  } catch (error) {
    console.error("Error fetching logbook entries:", error);
    res.status(500).json({ error: "Failed to fetch logbook entries" });
  }
};

export const getMentorshipProgress = async (req: Request, res: Response) => {
  try {
    const { applicationId } = req.params;

    const assignment = await prisma.mentorshipAssignment.findUnique({
      where: { applicationId }
    });
    
    const entries = await prisma.logbookEntry.findMany({
      where: { applicationId }
    });

    res.json({
      assignment,
      entriesCount: entries.length,
      entries
    });
  } catch (error) {
    console.error("Error fetching mentorship progress:", error);
    res.status(500).json({ error: "Failed to fetch progress" });
  }
};

const uploadReportSchema = z.object({
  applicationId: z.string().uuid(),
  year: z.enum(["1", "2"])
});

export const uploadAnnualReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file || !req.user) {
      return res.status(400).json({ error: "Access Denied. File is missing." });
    }

    const data = uploadReportSchema.parse(req.body);
    const file = req.file;
    const uniqueName = `annual_report_year_${data.year}_${Date.now()}_${file.originalname.replace(/\s+/g, "_")}`;
    const filePath = `applications/${data.applicationId}/${uniqueName}`;

    const { error: storageError } = await supabaseAdmin.storage
      .from("riqs-membership")
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (storageError) throw storageError;

    const updated = await prisma.mentorshipAssignment.update({
      where: { applicationId: data.applicationId },
      data: {
        ...(data.year === "1" ? { yearOneReportUrl: filePath } : { yearTwoReportUrl: filePath })
      }
    });

    res.json(updated);
  } catch (error) {
    console.error("Error uploading annual report:", error);
    res.status(500).json({ error: "Failed to upload report" });
  }
};

const requestUpgradeSchema = z.object({
  applicationId: z.string().uuid(),
  apcReadiness: z.enum(["Ready", "Not_Ready"])
});

export const requestUpgrade = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = requestUpgradeSchema.parse(req.body);
    
    const assignment = await prisma.mentorshipAssignment.findUnique({
      where: { applicationId: data.applicationId },
      include: { application: true }
    });
    if (!assignment) {
      return res.status(404).json({ error: "Mentorship assignment not found" });
    }
    if (!req.user || assignment.application.memberId !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized access to mentorship upgrade" });
    }

    // Each membership upgrade is a new reviewer-board cycle. Never carry
    // reviewer submissions (or the previous forwarding note) from an
    // earlier Associate/Professional upgrade into the next request.
    const startsNewReviewCycle = !assignment.upgradeRequested ||
      !["Pending_Reviewer_Board", "Pending_Admin_Review"].includes(assignment.status || "");

    const updated = await prisma.$transaction(async (tx) => {
      if (startsNewReviewCycle) {
        await tx.mentorshipReview.deleteMany({
          where: { mentorshipAssignmentId: assignment.id }
        });
      }

      return tx.mentorshipAssignment.update({
        where: { applicationId: data.applicationId },
        data: {
          upgradeRequested: true,
          apcReadiness: data.apcReadiness,
          mentorRecommended: false,
          ...(startsNewReviewCycle ? { adminNotes: null } : {}),
          status: "Pending_Mentor"
        }
      });
    });
    
    res.json(updated);
  } catch (error) {
    console.error("Error requesting upgrade:", error);
    res.status(500).json({ error: "Failed to request upgrade" });
  }
};

const submitMentorRecSchema = z.object({
  applicationId: z.string().uuid(),
  recommend: z.boolean(),
  mentorNotes: z.string().optional()
});

export const submitMentorRecommendation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = submitMentorRecSchema.parse(req.body);
    if (!req.user) return res.status(401).json({ error: "Authentication required." });
    const assignment = await prisma.mentorshipAssignment.findUnique({
      where: { applicationId: data.applicationId },
      include: { application: true }
    });
    if (!assignment) return res.status(404).json({ error: "Mentorship assignment not found." });

    const mentor = await prisma.member.findUnique({
      where: { id: req.user.id },
      select: { membershipId: true, systemRole: true }
    });
    if (mentor?.systemRole !== "Mentor" || !mentor.membershipId || assignment.mentorRegistrationNumber !== mentor.membershipId) {
      return res.status(403).json({ error: "Only the assigned mentor can submit this recommendation." });
    }
    if (!assignment.upgradeRequested) {
      return res.status(400).json({ error: "The applicant has not submitted an upgrade request yet." });
    }
    if (assignment.status !== "Pending_Mentor") {
      return res.status(400).json({ error: `This recommendation is not awaiting mentor action. Current status: ${assignment.status}.` });
    }

    const updated = await prisma.mentorshipAssignment.update({
      where: { applicationId: data.applicationId },
      data: {
        mentorRecommended: data.recommend,
        mentorNotes: data.mentorNotes?.trim() || null,
        // Every route — Associate (Not_Ready) included — goes through the
        // reviewer board before an Admin/Approver ever sees it. Skipping
        // straight to Pending_Admin_Review let an admin award Associate
        // status unilaterally with no committee review.
        status: data.recommend ? "Pending_Reviewer_Board" : "Pending_Mentor"
      }
    });

    res.json(updated);
  } catch (error) {
    console.error("Error submitting recommendation:", error);
    res.status(500).json({ error: "Failed to submit recommendation" });
  }
};

// NOTE: the legacy adminReviewUpgrade handler (PUT /upgrade/:applicationId/admin-review)
// was removed here — it let an Admin flip a mentorship upgrade straight to
// Approved/Rejected without any status check, bypassing the reviewer board and Head
// Reviewer forwarding step entirely. It was unused by the frontend; the sanctioned path
// is adminController's approveMentorshipUpgrade / flagMentorshipForCorrection.
