import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();

export const createCompetency = async (req: Request, res: Response) => {
  try {
    const { name, description, targetHours } = req.body;
    if (!name || targetHours == null) {
      return res.status(400).json({ error: 'Name and targetHours are required' });
    }
    const competency = await prisma.competency.create({
      data: { name, description, targetHours: parseInt(targetHours, 10) }
    });
    res.status(201).json(competency);
  } catch (error: any) {
    console.error('Error creating competency:', error);
    if (error.code === 'P2002') return res.status(400).json({ error: 'Competency name must be unique' });
    res.status(500).json({ error: 'Failed to create competency' });
  }
};

export const updateCompetency = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, targetHours } = req.body;
    const competency = await prisma.competency.update({
      where: { id },
      data: { name, description, targetHours: parseInt(targetHours, 10) }
    });
    res.json(competency);
  } catch (error: any) {
    console.error('Error updating competency:', error);
    if (error.code === 'P2025') return res.status(404).json({ error: 'Competency not found' });
    if (error.code === 'P2002') return res.status(400).json({ error: 'Competency name must be unique' });
    res.status(500).json({ error: 'Failed to update competency' });
  }
};

export const deleteCompetency = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // Check if logbook entries exist
    const count = await prisma.logbookEntry.count({ where: { competencyId: id } });
    if (count > 0) {
      return res.status(400).json({ error: 'Cannot delete competency because it is referenced by existing logbook entries.' });
    }
    await prisma.competency.delete({ where: { id } });
    res.json({ message: 'Competency deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting competency:', error);
    if (error.code === 'P2025') return res.status(404).json({ error: 'Competency not found' });
    res.status(500).json({ error: 'Failed to delete competency' });
  }
};

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

    // Also calculate overall progress, capping each competency to its target hours so over-logging doesn't artificially inflate overall completion
    const totalTarget = competencies.reduce((acc, comp) => acc + comp.targetHours, 0);
    const totalCompleted = progressMap.reduce((acc, p) => acc + Math.min(p.completedHours, p.targetHours), 0);
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
