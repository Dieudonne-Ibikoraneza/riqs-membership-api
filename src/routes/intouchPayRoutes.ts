import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRoles } from '../middleware/rbac';
import { rateLimit } from 'express-rate-limit';
import {
  getBalance,
  getTransactionStatus,
  requestPayment,
  // requestDeposit, // commented out alongside its route below — see that block for why
  receivePaymentCallback
} from '../controllers/intouchPayController';

const router = Router();

// IntouchPay recommends the App code its clients defensively; this keeps a partner from
// hammering the sandbox gateway and tripping IntouchPay's own upstream rate limits.
const intouchPayRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many IntouchPay requests. Please try again shortly.' }
});

/**
 * @openapi
 * /api/v1/payments/getbalance:
 *   post:
 *     summary: Balance Inquiry (GetBalance)
 *     description: Queries the account balance on IntouchPay. The App (this server) functions as the client and IntouchPay as the server. Credentials, timestamp and SHA256 password signature are generated server-side from INTOUCHPAY_* environment variables.
 *     tags:
 *       - IntouchPay
 *     responses:
 *       200:
 *         description: Balance successfully retrieved.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 balance:
 *                   type: string
 *                   example: "0.0"
 *                 success:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Missing username, password, or date information.
 *       401:
 *         description: Invalid password or authentication failure.
 *       403:
 *         description: Access denied — caller lacks the required role.
 *       404:
 *         description: No such user on IntouchPay.
 *       405:
 *         description: Method not allowed.
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error or IntouchPay gateway unreachable.
 */
router.post(
  '/getbalance',
  intouchPayRateLimiter,
  requireAuth,
  requireRoles(['admin', 'admin_assistant', 'finance']),
  getBalance
);

/**
 * @openapi
 * /api/v1/payments/gettransactionstatus:
 *   post:
 *     summary: Get Transaction Status
 *     description: Queries the status of a previously submitted RequestPayment transaction on IntouchPay.
 *     tags:
 *       - IntouchPay
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
 *                 description: The App's own transaction id of the transaction to which the status is being requested.
 *                 example: "4093888833"
 *               transactionid:
 *                 type: string
 *                 description: The IntouchPay transaction id of the transaction to which status is being requested.
 *                 example: "20052820200624172842"
 *     responses:
 *       200:
 *         description: Status successfully retrieved (may itself report Pending, Successful, or Failed).
 *       400:
 *         description: Missing transaction id or request transaction id information.
 *       401:
 *         description: Authentication failure.
 *       403:
 *         description: Access denied — caller lacks the required role.
 *       404:
 *         description: Transaction doesn't exist.
 *       405:
 *         description: Method not allowed.
 *       422:
 *         description: Unprocessable request per IntouchPay business validation.
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error or IntouchPay gateway unreachable.
 */
router.post(
  '/gettransactionstatus',
  intouchPayRateLimiter,
  requireAuth,
  requireRoles(['admin', 'admin_assistant', 'finance']),
  getTransactionStatus
);

/**
 * @openapi
 * /api/v1/payments/requestpayment:
 *   post:
 *     summary: Request Payment (Receiving Payment / collection from a subscriber)
 *     description: Invokes IntouchPay's RequestPayment API to initiate a payment request (collection) to a mobile money subscriber. IntouchPay immediately responds with a Pending status while the subscriber confirms via USSD; the final outcome is later delivered asynchronously to the server's configured callback URL (see /api/v1/payments/callback). The callback URL, username, account number and signed password are all attached server-side from environment configuration — never supplied by the caller.
 *     tags:
 *       - IntouchPay
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
 *         description: "Payment request accepted — Pending Response, awaiting subscriber confirmation."
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: Pending
 *                 requesttransactionid:
 *                   type: string
 *                   example: "4522233"
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 responsecode:
 *                   type: string
 *                   example: "1000"
 *                 transactionid:
 *                   type: integer
 *                   example: 1425
 *                 message:
 *                   type: string
 *                   example: Transaction Pending
 *       400:
 *         description: Missing required fields (amount, mobilephone, requesttransactionid, or missing username/password/date information).
 *       401:
 *         description: Invalid password or authentication failure.
 *       403:
 *         description: Access denied — caller lacks the required role.
 *       404:
 *         description: Route not found / no such user.
 *       405:
 *         description: Method not allowed.
 *       409:
 *         description: Duplicate transaction id — a request with this requesttransactionid was already submitted.
 *       422:
 *         description: Unprocessable — e.g. invalid mobile number, amount out of allowed range, insufficient funds, or operation not allowed.
 *       429:
 *         description: Too many requests — rate limit exceeded.
 *       500:
 *         description: Internal server error or IntouchPay gateway unreachable.
 */
router.post(
  '/requestpayment',
  intouchPayRateLimiter,
  requireAuth,
  requireRoles(['admin', 'admin_assistant', 'finance']),
  requestPayment
);

// Commented out (not deleted) at the user's request — built and confirmed working end-to-end
// (POST /api/v1/payments/requestdeposit), kept on ice for future use rather than wired into the
// live routes right now. To bring back: uncomment this whole block, the `requestDeposit` import
// above, `requestDeposit` in intouchPayController.ts (and its own commented imports/exports),
// `requestDeposit` in intouchPayService.ts, and `DEPOSIT_CODE_STATUS` in
// intouchPayResponseCodes.ts.
//
// /**
//  * @openapi
//  * /api/v1/payments/requestdeposit:
//  *   post:
//  *     summary: Request Deposit (Sending Payment / disbursement to a subscriber)
//  *     description: Invokes IntouchPay's RequestDeposit API to push a mobile money payout to a subscriber — the mirror of /requestpayment, which instead collects from one. IntouchPay immediately responds with a Pending status; the final outcome is later delivered asynchronously to the server's configured callback URL (see /api/v1/payments/callback). The caller only ever supplies amount, mobilephone, and reason — username, timestamp, the signed password, the fixed service id (sid, from INTOUCH_SID), withdrawcharge (fixed at 1), and requesttransactionid (auto-generated here as "DEP-<timestamp>-<random>") are all attached server-side and never supplied by the caller. The generated requesttransactionid is always echoed back in the response so the caller has a handle to check its status later via /gettransactionstatus.
//  *     tags:
//  *       - IntouchPay
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required:
//  *               - amount
//  *               - reason
//  *               - mobilephone
//  *             properties:
//  *               amount:
//  *                 type: string
//  *                 example: "100"
//  *               reason:
//  *                 type: string
//  *                 description: Free-text description of what this deposit is for.
//  *                 example: "TEST DEPOSIT"
//  *               mobilephone:
//  *                 type: string
//  *                 example: "250780993300"
//  *     responses:
//  *       200:
//  *         description: "Deposit request accepted — Pending Response, being processed by IntouchPay."
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 status:
//  *                   type: string
//  *                   example: Pending
//  *                 requesttransactionid:
//  *                   type: string
//  *                   description: Server-generated — the only handle the caller has for this transaction, since they never supplied one.
//  *                   example: "DEP-1715520000000-a1b2c3"
//  *                 success:
//  *                   type: boolean
//  *                   example: true
//  *                 responsecode:
//  *                   type: string
//  *                   example: "1000"
//  *                 transactionid:
//  *                   type: integer
//  *                   example: 1425
//  *                 message:
//  *                   type: string
//  *                   example: Transaction Pending
//  *       400:
//  *         description: Missing required fields (amount, mobilephone, reason, or missing username/password/date information).
//  *       401:
//  *         description: Invalid password or authentication failure.
//  *       403:
//  *         description: Access denied — caller lacks the required role.
//  *       404:
//  *         description: Route not found / no such user.
//  *       405:
//  *         description: Method not allowed.
//  *       409:
//  *         description: Duplicate transaction id — a request with this requesttransactionid was already submitted.
//  *       422:
//  *         description: Unprocessable — e.g. invalid mobile number, amount out of allowed range, insufficient funds, or operation not allowed.
//  *       429:
//  *         description: Too many requests — rate limit exceeded.
//  *       500:
//  *         description: Internal server error or IntouchPay gateway unreachable.
//  */
// router.post(
//   '/requestdeposit',
//   intouchPayRateLimiter,
//   requireAuth,
//   requireRoles(['admin', 'admin_assistant', 'finance']),
//   requestDeposit
// );

/**
 * @openapi
 * /api/v1/payments/callback:
 *   post:
 *     summary: RequestPayment completion callback (webhook)
 *     description: Public endpoint invoked directly by IntouchPay (not by our own frontend) to report the final status of a pending RequestPayment transaction, once the subscriber approves or rejects it via USSD, or the request times out. Configure this URL as INTOUCH_CALLBACK_URL. IntouchPay wraps the transaction fields inside a top-level "jsonpayload" key — a flat body is also accepted as a fallback.
 *     tags:
 *       - IntouchPay
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jsonpayload
 *             properties:
 *               jsonpayload:
 *                 type: object
 *                 required:
 *                   - requesttransactionid
 *                 properties:
 *                   requesttransactionid:
 *                     type: string
 *                     example: "4522233"
 *                   transactionid:
 *                     type: string
 *                     example: "6004994884"
 *                   responsecode:
 *                     type: string
 *                     example: "01"
 *                   status:
 *                     type: string
 *                     example: Successfull
 *                   statusdesc:
 *                     type: string
 *                     example: Successfully Processed Transaction
 *                   referenceno:
 *                     type: string
 *                     example: "312333883"
 *     responses:
 *       200:
 *         description: Acknowledgement returned to IntouchPay in the exact shape it requires from the App.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: success
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 request_id:
 *                   type: string
 *                   example: "4522233"
 *       400:
 *         description: Missing requesttransactionid.
 *       500:
 *         description: Internal server error.
 */
router.post('/callback', receivePaymentCallback);

export default router;
