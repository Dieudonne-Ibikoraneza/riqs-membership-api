import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { pool } from '../config/db';
import { sendMail, mailTemplates } from '../config/mailer';

// 1. Administrative Registry Queue (Paginated & Filterable)
export async function getReviewQueue(req: AuthenticatedRequest, res: Response) {
  const { status, page = '1', limit = '10' } = req.query;
  const offset = (parseInt(page as string, 10) - 1) * parseInt(limit as string, 10);

  try {
    let query = `
      SELECT app.id, app.status, app.submitted_at, mem.full_name, mem.email, cat.category_name, cat.location 
      FROM applications app
      JOIN members mem ON app.member_id = mem.id
      JOIN membership_categories cat ON app.category_id = cat.id
    `;
    const params: any[] = [];

    if (status) {
      query += ` WHERE app.status = $1`;
      params.push(status);
    }

    query += ` ORDER BY app.submitted_at DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit as string, 10), offset);

    const queueRes = await pool.query(query, params);
    
    // Count total pending records for UI pagination indicators
    let countQuery = `SELECT COUNT(*) FROM applications`;
    if (status) countQuery += ` WHERE status = '${status}'`;
    const countRes = await pool.query(countQuery);

    return res.status(200).json({
      queue: queueRes.rows,
      pagination: {
        total: parseInt(countRes.rows[0].count, 10),
        page: parseInt(page as string, 10),
        limit: parseInt(limit as string, 10)
      }
    });
  } catch (error: any) {
    console.error('[Admin Queue] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching administrative queue.' });
  }
}

// 2. Administrative Decision Processor (Approve / Flag / Reject)
export async function handleReviewDecision(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId, action, notes } = req.body; // action: 'Approve' | 'Flag' | 'Reject'

  if (!applicationId || !action) {
    return res.status(400).json({ error: 'Missing mandatory parameters: applicationId and action.' });
  }

  try {
    // A. Fetch targeted application parameters
    const appQuery = await pool.query(
      `SELECT app.*, mem.full_name, mem.email, cat.category_code, cat.category_name 
       FROM applications app
       JOIN members mem ON app.member_id = mem.id
       JOIN membership_categories cat ON app.category_id = cat.id
       WHERE app.id = $1`,
      [applicationId]
    );

    if (appQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Application record not found.' });
    }

    const app = appQuery.rows[0];
    const oldStatus = app.status;

    // B. Instantiate connection block to handle transaction safety
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      if (action === 'Flag') {
        if (!notes) {
          dbClient.release();
          return res.status(400).json({ error: 'Action Rejected. Reviewer correction remarks are mandatory when flagging applications.' });
        }

        // Transition status
        await dbClient.query(
          `UPDATE applications SET status = 'Correction Required', updated_at = NOW() WHERE id = $1`,
          [applicationId]
        );

        // Catalog to history timeline
        await dbClient.query(
          `INSERT INTO application_status_history (application_id, changed_by_email, old_status, new_status, reviewer_notes)
           VALUES ($1, $2, $3, 'Correction Required', $4)`,
          [applicationId, req.user.email, oldStatus, notes]
        );

        await dbClient.query('COMMIT');

        // Email applicant asynchronously
        try {
          await sendMail(app.email, mailTemplates.correctionRequired(app.full_name, notes));
        } catch (mailErr: any) {
          console.error('[Admin Review Flag] Email dispatch failed:', mailErr.message);
        }

        return res.status(200).json({ message: 'Application flagged. Correction instructions sent.' });
      } 
      
      else if (action === 'Reject') {
        if (!notes) {
          dbClient.release();
          return res.status(400).json({ error: 'Action Rejected. Rejection notes are mandatory.' });
        }

        await dbClient.query(
          `UPDATE applications SET status = 'Rejected', updated_at = NOW() WHERE id = $1`,
          [applicationId]
        );

        await dbClient.query(
          `INSERT INTO application_status_history (application_id, changed_by_email, old_status, new_status, reviewer_notes)
           VALUES ($1, $2, $3, 'Rejected', $4)`,
          [applicationId, req.user.email, oldStatus, notes]
        );

        await dbClient.query('COMMIT');

        try {
          await sendMail(app.email, mailTemplates.rejected(app.full_name, notes));
        } catch (mailErr: any) {
          console.error('[Admin Review Reject] Email dispatch failed:', mailErr.message);
        }

        return res.status(200).json({ message: 'Application declined. Notification sent.' });
      } 
      
      else if (action === 'Approve') {
        const currentYear = new Date().getFullYear();
        
        // Count existing approvals in the same category and year to calculate sequence
        const countQuery = await dbClient.query(
          `SELECT COUNT(*) as count 
           FROM applications app
           JOIN membership_categories cat ON app.category_id = cat.id
           WHERE cat.category_code = $1 
             AND app.status = 'Approved' 
             AND EXTRACT(YEAR FROM app.approved_at) = $2`,
          [app.category_code, currentYear]
        );
        
        const sequenceNumber = parseInt(countQuery.rows[0].count, 10) + 1;
        const paddedSequence = String(sequenceNumber).padStart(4, '0');
        const generatedMembershipId = `RIQS-${currentYear}-${app.category_code}-${paddedSequence}`;

        // Map Category Codes to dynamic Member Class designations
        let memberClass = 'Graduate';
        if (app.category_code === 'PQS' || app.category_code === 'FPQS') memberClass = 'Fellow';
        else if (app.category_code === 'QST' || app.category_code === 'FQST') memberClass = 'Technologist';

        // 1. Lock application status
        await dbClient.query(
          `UPDATE applications SET status = 'Approved', approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [applicationId]
        );

        // 2. Generate Professional Credentials in members profile
        await dbClient.query(
          `UPDATE members 
           SET membership_id = $1, membership_class = $2, updated_at = NOW() 
           WHERE id = $3`,
          [generatedMembershipId, memberClass, app.member_id]
        );

        // 3. Write status history timeline
        await dbClient.query(
          `INSERT INTO application_status_history (application_id, changed_by_email, old_status, new_status, reviewer_notes)
           VALUES ($1, $2, $3, 'Approved', 'Application formally approved by Registrar.')`,
          [applicationId, req.user.email, oldStatus]
        );

        // 4. Record dynamic audit log
        await dbClient.query(
          `INSERT INTO audit_logs (member_id, action_by_email, action_type, details)
           VALUES ($1, $2, 'APPROVE', $3)`,
          [app.member_id, req.user.email, `Approved application. Membership ID: ${generatedMembershipId}`]
        );

        await dbClient.query('COMMIT');

        // Email applicant asynchronously
        try {
          await sendMail(app.email, mailTemplates.approved(app.full_name, generatedMembershipId, app.category_name));
        } catch (mailErr: any) {
          console.error('[Admin Review Approve] Email dispatch failed:', mailErr.message);
        }

        return res.status(200).json({
          message: 'Application successfully approved.',
          membershipId: generatedMembershipId
        });
      }

      dbClient.release();
      return res.status(400).json({ error: 'Invalid action. Only Approve, Flag, or Reject allowed.' });
    } catch (err: any) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }
  } catch (error: any) {
    console.error('[Admin Review Decision] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error resolving reviewer decision.' });
  }
}

// 3. Get Full Application Detail (Side-by-Side Review Workspace)
export async function getApplicationDetail(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id } = req.params;

  try {
    // Core application with member and category info
    const appQuery = await pool.query(
      `SELECT app.*, mem.full_name, mem.email, mem.phone_number, mem.date_of_birth, mem.gender,
              mem.nationality, mem.national_id_or_passport, mem.residency_address, mem.work_address,
              mem.years_in_profession, mem.country_of_origin, mem.membership_id, mem.membership_class,
              mem.training_tracking_number,
              cat.category_name, cat.category_code, cat.processing_fee, cat.first_year_fee,
              cat.annual_renewal_fee, cat.stamp_fee, cat.currency, cat.location, cat.entity_type AS cat_entity_type
       FROM applications app
       JOIN members mem ON app.member_id = mem.id
       JOIN membership_categories cat ON app.category_id = cat.id
       WHERE app.id = $1`,
      [id]
    );

    if (appQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    const application = appQuery.rows[0];

    // Fetch all related data packets in parallel
    const [eduRes, shareRes, mentorRes, docRes, studentRes, historyRes] = await Promise.all([
      pool.query('SELECT * FROM education_records WHERE application_id = $1 ORDER BY start_date DESC', [id]),
      pool.query('SELECT * FROM firm_shareholders WHERE application_id = $1', [id]),
      pool.query('SELECT * FROM mentorship_assignments WHERE application_id = $1', [id]),
      pool.query('SELECT id, document_type, file_name, file_size_bytes, uploaded_at FROM uploaded_documents WHERE application_id = $1', [id]),
      pool.query('SELECT * FROM student_association_records WHERE application_id = $1', [id]),
      pool.query('SELECT * FROM application_status_history WHERE application_id = $1 ORDER BY created_at DESC', [id])
    ]);

    return res.status(200).json({
      application,
      education: eduRes.rows,
      shareholders: shareRes.rows,
      mentorship: mentorRes.rows[0] || null,
      documents: docRes.rows,
      studentAssociation: studentRes.rows[0] || null,
      statusHistory: historyRes.rows
    });
  } catch (error: any) {
    console.error('[Admin Application Detail] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching application detail.' });
  }
}

// 4. Assign Reviewer to Application
export async function assignReviewer(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, reviewerId } = req.body;

  if (!applicationId || !reviewerId) {
    return res.status(400).json({ error: 'Missing applicationId or reviewerId.' });
  }

  try {
    const result = await pool.query(
      `UPDATE applications SET assigned_reviewer_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [reviewerId, applicationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found.' });
    }

    // Audit log
    await pool.query(
      `INSERT INTO audit_logs (member_id, action_by_email, action_type, details)
       VALUES ($1, $2, 'REVIEWER_ASSIGNED', $3)`,
      [result.rows[0].member_id, req.user.email, `Reviewer ${reviewerId} assigned to application ${applicationId}.`]
    );

    return res.status(200).json({ message: 'Reviewer assigned.', application: result.rows[0] });
  } catch (error: any) {
    console.error('[Assign Reviewer] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error assigning reviewer.' });
  }
}

// 5. Get Application Status History (Audit Timeline)
export async function getStatusHistory(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM application_status_history WHERE application_id = $1 ORDER BY created_at DESC',
      [applicationId]
    );
    return res.status(200).json({ history: result.rows });
  } catch (error: any) {
    console.error('[Get Status History] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching status history.' });
  }
}

// 6. Get Document Version History (Correction comparison audit)
export async function getDocumentVersions(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM document_versions WHERE application_id = $1 ORDER BY document_type, version_number DESC',
      [applicationId]
    );
    return res.status(200).json({ versions: result.rows });
  } catch (error: any) {
    console.error('[Get Document Versions] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching document versions.' });
  }
}
