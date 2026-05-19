import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabaseAdmin, pool } from '../config/db';

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
    const appQuery = await pool.query('SELECT member_id FROM applications WHERE id = $1', [applicationId]);
    if (appQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Referenced application record does not exist.' });
    }

    const isOwner = appQuery.rows[0].member_id === req.user.id;
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied. You are not authorized to upload files for this profile.' });
    }

    // B. Stream buffer directly to Supabase private storage
    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from('riqs-documents')
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
    const verQuery = await pool.query(
      'SELECT COUNT(*) as count FROM document_versions WHERE application_id = $1 AND document_type = $2',
      [applicationId, documentType]
    );
    const nextVersion = parseInt(verQuery.rows[0].count, 10) + 1;

    // D. Write to database using an atomic transaction
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      // Clear previous active pointer of this document type for the application
      await dbClient.query(
        'DELETE FROM uploaded_documents WHERE application_id = $1 AND document_type = $2',
        [applicationId, documentType]
      );

      // Insert fresh active pointer
      const docRes = await dbClient.query(
        `INSERT INTO uploaded_documents (application_id, document_type, file_name, file_url, file_size_bytes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [applicationId, documentType, file.originalname, filePath, file.size]
      );

      // Insert historic version log
      await dbClient.query(
        `INSERT INTO document_versions (application_id, document_type, file_name, file_url, file_size_bytes, version_number, uploaded_by_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [applicationId, documentType, file.originalname, filePath, file.size, nextVersion, req.user.email]
      );

      await dbClient.query('COMMIT');
      
      return res.status(200).json({
        message: 'Document successfully processed and locked in private storage.',
        document: docRes.rows[0],
        version: nextVersion
      });
    } catch (dbErr: any) {
      await dbClient.query('ROLLBACK');
      throw dbErr;
    } finally {
      dbClient.release();
    }
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
    const docQuery = await pool.query(
      `SELECT ud.*, app.member_id 
       FROM uploaded_documents ud
       JOIN applications app ON ud.application_id = app.id
       WHERE ud.id = $1`,
      [fileId]
    );

    if (docQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Document record not found in registry database.' });
    }

    const doc = docQuery.rows[0];

    // B. Validate role permission mapping
    const isOwner = doc.member_id === req.user.id;
    const isAuthorized = isOwner || ['admin', 'reviewer'].includes(req.user.role);

    if (!isAuthorized) {
      return res.status(403).json({ error: 'Access Denied. You do not have permissions to read this document.' });
    }

    // C. Download the raw binary stream from private bucket
    const { data, error } = await supabaseAdmin.storage
      .from('riqs-documents')
      .download(doc.file_url);

    if (error || !data) {
      console.error('[Supabase Storage Download Error]:', error?.message);
      return res.status(500).json({ error: 'Unable to stream binary object from private storage.' });
    }

    // D. Read response data into node buffer
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // E. Map Content-Type based on extension for browser rendering
    let contentType = 'application/octet-stream';
    if (doc.file_name.toLowerCase().endsWith('.pdf')) contentType = 'application/pdf';
    else if (doc.file_name.toLowerCase().endsWith('.png')) contentType = 'image/png';
    else if (doc.file_name.toLowerCase().endsWith('.jpg') || doc.file_name.toLowerCase().endsWith('.jpeg')) contentType = 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
    return res.send(buffer);
  } catch (error: any) {
    console.error('[File Controller Download] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error streaming document buffer.' });
  }
}
