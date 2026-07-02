import { Router } from 'express';
import { getPublicMembersDirectory, getMentorById, getMemberProfile, updateMemberProfile } from '../controllers/memberController';
import { uploadProfilePhoto } from '../controllers/fileController';
import { requireAuth } from '../middleware/auth';
import { sanitizeUpload } from '../middleware/sanitizer';

const router = Router();

router.post('/profile/photo', requireAuth, sanitizeUpload, uploadProfilePhoto);

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

/**
 * @openapi
 * /api/v1/members/mentors/{membershipId}:
 *   get:
 *     summary: Get Mentor by Membership ID
 *     description: Retrieve basic mentor details (full name and contact) by their membership ID.
 *     tags:
 *       - Members Directory
 *     parameters:
 *       - in: path
 *         name: membershipId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Mentor found
 *       400:
 *         description: Member is not eligible to be a mentor
 *       404:
 *         description: Mentor not found
 */
router.get('/mentors/:membershipId', getMentorById);

/**
 * @openapi
 * /api/v1/members/profile:
 *   get:
 *     summary: Get Current Member Profile
 *     description: Retrieve the authenticated member's personal profile information.
 *     tags:
 *       - Members Profile
 *     responses:
 *       200:
 *         description: Successfully retrieved member profile
 *       401:
 *         description: Unauthorized
 */
router.get('/profile', requireAuth, getMemberProfile);

/**
 * @openapi
 * /api/v1/members/profile:
 *   put:
 *     summary: Update Current Member Profile
 *     description: Update personal details for the authenticated member.
 *     tags:
 *       - Members Profile
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fullName:
 *                 type: string
 *                 example: "Dieudonne Ibikoraneza"
 *               phoneNumber:
 *                 type: string
 *                 example: "+250788123456"
 *               dob:
 *                 type: string
 *                 format: date
 *                 example: "1995-01-01"
 *               gender:
 *                 type: string
 *                 example: "Male"
 *               nationality:
 *                 type: string
 *                 example: "Rwandan"
 *               nationalIdOrPassport:
 *                 type: string
 *                 example: "1199580000000000"
 *               countryOfOrigin:
 *                 type: string
 *                 example: "Rwanda"
 *               residencyAddress:
 *                 type: object
 *                 example: { "district": "Gasabo", "sector": "Kimironko", "cell": "Kibagabaga" }
 *               workAddress:
 *                 type: object
 *                 example: { "district": "Nyarugenge", "company": "Mulinga Labs" }
 *               yearsInProfession:
 *                 type: integer
 *                 example: 3
 *     responses:
 *       200:
 *         description: Successfully updated profile
 *       401:
 *         description: Unauthorized
 */
router.put('/profile', requireAuth, updateMemberProfile);

export default router;
