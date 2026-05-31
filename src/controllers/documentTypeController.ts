import { Request, Response } from 'express';
import { prisma } from '../config/db';

export const getDocumentTypes = async (req: Request, res: Response) => {
  try {
    const documentTypes = await prisma.documentType.findMany({
      orderBy: { name: 'asc' },
    });
    res.status(200).json(documentTypes);
  } catch (error) {
    console.error('Error fetching document types:', error);
    res.status(500).json({ error: 'Failed to fetch document types' });
  }
};

export const createDocumentType = async (req: Request, res: Response) => {
  try {
    const { name, code, isPaymentProof } = req.body;

    if (!name || !code) {
      return res.status(400).json({ error: 'Name and Code are required' });
    }

    const existingCode = await prisma.documentType.findUnique({
      where: { code },
    });

    if (existingCode) {
      return res.status(400).json({ error: 'Document type code already exists' });
    }

    const documentType = await prisma.documentType.create({
      data: {
        name,
        code,
        isPaymentProof: isPaymentProof || false,
      },
    });

    res.status(201).json(documentType);
  } catch (error) {
    console.error('Error creating document type:', error);
    res.status(500).json({ error: 'Failed to create document type' });
  }
};

export const deleteDocumentType = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.documentType.delete({
      where: { id },
    });

    res.status(200).json({ message: 'Document type deleted successfully' });
  } catch (error) {
    console.error('Error deleting document type:', error);
    res.status(500).json({ error: 'Failed to delete document type' });
  }
};
