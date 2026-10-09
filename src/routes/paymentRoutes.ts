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
  getProcessingFeePaymentStatus,
  initiateAnnualRenewalPayment,
  getAnnualRenewalPaymentStatus,
  initiateFirstYearFeePayment,
  getFirstYearFeePaymentStatus,
  getBalance,
  getTransactionStatus,
  requestGatewayPayment,
  receivePaymentCallback
} from '../controllers/paymentController';

const router = Router();

// Guards member-facing and gateway endpoints from accidental hammering (e.g. a runaway poll loop).
const paymentRateLimiter = rateLimit({
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
 *     description: Registers a new fee transaction (Mobile Money ref code or bank slip reference) to the double-entry financial ledger. Enforces duplicate reference detection for anti-fraud security.
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
 *                 enum: [Mobile_Money, Bank_Transfer, Card_Payment, Manual_Cash]
 *                 example: Mobile_Money
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
 *     description: Starts a member-initiated Mobile Money collection for the Processing Fee owed on a Draft/Correction_Required application. The gateway pushes a USSD approval prompt to the given number; the final outcome arrives asynchronously via the payment callback (or is discovered by polling the status endpoint below). On success, the application is automatically submitted — no separate "Submit" call is needed.
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
router.post('/processing-fee/initiate', requireAuth, paymentRateLimiter, initiateProcessingFeePayment);

/**
 * @openapi
 * /api/v1/payments/processing-fee/status/{transactionId}:
 *   get:
 *     summary: Check the status of a Processing Fee Mobile Money payment
 *     description: Polled by the frontend after initiating a Processing Fee payment. Reflects the outcome already recorded via the payment callback; if still Pending_Verification, also actively re-checks with the gateway as a fallback in case the callback was delayed.
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
router.get('/processing-fee/status/:transactionId', requireAuth, paymentRateLimiter, getProcessingFeePaymentStatus);

/**
 * @openapi
 * /api/v1/payments/annual-renewal/initiate:
 *   post:
 *     summary: Initiate an Annual Renewal Mobile Money payment
 *     description: Same member-initiated Mobile Money flow used for the application's Processing Fee, applied to the annual renewal/subscription fee. The gateway's callback (or the status-poll fallback) clears the transaction and extends the member's membership expiry date automatically.
 *     tags:
 *       - Payments & Invoices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mobilephone]
 *             properties:
 *               mobilephone:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment request sent to the subscriber's phone.
 *       400:
 *         description: Missing mobilephone, or the renewal fee could not be determined.
 *       404:
 *         description: Member not found.
 *       409:
 *         description: A payment request is already in progress.
 *       422:
 *         description: Payment request was rejected by the mobile money gateway.
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error.
 */
router.post('/annual-renewal/initiate', requireAuth, paymentRateLimiter, initiateAnnualRenewalPayment);

/**
 * @openapi
 * /api/v1/payments/annual-renewal/status/{transactionId}:
 *   get:
 *     summary: Check the status of an Annual Renewal Mobile Money payment
 *     description: Polled by the frontend after initiating an Annual Renewal payment. Reflects the outcome already recorded via the payment callback; if still Pending_Verification, also actively re-checks with the gateway as a fallback in case the callback was delayed.
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
router.get('/annual-renewal/status/:transactionId', requireAuth, paymentRateLimiter, getAnnualRenewalPaymentStatus);

/**
 * @openapi
 * /api/v1/payments/first-year-fee/initiate:
 *   post:
 *     summary: Initiate a First Year Fee Mobile Money payment
 *     description: Same member-initiated Mobile Money flow used elsewhere, applied to an outstanding First Year Fee — covers both a brand-new membership's first-year fee and a mentorship/APC upgrade's pending-upgrade fee. The gateway's callback (or the status-poll fallback) clears the transaction and activates the membership/upgrade automatically.
 *     tags:
 *       - Payments & Invoices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mobilephone]
 *             properties:
 *               mobilephone:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment request sent to the subscriber's phone.
 *       400:
 *         description: Missing mobilephone, or no outstanding first-year fee found.
 *       409:
 *         description: A payment request is already in progress.
 *       422:
 *         description: Payment request was rejected by the mobile money gateway.
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error.
 */
router.post('/first-year-fee/initiate', requireAuth, paymentRateLimiter, initiateFirstYearFeePayment);

/**
 * @openapi
 * /api/v1/payments/first-year-fee/status/{transactionId}:
 *   get:
 *     summary: Check the status of a First Year Fee Mobile Money payment
 *     description: Polled by the frontend after initiating a First Year Fee payment. Reflects the outcome already recorded via the payment callback; if still Pending_Verification, also actively re-checks with the gateway as a fallback in case the callback was delayed.
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
router.get('/first-year-fee/status/:transactionId', requireAuth, paymentRateLimiter, getFirstYearFeePaymentStatus);

/**
 * @openapi
 * /api/v1/payments/auth:
 *   post:
 *     summary: Payment gateway authentication / balance inquiry
 *     description: Authenticates against the configured payment gateway and returns the merchant account balance.
 *     tags:
 *       - Payments & Invoices
 *     responses:
 *       200:
 *         description: Balance successfully retrieved.
 *       401:
 *         description: Invalid credentials or authentication failure.
 *       403:
 *         description: Access denied — caller lacks the required role.
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error or payment gateway unreachable.
 */
router.post(
  '/auth',
  paymentRateLimiter,
  requireAuth,
  requireRoles(['admin', 'admin_assistant', 'finance']),
  getBalance
);

/**
 * @openapi
 * /api/v1/payments/validate:
 *   post:
 *     summary: Validate / look up a payment transaction status
 *     description: Queries the payment gateway for the status of a previously submitted collection request.
 *     tags:
 *       - Payments & Invoices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - requesttransactionid
 *             properties:
 *               requesttransactionid:
 *                 type: string
 *               transactionid:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status successfully retrieved.
 *       400:
 *         description: Missing transaction id.
 *       403:
 *         description: Access denied — caller lacks the required role.
 *       404:
 *         description: Transaction doesn't exist.
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error or payment gateway unreachable.
 */
router.post(
  '/validate',
  paymentRateLimiter,
  requireAuth,
  requireRoles(['admin', 'admin_assistant', 'finance']),
  getTransactionStatus
);

/**
 * @openapi
 * /api/v1/payments/request:
 *   post:
 *     summary: Request a Mobile Money collection
 *     description: Initiates a payment collection from a subscriber. The gateway responds Pending immediately; the final outcome is delivered asynchronously to /api/v1/payments/callback (or /notification). Credentials and callback URL are attached server-side from environment configuration.
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
 *               - mobilephone
 *               - requesttransactionid
 *             properties:
 *               amount:
 *                 type: string
 *                 example: "1000"
 *               mobilephone:
 *                 type: string
 *                 example: "250785971082"
 *               requesttransactionid:
 *                 type: string
 *                 example: "34555"
 *     responses:
 *       200:
 *         description: Payment request accepted — Pending, awaiting subscriber confirmation.
 *       400:
 *         description: Missing required fields.
 *       403:
 *         description: Access denied — caller lacks the required role.
 *       409:
 *         description: Duplicate transaction id.
 *       422:
 *         description: Gateway rejected the request (invalid number, amount out of range, etc.).
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error or payment gateway unreachable.
 */
router.post(
  '/request',
  paymentRateLimiter,
  requireAuth,
  requireRoles(['admin', 'admin_assistant', 'finance']),
  requestGatewayPayment
);

/**
 * @openapi
 * /api/v1/payments/callback:
 *   post:
 *     summary: Payment completion callback (webhook)
 *     description: Public endpoint invoked by the payment gateway to report the final status of a pending collection. Configure this URL as PAYMENT_CALLBACK_URL.
 *     tags:
 *       - Payments & Invoices
 *     responses:
 *       200:
 *         description: Acknowledgement returned to the gateway.
 *       400:
 *         description: Missing requesttransactionid.
 *       500:
 *         description: Internal server error.
 */
router.post('/callback', receivePaymentCallback);

/**
 * @openapi
 * /api/v1/payments/notification:
 *   post:
 *     summary: Payment notification webhook
 *     description: Alias of /callback — some gateways distinguish notification vs callback URLs; both hit the same reconciliation handler.
 *     tags:
 *       - Payments & Invoices
 *     responses:
 *       200:
 *         description: Acknowledgement returned to the gateway.
 *       400:
 *         description: Missing requesttransactionid.
 *       500:
 *         description: Internal server error.
 */
router.post('/notification', receivePaymentCallback);

/**
 * @openapi
 * /api/v1/payments/reversal:
 *   post:
 *     summary: Payment reversal webhook
 *     description: Public endpoint reserved for gateway-initiated payment reversals. Not yet wired to ledger logic — acknowledges receipt so the partner URL can be registered.
 *     tags:
 *       - Payments & Invoices
 *     responses:
 *       200:
 *         description: Acknowledgement returned to the gateway.
 *       501:
 *         description: Reversal handling not yet implemented.
 */
router.post('/reversal', (req, res) => {
  console.log('[Payment Reversal] Received notice (not yet processed):', req.body);
  return res.status(501).json({
    message: 'Payment reversal handling is not yet implemented.',
    success: false
  });
});

export default router;
