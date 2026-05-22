import { Router } from 'express';
import { register, login, verifyOtp } from '../controllers/authController';

const router = Router();

/**
 * @openapi
 * /api/v1/auth/register:
 *   post:
 *     summary: Register a new member
 *     description: Registers a new applicant or member, securely hashes their password, and initiates the membership profile. Generates and sends a 6-digit OTP to the user's email. Does NOT return a JWT token until OTP is verified.
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
 *     responses:
 *       201:
 *         description: Profile successfully created and OTP email dispatched
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
 * /api/v1/auth/verify-otp:
 *   post:
 *     summary: Verify email using OTP
 *     description: Verifies a member's email using the 6-digit OTP sent during registration. Returns the JWT token upon success.
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
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *                 example: "new.member@example.com"
 *               otp:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Email verified successfully
 *       400:
 *         description: Invalid OTP or expired
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
router.post('/verify-otp', verifyOtp);

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
