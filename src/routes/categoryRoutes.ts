import { Router } from 'express';
import { getAllCategories, getCategoryById, updateCategory, createCategory, deleteCategory } from '../controllers/categoryController';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

/**
 * @openapi
 * /api/v1/categories:
 *   get:
 *     summary: Fetch all Membership Categories
 *     description: Retrieves list of dynamic registration fees, processing fees, currency settings, and stamp criteria based on location and entity type.
 *     tags:
 *       - System Parameters
 *     security: []
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
 *     security: []
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

/**
 * @openapi
 * /api/v1/categories/{id}:
 *   put:
 *     summary: Update Category pricing and details (Admin Only)
 *     description: Updates the category fees (processing, first year, annual, stamp). Requires Admin role.
 *     tags:
 *       - System Parameters
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               category_name:
 *                 type: string
 *               processing_fee:
 *                 type: number
 *               first_year_fee:
 *                 type: number
 *               annual_renewal_fee:
 *                 type: number
 *               stamp_fee:
 *                 type: number
 *               currency:
 *                 type: string
 *     responses:
 *       200:
 *         description: Category updated successfully
 *       403:
 *         description: Access Denied. Required role Admin.
 *       404:
 *         description: Category not found
 *       500:
 *         description: Internal server error
 */
router.put('/:id', requireAuth, requireRole('Admin'), updateCategory);

/**
 * @openapi
 * /api/v1/categories:
 *   post:
 *     summary: Create a new Category (Admin Only)
 *     description: Creates a new membership category with its pricing metrics.
 *     tags:
 *       - System Parameters
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - location
 *               - entity_type
 *               - category_name
 *               - category_code
 *               - processing_fee
 *               - first_year_fee
 *               - annual_renewal_fee
 *             properties:
 *               location:
 *                 type: string
 *                 enum: [Local, Foreign]
 *               entity_type:
 *                 type: string
 *                 enum: [Individual, Firm]
 *               category_name:
 *                 type: string
 *               category_code:
 *                 type: string
 *               processing_fee:
 *                 type: number
 *               first_year_fee:
 *                 type: number
 *               annual_renewal_fee:
 *                 type: number
 *               stamp_fee:
 *                 type: number
 *               currency:
 *                 type: string
 *     responses:
 *       201:
 *         description: Category created successfully
 *       400:
 *         description: Missing required fields
 *       403:
 *         description: Access Denied. Required role Admin.
 *       409:
 *         description: Category with this name already exists
 *       500:
 *         description: Internal server error
 */
router.post('/', requireAuth, requireRole('Admin'), createCategory);

/**
 * @openapi
 * /api/v1/categories/{id}:
 *   delete:
 *     summary: Delete a Category (Admin Only)
 *     description: Deletes a category by ID. Prevents deletion if applications are already tied to it.
 *     tags:
 *       - System Parameters
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Category deleted successfully
 *       400:
 *         description: Cannot delete, applications are tied to it
 *       403:
 *         description: Access Denied. Required role Admin.
 *       404:
 *         description: Category not found
 *       500:
 *         description: Internal server error
 */
router.delete('/:id', requireAuth, requireRole('Admin'), deleteCategory);

export default router;
