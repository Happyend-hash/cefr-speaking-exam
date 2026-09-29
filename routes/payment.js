import express from 'express';
import crypto from 'crypto';
import User from '../models/User.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import { findPackage, PACKAGES } from '../content/packages.js';
import { extendPremium, PREMIUM_DAYS } from '../services/Premium.js';
import { authenticate } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * Click Merchant API integration.
 *
 * Docs: https://docs.click.uz/en/click-api-request/ (webhooks) and
 * https://docs.click.uz/en/click-button/ (checkout link).
 *
 * Flow:
 *   1. Student picks a package in the app → POST /click/checkout (here) →
 *      we open a PaymentTransaction and hand back Click's own payment-page
 *      URL, which the browser redirects to.
 *   2. Student pays on Click's page with their card.
 *   3. Click calls OUR server twice, asynchronously, once the payment moves:
 *        - Prepare (action=0): "this transaction is about to be charged"
 *        - Complete (action=1): "it was charged" (or failed)
 *      Both are public webhooks — Click, not our frontend, calls them — and
 *      both must be verified by the MD5 signature Click sends, since
 *      anyone could otherwise POST a fake "it's paid" here.
 *
 * These four env vars come from Click once the merchant application is
 * approved: CLICK_MERCHANT_ID, CLICK_SERVICE_ID, CLICK_MERCHANT_USER_ID,
 * CLICK_SECRET_KEY. Until they're set, checkout refuses cleanly instead of
 * sending a broken payment link.
 */

const CLICK_PAY_URL = 'https://my.click.uz/services/pay';

function clickConfigured() {
  return Boolean(
    process.env.CLICK_MERCHANT_ID &&
    process.env.CLICK_SERVICE_ID &&
    process.env.CLICK_SECRET_KEY
  );
}

function appUrl() {
  return (process.env.APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
}

// Click error codes: 0 is success, everything else is a documented failure.
// -1 SIGN CHECK FAILED, -4 ALREADY PAID, -5 USER NOT FOUND (bad merchant_trans_id/amount).
const CLICK_ERROR = {
  SUCCESS: 0,
  SIGN_FAILED: -1,
  TRANSACTION_NOT_FOUND: -6,
  ALREADY_PAID: -4,
  USER_NOT_FOUND: -5,
  TRANSACTION_CANCELLED: -9
};

/**
 * @route   POST /api/payment/click/checkout
 * @desc    Start a Click payment for one package; returns the redirect URL.
 */
router.post('/click/checkout', authenticate, async (req, res, next) => {
  try {
    if (!clickConfigured()) {
      throw new APIError('Online payment is not switched on yet — Click approval is still pending.', 503);
    }

    const pkg = findPackage(String(req.body?.packageKey || ''));
    if (!pkg) throw new APIError('Unknown package.', 400);

    const student = await User.findById(req.user.id);
    if (!student) throw new APIError('Student not found', 404);

    const transaction = await PaymentTransaction.create({
      student: student._id,
      packageKey: pkg.key,
      mocks: pkg.mocks,
      amount: pkg.price,
      status: 'pending',
      // Placeholder, replaced right below with the doc's own real id —
      // Click needs a transaction_param before we can know that id, and the
      // unique index would otherwise reject two 'pending' rows at once.
      merchantTransId: `tmp-${crypto.randomUUID()}`
    });
    transaction.merchantTransId = transaction._id.toString();
    await transaction.save();

    const params = new URLSearchParams({
      service_id: process.env.CLICK_SERVICE_ID,
      merchant_id: process.env.CLICK_MERCHANT_ID,
      amount: pkg.price.toFixed(2),
      transaction_param: transaction.merchantTransId
    });
    if (process.env.CLICK_MERCHANT_USER_ID) {
      params.set('merchant_user_id', process.env.CLICK_MERCHANT_USER_ID);
    }
    if (appUrl()) {
      params.set('return_url', `${appUrl()}/?topup=done`);
    }

    res.json({
      url: `${CLICK_PAY_URL}?${params.toString()}`,
      transactionId: transaction.merchantTransId
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/payment/packages
 * @desc    Public package list (mocks + price), so the frontend never
 *          hardcodes prices. Used for the manual card-transfer price table
 *          regardless of whether Click is live, and also for the Click "buy
 *          now" cards once it is.
 */
router.get('/packages', (req, res) => {
  res.json({ packages: PACKAGES, live: clickConfigured() });
});

/**
 * Click's signature for the Prepare step:
 *   md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)
 */
function prepareSignature(body) {
  const raw = [
    body.click_trans_id,
    body.service_id,
    process.env.CLICK_SECRET_KEY,
    body.merchant_trans_id,
    body.amount,
    body.action,
    body.sign_time
  ].join('');
  return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * Click's signature for the Complete step — same as Prepare but with
 * merchant_prepare_id spliced in before amount.
 */
function completeSignature(body) {
  const raw = [
    body.click_trans_id,
    body.service_id,
    process.env.CLICK_SECRET_KEY,
    body.merchant_trans_id,
    body.merchant_prepare_id,
    body.amount,
    body.action,
    body.sign_time
  ].join('');
  return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * @route   POST /api/payment/click/prepare
 * @desc    Click webhook, stage 1 — "about to charge this". Public: Click
 *          calls this directly, there is no session to authenticate.
 */
router.post('/click/prepare', async (req, res) => {
  const body = req.body || {};
  const reply = extra => res.json({
    click_trans_id: body.click_trans_id,
    merchant_trans_id: body.merchant_trans_id,
    ...extra
  });

  try {
    if (String(body.sign_string || '').toLowerCase() !== prepareSignature(body)) {
      return reply({ merchant_prepare_id: null, error: CLICK_ERROR.SIGN_FAILED, error_note: 'SIGN CHECK FAILED' });
    }

    const transaction = await PaymentTransaction.findById(body.merchant_trans_id).catch(() => null);
    if (!transaction) {
      return reply({ merchant_prepare_id: null, error: CLICK_ERROR.USER_NOT_FOUND, error_note: 'Transaction not found' });
    }

    if (transaction.status === 'completed') {
      return reply({ merchant_prepare_id: null, error: CLICK_ERROR.ALREADY_PAID, error_note: 'Already paid' });
    }
    if (transaction.status === 'cancelled') {
      return reply({ merchant_prepare_id: null, error: CLICK_ERROR.TRANSACTION_CANCELLED, error_note: 'Transaction cancelled' });
    }
    if (Number(body.amount) !== transaction.amount) {
      return reply({ merchant_prepare_id: null, error: CLICK_ERROR.USER_NOT_FOUND, error_note: 'Amount mismatch' });
    }

    transaction.status = 'prepared';
    transaction.clickTransId = String(body.click_trans_id);
    await transaction.save();

    // merchant_prepare_id: Click hands this back on the Complete call so we
    // can find the same reservation again. The transaction's own _id
    // already does that job, so re-using merchantPrepareId as a numeric
    // echo of the same value keeps it simple — any stable int works here.
    const prepareId = Date.now();
    transaction.merchantPrepareId = prepareId;
    await transaction.save();

    return reply({ merchant_prepare_id: prepareId, error: CLICK_ERROR.SUCCESS, error_note: 'Success' });
  } catch (error) {
    console.error('Click prepare webhook failed:', error);
    return reply({ merchant_prepare_id: null, error: CLICK_ERROR.TRANSACTION_NOT_FOUND, error_note: 'Internal error' });
  }
});

/**
 * @route   POST /api/payment/click/complete
 * @desc    Click webhook, stage 2 — the charge went through (or failed).
 *          Public, same reasoning as /prepare. error===0 here means real
 *          money moved, so the response must stay error:0 even if crediting
 *          the student afterwards has a problem — a refund, not a webhook
 *          retry, is how Click's docs say to unwind a charge that already
 *          landed.
 */
router.post('/click/complete', async (req, res) => {
  const body = req.body || {};
  const reply = extra => res.json({
    click_trans_id: body.click_trans_id,
    merchant_trans_id: body.merchant_trans_id,
    ...extra
  });

  try {
    if (String(body.sign_string || '').toLowerCase() !== completeSignature(body)) {
      return reply({ merchant_confirm_id: null, error: CLICK_ERROR.SIGN_FAILED, error_note: 'SIGN CHECK FAILED' });
    }

    const transaction = await PaymentTransaction.findById(body.merchant_trans_id).catch(() => null);
    if (!transaction) {
      return reply({ merchant_confirm_id: null, error: CLICK_ERROR.USER_NOT_FOUND, error_note: 'Transaction not found' });
    }

    // Idempotency: Click may retry this webhook. Once we've recorded a
    // completion for this click_trans_id, say so again without granting a
    // second package.
    if (transaction.status === 'completed') {
      return reply({ merchant_confirm_id: transaction.merchantPrepareId, error: CLICK_ERROR.ALREADY_PAID, error_note: 'Already confirmed' });
    }

    const clickError = Number(body.error);
    if (clickError !== 0) {
      // The charge itself failed on Click's side — nothing was withdrawn.
      transaction.status = 'failed';
      transaction.clickError = clickError;
      transaction.clickErrorNote = String(body.error_note || '');
      await transaction.save();
      return reply({ merchant_confirm_id: null, error: CLICK_ERROR.TRANSACTION_CANCELLED, error_note: 'Transaction cancelled' });
    }

    // Funds were withdrawn. From here on we always answer error:0 —
    // whatever happens next on our side, the charge already landed.
    transaction.status = 'completed';
    await transaction.save();

    try {
      const student = await User.findById(transaction.student);
      if (student) {
        if (!student.access) student.access = {};
        student.subscription.examsRemaining = (student.subscription.examsRemaining || 0) + transaction.mocks;
        student.access.totalGranted = (student.access.totalGranted || 0) + transaction.mocks;
        extendPremium(student, PREMIUM_DAYS);
        student.access.lastGrantedAt = new Date();
        student.access.lastGrantedBy = 'Click';
        student.access.message =
          `To'lovingiz qabul qilindi. Hisobingizga ${transaction.mocks} ta mock qo'shildi. ` +
          `Premium ${new Date(student.premiumUntil).toLocaleDateString('uz-UZ')} gacha faol 👑`;
        student.access.messageAt = new Date();
        await student.save();
      } else {
        console.error(`Click complete: transaction ${transaction._id} paid but student ${transaction.student} not found`);
      }
    } catch (fulfillError) {
      // Log loudly so a teacher/admin can grant the package by hand — but
      // still answer error:0 below, per Click's rules for a charge that
      // already succeeded.
      console.error(`Click complete: payment landed for transaction ${transaction._id} but fulfillment failed:`, fulfillError);
    }

    return reply({ merchant_confirm_id: transaction.merchantPrepareId, error: CLICK_ERROR.SUCCESS, error_note: 'Success' });
  } catch (error) {
    console.error('Click complete webhook failed:', error);
    // Signature wasn't even checked yet in this branch, or something broke
    // before we could tell if money moved — safest is to report failure so
    // Click's own dashboard flags it for manual reconciliation.
    return reply({ merchant_confirm_id: null, error: CLICK_ERROR.TRANSACTION_NOT_FOUND, error_note: 'Internal error' });
  }
});

export default router;
