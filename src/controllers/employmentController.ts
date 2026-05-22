import { Request, Response } from 'express';
import { prisma } from '../config/db';

export async function addEmployment(req: Request, res: Response) {
  try {
    const { applicationId, companyName, jobTitle, startDate, endDate, isCurrent } = req.body;

    if (!applicationId || !companyName || !jobTitle || !startDate) {
      return res.status(400).json({ error: 'Missing required fields for employment record.' });
    }

    if (!isCurrent && !endDate) {
      return res.status(400).json({ error: 'End date is required if this is not a current job.' });
    }

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    const newRecord = await prisma.employmentRecord.create({
      data: {
        applicationId,
        companyName,
        jobTitle,
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : null,
        isCurrent: isCurrent || false
      }
    });

    return res.status(201).json({
      message: 'Employment record added successfully.',
      employmentRecord: newRecord
    });
  } catch (error: any) {
    console.error('[Add Employment] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while adding employment record.' });
  }
}

export async function deleteEmployment(req: Request, res: Response) {
  try {
    const { id } = req.params;
    
    const record = await prisma.employmentRecord.findUnique({ where: { id } });
    if (!record) {
      return res.status(404).json({ error: 'Employment record not found.' });
    }

    await prisma.employmentRecord.delete({ where: { id } });
    
    return res.status(200).json({ message: 'Employment record deleted successfully.' });
  } catch (error: any) {
    console.error('[Delete Employment] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while deleting employment record.' });
  }
}

export async function getEmploymentRecords(req: Request, res: Response) {
  try {
    const { applicationId } = req.params;

    const records = await prisma.employmentRecord.findMany({
      where: { applicationId },
      orderBy: { startDate: 'desc' }
    });

    return res.status(200).json({ employmentRecords: records });
  } catch (error: any) {
    console.error('[Get Employment Records] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching employment records.' });
  }
}
