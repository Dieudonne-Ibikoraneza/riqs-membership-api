import { Request } from 'express';
import { rateLimit } from 'express-rate-limit';

const windowMs = 15 * 60 * 1000;

function keyWithEmail(req: Request): string {
  const email = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : 'anonymous';

  // Keep the IP component so one user cannot evade the limit by changing
  // the email address, while the email component limits attacks on one account.
  return `${req.ip}:${email}`;
}

const limitResponse = {
  error: 'Too many requests. Please try again later.'
};

export const apiRateLimiter = rateLimit({
  windowMs,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: limitResponse
});

export const loginRateLimiter = rateLimit({
  windowMs,
  limit: 10,
  keyGenerator: keyWithEmail,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

export const registrationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: keyWithEmail,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.' }
});

export const otpRateLimiter = rateLimit({
  windowMs,
  limit: 10,
  keyGenerator: keyWithEmail,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' }
});

export const resendOtpRateLimiter = rateLimit({
  windowMs,
  limit: 3,
  keyGenerator: keyWithEmail,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please try again later.' }
});

export const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: keyWithEmail,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again later.' }
});

export const uploadRateLimiter = rateLimit({
  windowMs,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many uploads. Please try again later.' }
});
