import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getAllTemplates = async (req: Request, res: Response) => {
  try {
    const templates = await prisma.emailTemplate.findMany({
      orderBy: { name: 'asc' },
    });
    res.status(200).json(templates);
  } catch (error) {
    console.error('Error fetching email templates:', error);
    res.status(500).json({ error: 'Failed to fetch email templates.' });
  }
};

export const getTemplateById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const template = await prisma.emailTemplate.findUnique({
      where: { id },
    });
    if (!template) {
      return res.status(404).json({ error: 'Template not found.' });
    }
    res.status(200).json(template);
  } catch (error) {
    console.error('Error fetching email template:', error);
    res.status(500).json({ error: 'Failed to fetch email template.' });
  }
};

export const updateTemplate = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, category, subject, description, body } = req.body;

    const template = await prisma.emailTemplate.update({
      where: { id },
      data: {
        name,
        category,
        subject,
        description,
        body,
        updatedAt: new Date(),
      },
    });

    res.status(200).json(template);
  } catch (error) {
    console.error('Error updating email template:', error);
    res.status(500).json({ error: 'Failed to update email template.' });
  }
};
