import { Router } from 'express';
import { getPublicMembersDirectory } from '../controllers/memberController';

const router = Router();

/**
 * @openapi
 * /api/v1/members/directory:
 *   get:
 *     summary: Public Members Directory
 *     description: Retrieve a paginated list of RIQS members for public viewing. This endpoint is PUBLIC and does not require authentication.
 *     tags:
 *       - Members Directory
 *     security: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by name or email
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by membership class
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Successfully retrieved public members directory
 *       500:
 *         description: Internal server error
 */
router.get('/directory', getPublicMembersDirectory);

export default router;
