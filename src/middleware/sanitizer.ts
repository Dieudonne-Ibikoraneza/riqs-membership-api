import multer from 'multer';
import { Request, Response, NextFunction } from 'express';

// 1. Configure Multer Memory Storage (keeps raw binary bytes in memory buffer)
const storage = multer.memoryStorage();

const MAX_FILE_SIZE = 10 * 1024 * 1024; // Strict 10MB limit per document
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];

const uploadConfig = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    // MIME-type extension validation
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error(`Invalid file type. Only notarized PDFs and standard images (JPEG, PNG) are permitted. Received: ${file.mimetype}`));
    }
    cb(null, true);
  }
});

// 2. Wrapper middleware to catch and normalize Multer file exceptions
export function sanitizeUpload(req: Request, res: Response, next: NextFunction) {
  const singleUpload = uploadConfig.single('file');

  singleUpload(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Upload Failed. The file size exceeds the strict 10MB administrative limit.' });
        }
        return res.status(400).json({ error: `File Upload Gateway Error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message });
    }

    // Verify file payload exists
    if (!req.file) {
      return res.status(400).json({ error: 'Request rejected. No binary file payload was received in this upload step.' });
    }

    next();
  });
}
