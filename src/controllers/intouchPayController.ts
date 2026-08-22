import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import * as intouchPay from '../services/intouchPayService';
import {
  BALANCE_CODE_STATUS,
  TRANSACTION_STATUS_CODE_STATUS,
  PAYMENT_CODE_STATUS,
  statusForCode
} from '../services/intouchPayResponseCodes';

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

// 4. Callback receiver — IntouchPay invokes this URL to report the final status of a
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

  // Acknowledge receipt in the exact shape IntouchPay's spec requires from the App.
  return res.status(200).json({
    message: 'success',
    success: true,
    request_id: requesttransactionid
  });
}
