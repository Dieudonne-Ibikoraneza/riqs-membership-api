import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { sanitizeUpload } from '../middleware/sanitizer';
import { uploadFile, downloadFile, downloadByUrl, deleteFileByType } from '../controllers/fileController';
import { uploadRateLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * @openapi
 * /api/v1/files/upload:
 *   post:
 *     summary: Upload Document (Private Binary Buffer)
 *     description: Streams a local PDF or image to private Supabase Storage, and maps file version history tracking. Supports max 10MB size. Only PDFs and JPEGs/PNGs allowed.
 *     tags:
 *       - Private Storage Streams
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *               - applicationId
 *               - documentType
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Target PDF/image file buffer
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               documentType:
 *                 type: string
 *                 description: Type classifier (e.g., Degree, PassportPhoto, StudentAssociationCert)
 *                 example: Degree
 *     responses:
 *       200:
 *         description: Document stored successfully
 *       400:
 *         description: File missing or validation failed
 *       403:
 *         description: Not authorized to upload for this application
 *       500:
 *         description: Storage upload failed
 */
router.post('/upload', requireAuth, uploadRateLimiter, sanitizeUpload, uploadFile);

/**
 * @openapi
 * /api/v1/files/download/{fileId}:
 *   get:
 *     summary: Read/Stream Private Document inline
 *     description: Checks authorizations, downloads the binary buffer from private Supabase Storage, sets the appropriate Content-Type (image/png, image/jpeg, or application/pdf), and streams it directly inline to the browser.
 *     tags:
 *       - Private Storage Streams
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: File UUID pointer in active database
 *     responses:
 *       200:
 *         description: Streams binary object with inline Content-Disposition
 *       401:
 *         description: Unauthenticated session
 *       403:
 *         description: Access Denied (Unauthorized to view this file)
 *       404:
 *         description: Document not found
 *       500:
 *         description: Internal streaming failure
 */
router.get('/downloadByUrl', requireAuth, downloadByUrl);
router.get('/download/:fileId', requireAuth, downloadFile);

router.delete('/type/:applicationId/:documentType', requireAuth, deleteFileByType);

export default router;
