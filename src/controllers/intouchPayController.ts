import { Response } from 'express';
// import crypto from 'crypto'; // only needed by requestDeposit, commented out below
import { AuthenticatedRequest } from '../middleware/auth';
import * as intouchPay from '../services/intouchPayService';
import {
  BALANCE_CODE_STATUS,
  TRANSACTION_STATUS_CODE_STATUS,
  PAYMENT_CODE_STATUS,
  // DEPOSIT_CODE_STATUS, // only needed by requestDeposit, commented out below
  statusForCode
} from '../services/intouchPayResponseCodes';
import { resolveProcessingFeePaymentByProviderId } from './paymentController';

// 1. Balance Inquiry — GetBalance
export async function getBalance(req: AuthenticatedRequest, res: Response) {
  try {
    const { httpStatus, data } = await intouchPay.getBalance();

    if (data?.success === true) {
      return res.status(200).json(data);
    }

    const status = statusForCode(BALANCE_CODE_STATUS, data?.responsecode, httpStatus >= 400 ? httpStatus : 500);
    return res.status(status).json(data);
  } catch (err: any) {
    console.error('[IntouchPay GetBalance] Gateway error:', err.message || err);
    return res.status(500).json({ error: 'IntouchPay gateway unreachable or returned an unexpected error.' });
  }
}

// 2. GetTransactionStatus — query the status of a prior transaction
export async function getTransactionStatus(req: AuthenticatedRequest, res: Response) {
  const { requesttransactionid, transactionid } = req.body;

  if (!requesttransactionid) {
    return res.status(400).json({ error: 'requesttransactionid is required.' });
  }

  try {
    const { httpStatus, data } = await intouchPay.getTransactionStatus({ requesttransactionid, transactionid });

    if (data?.success === true) {
      return res.status(200).json(data);
    }

    const status = statusForCode(TRANSACTION_STATUS_CODE_STATUS, data?.responsecode, httpStatus >= 400 ? httpStatus : 500);
    return res.status(status).json(data);
  } catch (err: any) {
    console.error('[IntouchPay GetTransactionStatus] Gateway error:', err.message || err);
    return res.status(500).json({ error: 'IntouchPay gateway unreachable or returned an unexpected error.' });
  }
}

// 3. RequestPayment — Receiving Payment (collection request from a subscriber), processed
// asynchronously: IntouchPay responds "Pending" immediately, then invokes our callback URL.
export async function requestPayment(req: AuthenticatedRequest, res: Response) {
  const { amount, mobilephone, requesttransactionid } = req.body;

  if (!amount || !mobilephone || !requesttransactionid) {
    return res.status(400).json({ error: 'amount, mobilephone and requesttransactionid are required.' });
  }

  try {
    const { httpStatus, data } = await intouchPay.requestPayment({
      amount, mobilephone, requesttransactionid
    });

    if (data?.success === true) {
      // Documented shape: { status: 'Pending', requesttransactionid, success: true, responsecode: '1000', transactionid, message }
      return res.status(200).json(data);
    }

    const status = statusForCode(PAYMENT_CODE_STATUS, data?.responsecode, httpStatus >= 400 ? httpStatus : 500);
    return res.status(status).json(data);
  } catch (err: any) {
    console.error('[IntouchPay RequestPayment] Gateway error:', err.message || err);
    return res.status(500).json({ error: 'IntouchPay gateway unreachable or returned an unexpected error.' });
  }
}

// 4. RequestDeposit — Sending Payment (disbursement to a subscriber), also processed
// asynchronously: IntouchPay responds "Pending" immediately, then invokes our callback URL.
//
// Commented out (not deleted) at the user's request — built and confirmed working end-to-end,
// kept on ice for future use rather than wired into the live routes right now. To bring back:
// uncomment this, the `crypto` and `DEPOSIT_CODE_STATUS` imports above, `requestDeposit` in
// intouchPayService.ts, `DEPOSIT_CODE_STATUS` in intouchPayResponseCodes.ts, and the
// /requestdeposit route + its import in intouchPayRoutes.ts.
// export async function requestDeposit(req: AuthenticatedRequest, res: Response) {
//   const { amount, reason, mobilephone } = req.body;
//
//   if (!amount || !reason || !mobilephone) {
//     return res.status(400).json({ error: 'amount, reason and mobilephone are required.' });
//   }
//
//   // The caller only ever supplies amount, mobilephone, and reason — username, timestamp,
//   // password, sid, withdrawcharge (fixed at 1), and requesttransactionid (generated here) are
//   // all handled server-side so the raw IntouchPay payload fields never need to be known or
//   // typed by whoever calls this endpoint.
//   const withdrawcharge = 1;
//   const requesttransactionid = `DEP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
//
//   try {
//     const { httpStatus, data } = await intouchPay.requestDeposit({
//       amount, withdrawcharge, reason, mobilephone, requesttransactionid
//     });
//
//     // The caller never chose requesttransactionid themselves, so always echo it back
//     // explicitly (on top of whatever IntouchPay's own response already includes) — it's the
//     // only handle they have for checking this deposit's status later via /gettransactionstatus.
//     if (data?.success === true) {
//       // Documented shape: { status: 'Pending', requesttransactionid, success: true, responsecode: '1000', transactionid, message }
//       return res.status(200).json({ ...data, requesttransactionid });
//     }
//
//     const status = statusForCode(DEPOSIT_CODE_STATUS, data?.responsecode, httpStatus >= 400 ? httpStatus : 500);
//     return res.status(status).json({ ...data, requesttransactionid });
//   } catch (err: any) {
//     console.error('[IntouchPay RequestDeposit] Gateway error:', err.message || err);
//     return res.status(500).json({ error: 'IntouchPay gateway unreachable or returned an unexpected error.' });
//   }
// }

// 5. Callback receiver — IntouchPay invokes this URL to report the final status of a
// RequestPayment transaction once the subscriber approves/rejects/times out on their end.
export async function receivePaymentCallback(req: AuthenticatedRequest, res: Response) {
  // IntouchPay wraps the callback fields inside a top-level "jsonpayload" key
  // (per their spec: requests.post(url, json={'jsonpayload': data}, ...)).
  // Fall back to a flat body for resilience in case that ever changes.
  const payload = req.body?.jsonpayload || req.body;
  const { requesttransactionid, transactionid, responsecode, status, statusdesc, referenceno } = payload || {};

  console.log('[IntouchPay Callback] Received transaction completion notice:', {
    requesttransactionid, transactionid, responsecode, status, statusdesc, referenceno
  });

  if (!requesttransactionid) {
    return res.status(400).json({ message: 'requesttransactionid is required.', success: false });
  }

  // Reconcile against a member-initiated gateway payment (Processing Fee, Annual Renewal, or
  // First Year Fee), if this requesttransactionid corresponds to one — see paymentController.ts's
  // initiateProcessingFeePayment/initiateAnnualRenewalPayment/initiateFirstYearFeePayment.
  // No-op otherwise, e.g. for admin-triggered RequestPayment calls unrelated to this flow.
  try {
    await resolveProcessingFeePaymentByProviderId(requesttransactionid, status, statusdesc);
  } catch (err: any) {
    console.error('[IntouchPay Callback] Failed to reconcile transaction:', err.message);
  }

  // Acknowledge receipt in the exact shape IntouchPay's spec requires from the App.
  return res.status(200).json({
    message: 'success',
    success: true,
    request_id: requesttransactionid
  });
}
