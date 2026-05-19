import { Router } from 'express';
import { getAllCategories, getCategoryById } from '../controllers/categoryController';

const router = Router();

/**
 * @openapi
 * /api/v1/categories:
 *   get:
 *     summary: Fetch all Membership Categories
 *     description: Retrieves list of dynamic registration fees, processing fees, currency settings, and stamp criteria based on location and entity type.
 *     tags:
 *       - System Parameters
 *     parameters:
 *       - in: query
 *         name: location
 *         schema:
 *           type: string
 *           enum: [Local, Foreign]
 *         description: Filter categories by local/foreign practice location
 *       - in: query
 *         name: entityType
 *         schema:
 *           type: string
 *           enum: [Individual, Firm]
 *         description: Filter categories by individual person or corporate firm entity
 *     responses:
 *       200:
 *         description: Successfully retrieved categories array
 *       500:
 *         description: Internal server error
 */
router.get('/', getAllCategories);

/**
 * @openapi
 * /api/v1/categories/{id}:
 *   get:
 *     summary: Fetch single Category details by ID
 *     description: Retrieves the detailed pricing metrics and stamp rules for a specific category ID.
 *     tags:
 *       - System Parameters
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Category UUID
 *     responses:
 *       200:
 *         description: Category found
 *       404:
 *         description: Category not found
 *       500:
 *         description: Internal server error
 */
router.get('/:id', getCategoryById);

export default router;
