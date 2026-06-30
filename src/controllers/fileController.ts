import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabaseAdmin, prisma } from '../config/db';
import { v4 as uuidv4 } from 'uuid';

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
    let isAssignedMentor = false;

    if (req.user.role.toLowerCase() === 'mentor' && documentType === 'MentorRecommendation') {
      const mentorship = await prisma.mentorshipAssignment.findUnique({
        where: { applicationId }
      });
      const member = await prisma.member.findUnique({
        where: { id: req.user.id }
      });
      if (mentorship && member && mentorship.mentorRegistrationNumber === member.membershipId) {
        isAssignedMentor = true;
      }
    }

    const isAuthorized = isOwner || req.user.role.toLowerCase() === 'admin' || req.user.role.toLowerCase() === 'teacher' || isAssignedMentor;
    if (!isAuthorized) {
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

    const documentId = uuidv4();

    // D. Write to database using an atomic transaction
    const transactionOperations: any[] = [
      prisma.uploadedDocument.deleteMany({
        where: { applicationId, documentType }
      }),
      prisma.uploadedDocument.create({
        data: {
          id: documentId,
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
    ];

    // D. Determine if this document is a payment proof by looking up the category's document config
    //    Each category document is stored as {name, typeCode}. The uploaded `documentType` is the
    //    sanitized name key (e.g. "proof_of_momo_payment" from "Proof of MoMo Payment").
    //    We match it against the category docs, find the typeCode, then check DocumentType.isPaymentProof.
    let isPayment = false;

    const appWithCat = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { category: true }
    });

    if (appWithCat?.category) {
      const reqDocs = (appWithCat.category.requiredDocuments as any[]) || [];
      const optDocs = (appWithCat.category.optionalDocuments as any[]) || [];
      const allCatDocs = [...reqDocs, ...optDocs];

      // Find the category document entry matching the uploaded documentType key
      const matched = allCatDocs.find((d: { name: string; typeCode: string }) => {
        if (!d?.name || !d?.typeCode) return false;
        const sanitizedName = d.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        return sanitizedName === documentType || d.typeCode === documentType;
      });

      if (matched?.typeCode) {
        const bucketDef = await prisma.documentType.findUnique({ where: { code: matched.typeCode } });
        isPayment = !!(bucketDef?.isPaymentProof);
      }
    }

    if (isPayment && appWithCat?.category && req.body.skipTransaction !== 'true' && appWithCat.category.processingFee && Number(appWithCat.category.processingFee) > 0) {
      const reference = req.body.transactionReference || `PAY-${applicationId.slice(0, 8)}-${Date.now()}`;
        
        transactionOperations.push(
          prisma.financialTransaction.deleteMany({
            where: { applicationId, txType: 'Processing_Fee', status: 'Pending_Verification' }
          })
        );
        
        transactionOperations.push(
          prisma.financialTransaction.create({
            data: {
              memberId: appWithCat.memberId,
              applicationId: applicationId,
              amount: appWithCat.category.processingFee,
              currency: (appWithCat.category.currency || 'RWF') as string,
              txType: 'Processing_Fee',
              paymentMethod: 'MTN_Momo',
              transactionReference: reference,
              status: 'Pending_Verification',
              receiptUrl: documentId
            }
          })
        );
    }

    const [_, docRes] = await prisma.$transaction(transactionOperations);
      
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

export async function uploadProfilePhoto(req: AuthenticatedRequest, res: Response) {
  if (!req.file || !req.user) {
    return res.status(400).json({ error: 'Access Denied. Active session or file payload is missing.' });
  }

  const file = req.file;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
    return res.status(400).json({ error: 'Only images (JPEG/PNG/WEBP) are allowed for profile photos.' });
  }

  const uniqueName = `profile_${req.user.id}_${Date.now()}_${file.originalname.replace(/\\s+/g, '_')}`;
  const filePath = `profiles/${req.user.id}/${uniqueName}`;

  try {
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

    const updatedMember = await prisma.member.update({
      where: { id: req.user.id },
      data: { profilePhotoUrl: filePath },
      select: { profilePhotoUrl: true }
    });

    return res.status(200).json({ 
      message: 'Profile photo updated successfully', 
      profilePhotoUrl: updatedMember.profilePhotoUrl 
    });
  } catch (error: any) {
    console.error('[Upload Profile Photo Error]:', error.message);
    return res.status(500).json({ error: 'Internal server error while uploading profile photo.' });
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
    
    let isAssignedMentor = false;
    if (req.user.role.toLowerCase() === 'mentor') {
      const mentorship = await prisma.mentorshipAssignment.findUnique({
        where: { applicationId: doc.applicationId }
      });
      const member = await prisma.member.findUnique({
        where: { id: req.user.id }
      });
      if (mentorship && member && mentorship.mentorRegistrationNumber === member.membershipId) {
        isAssignedMentor = true;
      }
    }

    const isAuthorized = isOwner || ['admin', 'reviewer', 'approver', 'teacher', 'finance'].includes(req.user.role.toLowerCase()) || isAssignedMentor;

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

// 3. Delete File by Type
export async function deleteFileByType(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access Denied. Active session required.' });
  }

  const { applicationId, documentType } = req.params;

  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { memberId: true }
    });

    if (!app) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    const isOwner = app.memberId === req.user.id;
    let isAssignedMentor = false;

    if (req.user.role.toLowerCase() === 'mentor' && documentType === 'MentorRecommendation') {
      const mentorship = await prisma.mentorshipAssignment.findUnique({
        where: { applicationId }
      });
      const member = await prisma.member.findUnique({
        where: { id: req.user.id }
      });
      if (mentorship && member && mentorship.mentorRegistrationNumber === member.membershipId) {
        isAssignedMentor = true;
      }
    }

    const isAuthorized = isOwner || req.user.role.toLowerCase() === 'admin' || req.user.role.toLowerCase() === 'teacher' || isAssignedMentor;
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Access Denied.' });
    }

    const doc = await prisma.uploadedDocument.findFirst({
      where: { applicationId, documentType }
    });

    if (doc) {
      await supabaseAdmin.storage.from('riqs-membership').remove([doc.fileUrl]);
      await prisma.uploadedDocument.delete({
        where: { id: doc.id }
      });
    }

    return res.status(200).json({ message: 'Document removed successfully.' });
  } catch (error: any) {
    console.error('[File Controller Delete] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error deleting document.' });
  }
}

export async function downloadByUrl(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access Denied. Active session required.' });
  }

  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid url query parameter.' });
  }

  try {
    const { data, error } = await supabaseAdmin.storage
      .from('riqs-membership')
      .download(url);

    if (error || !data) {
      console.error('[Supabase Storage Download Error]:', error?.message);
      return res.status(500).json({ error: 'Unable to stream binary object from private storage.' });
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let contentType = 'application/octet-stream';
    if (url.toLowerCase().endsWith('.pdf')) contentType = 'application/pdf';
    else if (url.toLowerCase().endsWith('.png')) contentType = 'image/png';
    else if (url.toLowerCase().endsWith('.jpg') || url.toLowerCase().endsWith('.jpeg')) contentType = 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${url.split('/').pop()}"`);
    return res.send(buffer);
  } catch (error: any) {
    console.error('[File Controller DownloadByUrl] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error streaming document buffer.' });
  }
}
