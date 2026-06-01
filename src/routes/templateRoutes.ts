import { Router } from 'express';
import { getAllTemplates, getTemplateById, updateTemplate, deleteTemplate } from '../controllers/templateController';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Allow admins, reviewers and approvers to read templates
router.use(requireRole('Admin', 'Reviewer', 'Approver'));

router.get('/', getAllTemplates);
router.get('/:id', getTemplateById);

// Only admins can update or delete
router.put('/:id', requireRole('Admin'), updateTemplate);
router.delete('/:id', requireRole('Admin'), deleteTemplate);

export default router;
