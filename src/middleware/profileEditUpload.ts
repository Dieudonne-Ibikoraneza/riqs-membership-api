import multer from 'multer';
import { Request, Response, NextFunction } from 'express';

const storage = multer.memoryStorage();

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_FILES = 12; // profile photo + up to ~10 education certificates
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

const uploadConfig = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error(`Invalid file type. Only PDFs and standard images (JPEG, PNG, WEBP) are permitted. Received: ${file.mimetype}`));
    }
    cb(null, true);
  }
});

// Accepts an arbitrary set of file fields: `photo` (profile photo) and
// `certificate_<index>` (one per proposed education entry).
export function profileEditUpload(req: Request, res: Response, next: NextFunction) {
  const anyUpload = uploadConfig.any();

  anyUpload(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Upload Failed. Each file must be under 10MB.' });
        }
        return res.status(400).json({ error: `File Upload Gateway Error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}
