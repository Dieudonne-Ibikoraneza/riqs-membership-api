import { Response, Request } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { sendMail } from '../config/mailer';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';
const JWT_EXPIRES_IN = '24h';

// Register a new user
export async function register(req: Request, res: Response) {
  const { email, password, fullName, phoneNumber, dob, nationality, gender, residencyAddress } = req.body;

  if (!email || !password || !fullName) {
    return res.status(400).json({ error: 'Email, password, and full name are required.' });
  }

  try {
    // Check if user exists
    const existingMember = await prisma.member.findUnique({ where: { email } });
    if (existingMember) {
      return res.status(409).json({ error: 'User with this email already exists.' });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Generate a 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    const id = uuidv4();

    // Insert new member profile
    const newMember = await prisma.member.create({
      data: {
        id,
        email,
        passwordHash,
        fullName,
        phoneNumber: phoneNumber || null,
        dateOfBirth: dob ? new Date(dob) : null,
        gender: gender || null,
        nationality: nationality || 'Rwandan',
        residencyAddress: residencyAddress || null,
        isEmailVerified: false,
        otpCode,
        otpExpiresAt
      }
    });

    // Send OTP verification email
    try {
      await sendMail(email, "otpVerification", { name: fullName, otpCode });
    } catch (mailErr: any) {
      console.warn('[Auth Controller Register] OTP email failed to send:', mailErr.message);
    }

    return res.status(201).json({
      message: 'Registration successful. Please check your email for the verification code.',
      email: newMember.email
    });
  } catch (error: any) {
    console.error('[Auth Controller Register] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while registering.' });
  }
}

// Verify OTP endpoint
export async function verifyOtp(req: Request, res: Response) {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required.' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { email } });
    
    if (!member) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (member.otpCode !== otp) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    if (!member.otpExpiresAt || member.otpExpiresAt < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    const wasUnverified = !member.isEmailVerified;

    // Mark as verified and clear OTP
    const updatedMember = await prisma.member.update({
      where: { email },
      data: {
        isEmailVerified: true,
        otpCode: null,
        otpExpiresAt: null
      }
    });

    // Send the welcome email ONLY if this was their first time verifying
    if (wasUnverified) {
      try {
        await sendMail(email, "welcome", { name: updatedMember.fullName });
      } catch (mailErr: any) {
        console.warn('[Auth Controller Verify] Welcome email failed to send:', mailErr.message);
      }
    }

    // Create JWT — role = systemRole (what actions they can do), membershipClass = professional tier
    const token = jwt.sign(
      { 
        id: updatedMember.id, 
        email: updatedMember.email, 
        role: updatedMember.systemRole || 'Standard',
        membershipClass: updatedMember.membershipClass || 'Student'
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const memberResponse = { 
      ...updatedMember, 
      passwordHash: undefined,
      otpCode: undefined,
      otpExpiresAt: undefined 
    };

    return res.status(200).json({
      message: 'Email verified successfully.',
      member: memberResponse,
      token
    });
  } catch (error: any) {
    console.error('[Auth Controller Verify OTP] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while verifying OTP.' });
  }
}

// Login user
export async function login(req: Request, res: Response) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { email } });
    if (!member) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (member.isLocked) {
      return res.status(403).json({ error: 'Your account has been locked. Please contact the administrator.' });
    }

    // Some existing users might have 'SUPABASE_AUTH_MANAGED' as password if they migrated.
    // We should handle this gracefully if they try to login locally.
    if (member.passwordHash === 'SUPABASE_AUTH_MANAGED') {
       return res.status(401).json({ error: 'This account was managed by Supabase. Please reset your password.' });
    }

    const isMatch = await bcrypt.compare(password, member.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (member.resetPasswordOtp === 'CHANGE') {
      return res.status(200).json({
        requirePasswordChange: true,
        email: member.email,
        message: 'You must change your password before logging in.'
      });
    }

    const testEmails = ['reviewer@riqs.com', 'approver@riqs.com', 'admin@riqs.com', 'teacher@riqs.com', 'mentor@riqs.com', 'reviewer2@riqs.com', 'reviewer3@riqs.com', 'assistant@riqs.com'];
    const isTestEmail = testEmails.includes(email.toLowerCase());

    // Generate 2FA OTP
    const otp = isTestEmail ? '123456' : Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    const updatedMember = await prisma.member.update({
      where: { id: member.id },
      data: { otpCode: otp, otpExpiresAt }
    });

    // Send OTP email
    if (!isTestEmail) {
      try {
        await sendMail(email, "otpVerification", { name: member.fullName, otpCode: otp });
      } catch (mailErr: any) {
        console.warn('[Auth Controller Login] 2FA OTP email failed to send:', mailErr.message);
        // We do not fail the login if email fails, but in production we probably should.
      }
    }

    return res.status(200).json({
      message: 'OTP sent to your email. Please verify to complete login.',
      email: member.email
      // Notice: No token returned yet! Must call /verify-otp
    });
  } catch (error: any) {
    console.error('[Auth Controller Login] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while logging in.' });
  }
}// Forgot Password (generate OTP and send email)
export async function forgotPassword(req: Request, res: Response) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    const member = await prisma.member.findUnique({ where: { email } });
    if (!member) return res.status(404).json({ error: 'We could not find an account associated with this email address. Please check for typos or create a new account instead.' });

    const testEmails = ['reviewer@riqs.com', 'approver@riqs.com', 'admin@riqs.com', 'teacher@riqs.com', 'mentor@riqs.com'];
    const isTestEmail = testEmails.includes(email.toLowerCase());

    const otpCode = isTestEmail ? '123456' : Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.member.update({
      where: { email },
      data: { resetPasswordOtp: otpCode, resetPasswordExpires: otpExpiresAt }
    });

    if (!isTestEmail) {
      await sendMail(email, "passwordReset", { name: member.fullName, otpCode });
    }

    return res.status(200).json({ message: 'A 6-digit password reset code has been successfully sent to your email.' });
  } catch (error: any) {
    console.error('[Forgot Password Error]', error.message);
    return res.status(500).json({ error: 'Failed to process request.' });
  }
}

// Reset Password (verify OTP and update password)
export async function resetPassword(req: Request, res: Response) {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Email, otp, and newPassword are required.' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { email } });
    if (!member || !member.resetPasswordOtp || !member.resetPasswordExpires) {
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    if (member.resetPasswordOtp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP.' });
    }

    if (new Date() > member.resetPasswordExpires) {
      return res.status(400).json({ error: 'OTP has expired.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.member.update({
      where: { email },
      data: {
        passwordHash,
        resetPasswordOtp: null,
        resetPasswordExpires: null
      }
    });

    return res.status(200).json({ message: 'Password has been successfully reset. You can now log in.' });
  } catch (error: any) {
    console.error('[Reset Password Error]', error.message);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
}

// Resend OTP for Verification (Login/Signup) or Password Reset
export async function resendOtp(req: Request, res: Response) {
  const { email, type } = req.body;
  
  if (!email || !type) {
    return res.status(400).json({ error: 'Email and type (verification or reset) are required.' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { email } });
    if (!member) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const testEmails = ['reviewer@riqs.com', 'approver@riqs.com', 'admin@riqs.com', 'teacher@riqs.com', 'mentor@riqs.com'];
    const isTestEmail = testEmails.includes(email.toLowerCase());
    const newOtpCode = isTestEmail ? '123456' : Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    if (type === 'verification') {
      await prisma.member.update({
        where: { id: member.id },
        data: { otpCode: newOtpCode, otpExpiresAt: expiresAt }
      });

      if (!isTestEmail) {
        try {
          await sendMail(email, "otpVerification", { name: member.fullName, otpCode: newOtpCode });
        } catch (mailErr: any) {
          console.warn('[Resend OTP Verification] Email failed:', mailErr.message);
        }
      }
    } else if (type === 'reset') {
      await prisma.member.update({
        where: { id: member.id },
        data: { resetPasswordOtp: newOtpCode, resetPasswordExpires: expiresAt }
      });

      if (!isTestEmail) {
        try {
          await sendMail(email, "passwordReset", { name: member.fullName, otpCode: newOtpCode });
        } catch (mailErr: any) {
          console.warn('[Resend OTP Reset] Email failed:', mailErr.message);
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid type. Must be verification or reset.' });
    }

    return res.status(200).json({ message: 'A new OTP has been sent to your email.' });
  } catch (error: any) {
    console.error('[Resend OTP Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while resending OTP.' });
  }
}
