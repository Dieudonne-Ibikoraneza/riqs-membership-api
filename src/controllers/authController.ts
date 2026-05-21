import { Response, Request } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db';
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
    const checkQuery = await pool.query('SELECT id FROM members WHERE email = $1', [email]);
    if (checkQuery.rows.length > 0) {
      return res.status(409).json({ error: 'User with this email already exists.' });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const id = uuidv4();

    // Insert new member profile
    const insertRes = await pool.query(
      `INSERT INTO members (id, email, password_hash, full_name, phone_number, date_of_birth, gender, nationality, residency_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        id,
        email,
        passwordHash,
        fullName,
        phoneNumber || 'N/A',
        dob || null,
        gender || null,
        nationality || 'Rwandan',
        residencyAddress || null
      ]
    );

    const newMember = insertRes.rows[0];

    // Trigger Nodemailer Welcome notification email asynchronously
    try {
      await sendMail(email, mailTemplates.welcome(fullName));
    } catch (mailErr: any) {
      console.warn('[Auth Controller Register] Email notification failed to send:', mailErr.message);
    }

    // Create JWT
    const token = jwt.sign(
      { id: newMember.id, email: newMember.email, role: newMember.membership_class || 'member' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Don't send password_hash back to client
    delete newMember.password_hash;

    return res.status(201).json({
      message: 'User registered successfully.',
      member: newMember,
      token
    });
  } catch (error: any) {
    console.error('[Auth Controller Register] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while registering.' });
  }
}

// Login user
export async function login(req: Request, res: Response) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const checkQuery = await pool.query('SELECT * FROM members WHERE email = $1', [email]);
    if (checkQuery.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const member = checkQuery.rows[0];

    // Some existing users might have 'SUPABASE_AUTH_MANAGED' as password if they migrated.
    // We should handle this gracefully if they try to login locally.
    if (member.password_hash === 'SUPABASE_AUTH_MANAGED') {
       return res.status(401).json({ error: 'This account was managed by Supabase. Please reset your password.' });
    }

    const isMatch = await bcrypt.compare(password, member.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Create JWT
    const token = jwt.sign(
      { id: member.id, email: member.email, role: member.membership_class || 'member' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Don't send password_hash back to client
    delete member.password_hash;

    return res.status(200).json({
      message: 'Login successful.',
      member,
      token
    });
  } catch (error: any) {
    console.error('[Auth Controller Login] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while logging in.' });
  }
}
