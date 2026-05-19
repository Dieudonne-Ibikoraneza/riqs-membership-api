import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { pool } from '../config/db';

// 1. Fetch APC assessment tracking records
export async function getAPCStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  try {
    const apcQuery = await pool.query(
      'SELECT * FROM apc_assessments WHERE member_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );

    return res.status(200).json({ assessments: apcQuery.rows });
  } catch (error: any) {
    console.error('[Get APC Status] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching APC progression records.' });
  }
}

// 2. Schedule APC Assessment (Registers graduates for examinations)
export async function registerAPC(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId, assessmentDate, panelChair, examiner1, examiner2 } = req.body;

  if (!applicationId || !assessmentDate) {
    return res.status(400).json({ error: 'Missing required parameters: applicationId and assessmentDate.' });
  }

  try {
    const insertRes = await pool.query(
      `INSERT INTO apc_assessments (member_id, application_id, assessment_date, panel_chair_name, examiner_1_name, examiner_2_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Scheduled') RETURNING *`,
      [
        req.user.id,
        applicationId,
        assessmentDate,
        panelChair || 'Board Chair TBD',
        examiner1 || 'Examiner 1 TBD',
        examiner2 || 'Examiner 2 TBD'
      ]
    );

    return res.status(201).json({
      message: 'Assessment of Professional Competency (APC) board successfully scheduled.',
      assessment: insertRes.rows[0]
    });
  } catch (error: any) {
    console.error('[Register APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error scheduling APC board.' });
  }
}

// 3. Grade APC Assessment (Admin records pass/fail and triggers class upgrade)
export async function gradeAPC(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { assessmentId, status, scorePercentage, assessmentNotes, stampFeePaid, licenseIssued } = req.body;

  if (!assessmentId || !status) {
    return res.status(400).json({ error: 'Missing assessmentId or status.' });
  }

  const validStatuses = ['Attended', 'Passed', 'Failed', 'No Show'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      // Update APC record
      const apcRes = await dbClient.query(
        `UPDATE apc_assessments
         SET status = $1, score_percentage = $2, assessment_notes = $3,
             stamp_fee_paid = $4, license_issued = $5, updated_at = NOW()
         WHERE id = $6 RETURNING *`,
        [status, scorePercentage || null, assessmentNotes || null, stampFeePaid || false, licenseIssued || false, assessmentId]
      );

      if (apcRes.rows.length === 0) {
        await dbClient.query('ROLLBACK');
        return res.status(404).json({ error: 'APC assessment not found.' });
      }

      const apc = apcRes.rows[0];

      // If passed, upgrade the member's class
      if (status === 'Passed') {
        // Determine new class from category
        const catQuery = await dbClient.query(
          `SELECT cat.category_code FROM applications app
           JOIN membership_categories cat ON app.category_id = cat.id
           WHERE app.id = $1`,
          [apc.application_id]
        );

        if (catQuery.rows.length > 0) {
          const code = catQuery.rows[0].category_code;
          let newClass = 'Technologist';
          if (code === 'GQS' || code === 'PQS' || code === 'FPQS') newClass = 'Fellow';

          await dbClient.query(
            `UPDATE members SET membership_class = $1, updated_at = NOW() WHERE id = $2`,
            [newClass, apc.member_id]
          );
        }
      }

      // Audit log
      await dbClient.query(
        `INSERT INTO audit_logs (member_id, action_by_email, action_type, details)
         VALUES ($1, $2, 'APC_GRADED', $3)`,
        [apc.member_id, req.user.email, `APC ${assessmentId} graded as ${status}. Score: ${scorePercentage || 'N/A'}%`]
      );

      await dbClient.query('COMMIT');
      return res.status(200).json({ message: `APC assessment graded: ${status}.`, assessment: apcRes.rows[0] });
    } catch (err: any) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }
  } catch (error: any) {
    console.error('[Grade APC] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error grading APC assessment.' });
  }
}

// 4. Update Member Profile (Phase B editable fields: Full Name only — with mandatory audit)
export async function updateMemberProfile(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { fullName } = req.body;

  if (!fullName || fullName.trim().length < 2) {
    return res.status(400).json({ error: 'Full name must be at least 2 characters.' });
  }

  try {
    const memberQuery = await pool.query('SELECT * FROM members WHERE id = $1', [req.user.id]);
    if (memberQuery.rows.length === 0) return res.status(404).json({ error: 'Member profile not found.' });

    const oldName = memberQuery.rows[0].full_name;

    if (oldName === fullName.trim()) {
      return res.status(200).json({ message: 'No changes detected.', member: memberQuery.rows[0] });
    }

    const result = await pool.query(
      `UPDATE members SET full_name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [fullName.trim(), req.user.id]
    );

    // Mandatory Phase B audit log for name changes
    await pool.query(
      `INSERT INTO audit_logs (member_id, action_by_email, action_type, details)
       VALUES ($1, $2, 'NAME_CHANGE', $3)`,
      [req.user.id, req.user.email, `Name changed from "${oldName}" to "${fullName.trim()}".`]
    );

    return res.status(200).json({ message: 'Profile name updated. Audit record created.', member: result.rows[0] });
  } catch (error: any) {
    console.error('[Update Member Profile] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error updating profile.' });
  }
}

// 5. Get Mentorship Progress for current member
export async function getMentorshipProgress(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    const result = await pool.query(
      `SELECT ma.*, app.status as application_status, app.approved_at,
              cat.category_name, cat.category_code
       FROM mentorship_assignments ma
       JOIN applications app ON ma.application_id = app.id
       JOIN membership_categories cat ON app.category_id = cat.id
       WHERE app.member_id = $1`,
      [req.user.id]
    );

    return res.status(200).json({ mentorship: result.rows[0] || null });
  } catch (error: any) {
    console.error('[Get Mentorship Progress] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching mentorship progress.' });
  }
}

