import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { pool } from '../config/db';
import { mailTemplates, sendMail } from '../config/mailer';

// Synchronizes the Supabase Authenticated User session with our Custom members profile table
export async function syncUser(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access Denied. Unauthenticated session.' });
  }

  const { fullName, phoneNumber, dob, nationality, gender, residencyAddress } = req.body;

  try {
    // Check if custom profile is already mapped
    const checkQuery = await pool.query('SELECT * FROM members WHERE id = $1', [req.user.id]);
    
    if (checkQuery.rows.length > 0) {
      return res.status(200).json({ 
        message: 'Profile already synchronized.', 
        member: checkQuery.rows[0] 
      });
    }

    // Insert new custom member profile. Password hash is set as N/A since security is governed by Supabase Auth
    const insertRes = await pool.query(
      `INSERT INTO members (id, email, password_hash, full_name, phone_number, date_of_birth, gender, nationality, residency_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.user.id,
        req.user.email,
        'SUPABASE_AUTH_MANAGED',
        fullName || 'New Applicant',
        phoneNumber || 'N/A',
        dob || null,
        gender || null,
        nationality || 'Rwandan',
        residencyAddress || null
      ]
    );

    // Trigger Nodemailer Welcome notification email asynchronously
    try {
      await sendMail(req.user.email, mailTemplates.welcome(fullName || 'RIQS Applicant'));
    } catch (mailErr: any) {
      console.warn('[Sync Auth] Email notification failed to send:', mailErr.message);
    }

    return res.status(201).json({
      message: 'RIQS profile successfully initialized and synchronized.',
      member: insertRes.rows[0]
    });
  } catch (error: any) {
    console.error('[Auth Controller Sync] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while syncing security profile.' });
  }
}
