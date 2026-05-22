import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabaseAdmin, prisma } from '../config/db';

// 1. Secure Binary Upload - Streams raw file buffer straight to private Supabase Storage
export async function uploadFile(req: AuthenticatedRequest, res: Response) {
  if (!req.file || !req.user) {
    return res.status(400).json({ error: 'Access Denied. Active session or file payload is missing.' });
  }

  const { applicationId, documentType } = req.body;
  if (!applicationId || !documentType) {
    return res.status(400).json({ error: 'Missing required parameters: applicationId and documentType.' });
  }

  const file = req.file;
  const uniqueName = `${documentType}_${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;
  const filePath = `applications/${applicationId}/${uniqueName}`;

  try {
    // A. Enforce security check: Is the authenticated user the owner of this application?
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { memberId: true }
    });

    if (!app) {
      return res.status(404).json({ error: 'Referenced application record does not exist.' });
    }

    const isOwner = app.memberId === req.user.id;
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied. You are not authorized to upload files for this profile.' });
    }

    // B. Stream buffer directly to Supabase private storage
    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from('riqs-membership')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: true
      });

    if (storageError) {
      console.error('[Supabase Storage Upload Error]:', storageError.message);
      return res.status(500).json({ error: `Private file storage pipeline failure: ${storageError.message}` });
    }

    // C. Retrieve version count for historical tracking of corrections
    const count = await prisma.documentVersion.count({
      where: { applicationId, documentType }
    });
    const nextVersion = count + 1;

    // D. Write to database using an atomic transaction
    const [_, docRes, __] = await prisma.$transaction([
      prisma.uploadedDocument.deleteMany({
        where: { applicationId, documentType }
      }),
      prisma.uploadedDocument.create({
        data: {
          applicationId,
          documentType,
          fileName: file.originalname,
          fileUrl: filePath,
          fileSizeBytes: file.size
        }
      }),
      prisma.documentVersion.create({
        data: {
          applicationId,
          documentType,
          fileName: file.originalname,
          fileUrl: filePath,
          fileSizeBytes: file.size,
          versionNumber: nextVersion,
          uploadedByEmail: req.user.email
        }
      })
    ]);
      
    return res.status(200).json({
      message: 'Document successfully processed and locked in private storage.',
      document: docRes,
      version: nextVersion
    });
  } catch (error: any) {
    console.error('[File Controller Upload] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error cataloging document upload.' });
  }
}

// 2. Secure Private Download - Reads raw buffer from Supabase and streams it directly to browser
export async function downloadFile(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access Denied. Active session required.' });
  }

  const { fileId } = req.params;

  try {
    // A. Fetch document pointer from database
    const doc = await prisma.uploadedDocument.findUnique({
      where: { id: fileId },
      include: { application: { select: { memberId: true } } }
    });

    if (!doc) {
      return res.status(404).json({ error: 'Document record not found in registry database.' });
    }

    // B. Validate role permission mapping
    const isOwner = doc.application.memberId === req.user.id;
    const isAuthorized = isOwner || ['admin', 'reviewer'].includes(req.user.role);

    if (!isAuthorized) {
      return res.status(403).json({ error: 'Access Denied. You do not have permissions to read this document.' });
    }

    // C. Download the raw binary stream from private bucket
    const { data, error } = await supabaseAdmin.storage
      .from('riqs-membership')
      .download(doc.fileUrl);

    if (error || !data) {
      console.error('[Supabase Storage Download Error]:', error?.message);
      return res.status(500).json({ error: 'Unable to stream binary object from private storage.' });
    }

    // D. Read response data into node buffer
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // E. Map Content-Type based on extension for browser rendering
    let contentType = 'application/octet-stream';
    if (doc.fileName.toLowerCase().endsWith('.pdf')) contentType = 'application/pdf';
    else if (doc.fileName.toLowerCase().endsWith('.png')) contentType = 'image/png';
    else if (doc.fileName.toLowerCase().endsWith('.jpg') || doc.fileName.toLowerCase().endsWith('.jpeg')) contentType = 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);
    return res.send(buffer);
  } catch (error: any) {
    console.error('[File Controller Download] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error streaming document buffer.' });
  }
}
