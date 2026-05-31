import express from 'express';
import { getDocumentTypes, createDocumentType, deleteDocumentType } from '../controllers/documentTypeController';
import { requireAuth, requireRole } from '../middleware/auth';

const router = express.Router();

router.get('/', requireAuth, getDocumentTypes);
router.post('/', requireAuth, requireRole('Admin'), createDocumentType);
router.delete('/:id', requireAuth, requireRole('Admin'), deleteDocumentType);

export default router;
