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

// Mentorship progression (logbook entries, annual reports, upgrade requests) is only for a
// member whose application is actually Approved AND whose first-year membership fee is
// cleared — otherwise they can progress through the whole mentorship process for a class
// they've never actually activated. Mirrors the same isFirstYearFeeCleared fallback used on
// the member-facing certificate page: if no First_Year_Fee row exists at all (some categories
// carry a zero fee and never get one, see adminController.handleApproverDecision), fall back to
// trusting membershipId rather than treating "no row" as either paid or unpaid.
async function assertMentorshipEligible(
  applicationId: string,
  memberId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { member: { select: { membershipId: true } } }
  });
  if (!app) return { ok: false, status: 404, error: "Application not found." };
  if (app.memberId !== memberId) return { ok: false, status: 403, error: "Unauthorized access to this application." };
  if (app.status !== "Approved") {
    return { ok: false, status: 403, error: "Your application must be Approved before you can access mentorship progression." };
  }

  const firstYearFeeTx = await prisma.financialTransaction.findFirst({
    where: { applicationId, txType: "First_Year_Fee" },
    orderBy: { createdAt: "desc" }
  });
  const isFirstYearFeeCleared = firstYearFeeTx ? firstYearFeeTx.status === "Paid" : Boolean(app.member.membershipId);
  if (!isFirstYearFeeCleared) {
    return { ok: false, status: 402, error: "Please pay your first-year membership fee before continuing your mentorship progression." };
  }

  return { ok: true };
}

export const submitLogbookEntry = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file || !req.user) {
      return res.status(400).json({ error: "Access Denied. File payload is missing." });
    }

    const data = submitLogSchema.parse(req.body);

    const eligibility = await assertMentorshipEligible(data.applicationId, req.user.id);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({ error: eligibility.error });
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

export const getLogbookEntries = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { applicationId } = req.params;
    if (!req.user) return res.status(401).json({ error: "Authentication required." });

    // Same missing-ownership-check shape as getMentorshipProgress below.
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { memberId: true } });
    if (!app || app.memberId !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized access to this application's logbook entries." });
    }

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

export const getMentorshipProgress = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { applicationId } = req.params;
    if (!req.user) return res.status(401).json({ error: "Authentication required." });

    // Previously missing entirely — any authenticated member could read any application's
    // mentorship progress by supplying an arbitrary applicationId, since nothing here checked
    // it belonged to them.
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { memberId: true } });
    if (!app || app.memberId !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized access to this application's mentorship progress." });
    }

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

    // Previously missing entirely on this endpoint — any authenticated member could attach an
    // annual report to someone else's application by supplying their applicationId, since
    // nothing checked ownership at all here (unlike submitLogbookEntry's `app.memberId` check).
    const eligibility = await assertMentorshipEligible(data.applicationId, req.user.id);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({ error: eligibility.error });
    }

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

    if (!assignment.mentorRegistrationNumber) {
      return res.status(400).json({ error: "A mentor must be assigned before requesting an upgrade." });
    }

    const eligibility = await assertMentorshipEligible(data.applicationId, req.user.id);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({ error: eligibility.error });
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
