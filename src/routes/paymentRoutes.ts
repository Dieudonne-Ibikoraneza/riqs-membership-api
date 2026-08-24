import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRoles } from '../middleware/rbac';
import { rateLimit } from 'express-rate-limit';
import {
  submitPayment,
  getPaymentHistory,
  verifyPayment,
  getPendingPayments,
  initiateProcessingFeePayment,
  getProcessingFeePaymentStatus
} from '../controllers/paymentController';

const router = Router();

// Guards the member-facing IntouchPay-driven endpoints below from accidental hammering
// (e.g. a runaway poll loop), mirroring the limiter already used on the admin IntouchPay routes.
const momoRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many payment requests. Please try again shortly.' }
});

/**
 * @openapi
 * /api/v1/payments/submit:
 *   post:
 *     summary: Submit a Payment Transaction
 *     description: Registers a new fee transaction (MTN Momo ref code or bank slip reference) to the double-entry financial ledger. Enforces duplicate reference detection for anti-fraud security.
 *     tags:
 *       - Payments & Invoices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *               - currency
 *               - txType
 *               - paymentMethod
 *               - transactionReference
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               amount:
 *                 type: number
 *                 example: 10000
 *               currency:
 *                 type: string
 *                 enum: [RWF, USD]
 *                 example: RWF
 *               txType:
 *                 type: string
 *                 enum: [Processing_Fee, First_Year_Fee, Annual_Renewal, Stamp_Fee, APC_Fee]
 *                 example: Processing_Fee
 *               paymentMethod:
 *                 type: string
 *                 enum: [MTN_Momo, Bank_Transfer, Card_Payment, Manual_Cash]
 *                 example: MTN_Momo
 *               transactionReference:
 *                 type: string
 *                 example: MOMO-REF-998877A
 *     responses:
 *       201:
 *         description: Transaction record successfully logged (Pending Verification)
 *       400:
 *         description: Missing fields or schema validation failed
 *       409:
 *         description: Anti-Fraud Trigger — Duplicate transaction reference code
 *       500:
 *         description: Internal server error
 */
router.post('/submit', requireAuth, submitPayment);

/**
 * @openapi
 * /api/v1/payments/history:
 *   get:
 *     summary: Fetch member payment history
 *     description: Returns the full chronological array of financial ledger transactions submitted by the logged-in member.
 *     tags:
 *       - Payments & Invoices
 *     responses:
 *       200:
 *         description: Successfully fetched member ledger
 *       500:
 *         description: Internal server error
 */
router.get('/history', requireAuth, getPaymentHistory);

/**
 * @openapi
 * /api/v1/payments/verify:
 *   post:
 *     summary: Verify/Clear Payment (Finance/Admin only)
 *     description: Clearance action for finance/admin roles to clear, fail, or refund a pending ledger transaction. Automatically logs an administrative audit trace.
 *     tags:
 *       - Payments & Invoices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - transactionId
 *               - action
 *             properties:
 *               transactionId:
 *                 type: string
 *                 format: uuid
 *               action:
 *                 type: string
 *                 enum: [Paid, Failed, Refunded]
 *                 example: Paid
 *               rejectionReason:
 *                 type: string
 *                 description: Mandatory description of failure reason if failing/refunding transaction
 *                 example: "Fraudulent Bank Transfer reference number."
 *     responses:
 *       200:
 *         description: Transaction status successfully modified
 *       400:
 *         description: Missing parameters or invalid clearance action
 *       500:
 *         description: Internal server error
 */
router.post('/verify', requireAuth, requireRoles(['admin', 'admin_assistant', 'finance']), verifyPayment);

/**
 * @openapi
 * /api/v1/payments/queue:
 *   get:
 *     summary: Fetch Payments Review Queue (Finance/Admin only)
 *     description: Paginated queue listing transactions awaiting review, clearance, or audit processing.
 *     tags:
 *       - Payments & Invoices
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           default: Pending_Verification
 *         description: Filter queue by payment state
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Retreived queue successfully
 *       401:
 *         description: Access Denied
 *       500:
 *         description: Internal server error
 */
router.get('/queue', requireAuth, requireRoles(['admin', 'admin_assistant', 'finance']), getPendingPayments);

/**
 * @openapi
 * /api/v1/payments/processing-fee/initiate:
 *   post:
 *     summary: Pay an application's Processing Fee via Mobile Money (member-initiated)
 *     description: Starts a member-initiated MTN Mobile Money collection (via IntouchPay) for the Processing Fee owed on a Draft/Correction_Required application. IntouchPay pushes a USSD approval prompt to the given number; the final outcome arrives asynchronously via the IntouchPay callback (or is discovered by polling the status endpoint below). On success, the application is automatically submitted — no separate "Submit" call is needed.
 *     tags:
 *       - Payments & Invoices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - applicationId
 *               - mobilephone
 *             properties:
 *               applicationId:
 *                 type: string
 *                 format: uuid
 *               mobilephone:
 *                 type: string
 *                 example: "0788123456"
 *     responses:
 *       200:
 *         description: Payment request accepted by the gateway and is now Pending — the member must approve the prompt on their phone.
 *       400:
 *         description: Missing fields, or this category has no processing fee.
 *       404:
 *         description: Application not found, not owned by the caller, or not in Draft/Correction_Required state.
 *       409:
 *         description: A payment request is already in progress for this application.
 *       422:
 *         description: The mobile money gateway rejected the request (e.g. invalid number, insufficient funds).
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error.
 */
router.post('/processing-fee/initiate', requireAuth, momoRateLimiter, initiateProcessingFeePayment);

/**
 * @openapi
 * /api/v1/payments/processing-fee/status/{transactionId}:
 *   get:
 *     summary: Check the status of a Processing Fee Mobile Money payment
 *     description: Polled by the frontend after initiating a Processing Fee payment. Reflects the outcome already recorded via the IntouchPay callback; if still Pending_Verification, also actively re-checks with IntouchPay's GetTransactionStatus as a fallback in case the callback was delayed.
 *     tags:
 *       - Payments & Invoices
 *     parameters:
 *       - in: path
 *         name: transactionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Current transaction status (Pending_Verification, Paid, or Failed).
 *       404:
 *         description: Transaction not found or not owned by the caller.
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error.
 */
router.get('/processing-fee/status/:transactionId', requireAuth, momoRateLimiter, getProcessingFeePaymentStatus);

export default router;
