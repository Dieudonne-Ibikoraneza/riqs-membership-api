import { Response, Request } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { mailTemplates, sendMail } from '../config/mailer';
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
      await sendMail(email, mailTemplates.otpVerification(fullName, otpCode));
    } catch (mailErr: any) {
      console.warn('[Auth Controller Register] OTP email failed to send:', mailErr.message);
    }

    return res.status(201).json({
      message: 'Registration successful. Please check your email for the verification code.',
      memberId: newMember.id,
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

    if (member.isEmailVerified) {
      return res.status(400).json({ error: 'Email is already verified.' });
    }

    if (member.otpCode !== otp) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    if (!member.otpExpiresAt || member.otpExpiresAt < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    // Mark as verified and clear OTP
    const updatedMember = await prisma.member.update({
      where: { email },
      data: {
        isEmailVerified: true,
        otpCode: null,
        otpExpiresAt: null
      }
    });

    // Send the welcome email since they are now fully verified
    try {
      await sendMail(email, mailTemplates.welcome(updatedMember.fullName));
    } catch (mailErr: any) {
      console.warn('[Auth Controller Verify] Welcome email failed to send:', mailErr.message);
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

    // Some existing users might have 'SUPABASE_AUTH_MANAGED' as password if they migrated.
    // We should handle this gracefully if they try to login locally.
    if (member.passwordHash === 'SUPABASE_AUTH_MANAGED') {
       return res.status(401).json({ error: 'This account was managed by Supabase. Please reset your password.' });
    }

    const isMatch = await bcrypt.compare(password, member.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!member.isEmailVerified) {
      return res.status(403).json({ error: 'Email is not verified. Please verify your email using the OTP sent to you.' });
    }

    // Create JWT — role = systemRole (what actions they can do), membershipClass = professional tier
    const token = jwt.sign(
      { 
        id: member.id, 
        email: member.email, 
        role: member.systemRole || 'Standard',
        membershipClass: member.membershipClass || 'Student'
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Don't send sensitive fields back to client
    const memberResponse = { 
      ...member, 
      passwordHash: undefined,
      otpCode: undefined,
      otpExpiresAt: undefined
    };

    return res.status(200).json({
      message: 'Login successful.',
      member: memberResponse,
      token
    });
  } catch (error: any) {
    console.error('[Auth Controller Login] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while logging in.' });
  }
}
