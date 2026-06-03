import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();

export const getCompetencies = async (req: Request, res: Response) => {
  try {
    const competencies = await prisma.competency.findMany({
      orderBy: { name: "asc" }
    });
    res.json(competencies);
  } catch (error) {
    console.error("Error fetching competencies:", error);
    res.status(500).json({ error: "Failed to fetch competencies" });
  }
};

const submitLogSchema = z.object({
  applicationId: z.string().uuid(),
  competencyId: z.string().uuid(),
  date: z.string().datetime(),
  hoursCompleted: z.number().positive(),
  descriptionOfWork: z.string().min(10),
  supervisorName: z.string().optional()
});

export const submitLogbookEntry = async (req: Request, res: Response) => {
  try {
    const data = submitLogSchema.parse(req.body);

    // Verify the application belongs to the user
    const app = await prisma.application.findUnique({
      where: { id: data.applicationId }
    });

    if (!app || app.memberId !== (req as any).user.id) {
      return res.status(403).json({ error: "Unauthorized access to application logbook" });
    }

    const logEntry = await prisma.logbookEntry.create({
      data: {
        applicationId: data.applicationId,
        competencyId: data.competencyId,
        date: new Date(data.date),
        hoursCompleted: data.hoursCompleted,
        descriptionOfWork: data.descriptionOfWork,
        supervisorName: data.supervisorName,
        status: "Pending_Approval" // Require mentor verification
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
      include: { competency: true },
      orderBy: { date: "desc" }
    });

    res.json(entries);
  } catch (error) {
    console.error("Error fetching logbook entries:", error);
    res.status(500).json({ error: "Failed to fetch logbook entries" });
  }
};

export const getLogbookProgress = async (req: Request, res: Response) => {
  try {
    const { applicationId } = req.params;

    const entries = await prisma.logbookEntry.findMany({
      where: { 
        applicationId,
        status: "Approved"
      },
      include: { competency: true }
    });

    const competencies = await prisma.competency.findMany();

    const progressMap = competencies.map(comp => {
      const relatedLogs = entries.filter(e => e.competencyId === comp.id);
      const totalHours = relatedLogs.reduce((acc, log) => acc + Number(log.hoursCompleted), 0);
      const percentage = comp.targetHours > 0 ? Math.min(100, Math.round((totalHours / comp.targetHours) * 100)) : 0;
      
      return {
        competencyId: comp.id,
        name: comp.name,
        targetHours: comp.targetHours,
        completedHours: totalHours,
        percentage
      };
    });

    // Also calculate overall progress
    const totalTarget = competencies.reduce((acc, comp) => acc + comp.targetHours, 0);
    const totalCompleted = progressMap.reduce((acc, p) => acc + p.completedHours, 0);
    const overallProgress = totalTarget > 0 ? Math.min(100, Math.round((totalCompleted / totalTarget) * 100)) : 0;

    res.json({
      overallProgress,
      competencies: progressMap
    });
  } catch (error) {
    console.error("Error calculating logbook progress:", error);
    res.status(500).json({ error: "Failed to calculate progress" });
  }
};

const reviewLogSchema = z.object({
  entryId: z.string().uuid(),
  status: z.enum(["Approved", "Rejected"]),
  rejectionReason: z.string().optional()
});

export const reviewLogbookEntry = async (req: Request, res: Response) => {
  try {
    const data = reviewLogSchema.parse(req.body);

    // Ideally, we'd verify the logged-in user is the assigned mentor here,
    // but for now we'll allow anyone with the "Reviewer" or "Mentor" role.
    
    const entry = await prisma.logbookEntry.update({
      where: { id: data.entryId },
      data: {
        status: data.status,
        rejectionReason: data.status === "Rejected" ? data.rejectionReason : null
      }
    });

    res.json(entry);
  } catch (error) {
    console.error("Error reviewing logbook entry:", error);
    res.status(500).json({ error: "Failed to review logbook entry" });
  }
};
