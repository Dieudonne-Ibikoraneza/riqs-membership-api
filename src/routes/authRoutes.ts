import { Router } from 'express';
import { register, login } from '../controllers/authController';

const router = Router();

/**
 * @openapi
 * /api/v1/auth/register:
 *   post:
 *     summary: Register a new member
 *     description: Registers a new applicant or member, securely hashes their password, and initiates the membership profile. Returns a JWT token.
 *     tags:
 *       - Authentication
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - fullName
 *             properties:
 *               email:
 *                 type: string
 *                 example: "new.member@example.com"
 *               password:
 *                 type: string
 *                 example: "SecretPass123!"
 *               fullName:
 *                 type: string
 *                 example: "John Doe"
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
 *       201:
 *         description: Profile successfully created
 *       400:
 *         description: Missing required fields
 *       409:
 *         description: User with this email already exists
 *       500:
 *         description: Internal server error
 */
router.post('/register', register);

/**
 * @openapi
 * /api/v1/auth/login:
 *   post:
 *     summary: Login to an existing member account
 *     description: Authenticates a member with their email and password, returning a JWT token for accessing protected routes.
 *     tags:
 *       - Authentication
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 example: "member@example.com"
 *               password:
 *                 type: string
 *                 example: "SecretPass123!"
 *     responses:
 *       200:
 *         description: Successfully authenticated
 *       400:
 *         description: Missing required fields
 *       401:
 *         description: Invalid credentials
 *       500:
 *         description: Internal server error
 */
router.post('/login', login);

export default router;
