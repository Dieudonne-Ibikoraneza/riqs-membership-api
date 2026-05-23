import { Router } from 'express';
import { register, login, verifyOtp, forgotPassword, resetPassword } from '../controllers/authController';

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
 *     description: Verifies a member's email using the 6-digit OTP sent during registration or login. Returns the JWT token upon success. For first-time verification, it also marks the email as verified and sends a welcome email.
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
 *     description: Authenticates a member with their email and password. Instead of returning a JWT token immediately, it generates a 6-digit OTP, sends it to the user's email (2FA), and returns a success message. The client must then call `/verify-otp` with the code to receive the JWT token.
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
 *         description: Login successful. OTP sent to email. (No JWT token returned yet).
 *       400:
 *         description: Missing required fields
 *       401:
 *         description: Invalid credentials
 *       500:
 *         description: Internal server error
 */
router.post('/login', login);

/**
 * @openapi
 * /api/v1/auth/forgot-password:
 *   post:
 *     summary: Request a password reset
 *     description: Generates a 6-digit OTP and sends it to the user's email if the account exists.
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
 *             properties:
 *               email:
 *                 type: string
 *                 example: "member@example.com"
 *     responses:
 *       200:
 *         description: Reset link dispatched (generic message for security)
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Internal server error
 */
router.post('/forgot-password', forgotPassword);

/**
 * @openapi
 * /api/v1/auth/reset-password:
 *   post:
 *     summary: Reset the password using OTP
 *     description: Verifies the 6-digit OTP and updates the user's password.
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
 *               - newPassword
 *             properties:
 *               email:
 *                 type: string
 *                 example: "member@example.com"
 *               otp:
 *                 type: string
 *                 example: "123456"
 *               newPassword:
 *                 type: string
 *                 example: "NewStrongPass123!"
 *     responses:
 *       200:
 *         description: Password successfully reset
 *       400:
 *         description: Invalid OTP, expired, or missing fields
 *       500:
 *         description: Internal server error
 */
router.post('/reset-password', resetPassword);

export default router;
