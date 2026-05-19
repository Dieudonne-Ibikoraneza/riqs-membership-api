import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { syncUser } from '../controllers/authController';

const router = Router();

/**
 * @openapi
 * /api/v1/auth/sync:
 *   post:
 *     summary: Synchronize Supabase Authenticated User Session
 *     description: Maps a fresh Supabase session into the custom RIQS 'members' database profile. Triggers a styled transactional Welcome Email to the applicant.
 *     tags:
 *       - Authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: OBJECT
 *             required:
 *               - fullName
 *               - phoneNumber
 *             properties:
 *               fullName:
 *                 type: string
 *                 example: Dieudonne Ibikoraneza
 *               phoneNumber:
 *                 type: string
 *                 example: "+250788123456"
 *               dob:
 *                 type: string
 *                 format: date
 *                 example: "1995-10-15"
 *               gender:
 *                 type: string
 *                 enum: [Male, Female, Other]
 *                 example: Male
 *               nationality:
 *                 type: string
 *                 example: Rwandan
 *               residencyAddress:
 *                 type: string
 *                 example: Kacyiru, Kigali, Rwanda
 *     responses:
 *       200:
 *         description: Profile already synchronized
 *       201:
 *         description: Profile successfully initialized
 *       401:
 *         description: Unauthenticated session
 *       500:
 *         description: Internal server error
 */
router.post('/sync', requireAuth, syncUser);

export default router;
