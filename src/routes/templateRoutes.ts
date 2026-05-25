import { Router } from 'express';
import { getAllTemplates, getTemplateById, updateTemplate } from '../controllers/templateController';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Only admins can manage templates
router.use(requireRole('Admin'));

router.get('/', getAllTemplates);
router.get('/:id', getTemplateById);
router.put('/:id', updateTemplate);

export default router;
