import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { pool } from '../config/db';

// 1. Add Education Record (Repeatable — supports multiple degrees per application)
export async function addEducationRecord(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, institution, qualificationType, fieldOfStudy, startDate, endDate } = req.body;

  if (!applicationId || !institution || !qualificationType || !fieldOfStudy || !startDate || !endDate) {
    return res.status(400).json({ error: 'Missing required education fields: institution, qualificationType, fieldOfStudy, startDate, endDate.' });
  }

  try {
    // Verify ownership
    const appCheck = await pool.query('SELECT member_id, status FROM applications WHERE id = $1', [applicationId]);
    if (appCheck.rows.length === 0) return res.status(404).json({ error: 'Application not found.' });

    const app = appCheck.rows[0];
    const isOwner = app.member_id === req.user.id;
    if (!isOwner) return res.status(403).json({ error: 'Access Denied. Not your application.' });

    const result = await pool.query(
      `INSERT INTO education_records (application_id, institution, qualification_type, field_of_study, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [applicationId, institution, qualificationType, fieldOfStudy, startDate, endDate]
    );

    // Audit log if Phase B edit
    if (app.status === 'Approved') {
      await pool.query(
        `INSERT INTO audit_logs (member_id, action_by_email, action_type, details)
         VALUES ($1, $2, 'PHASE_B_EDUCATION_ADD', $3)`,
        [req.user.id, req.user.email, `Added education record: ${institution} — ${qualificationType}`]
      );
    }

    return res.status(201).json({ message: 'Education record added.', education: result.rows[0] });
  } catch (error: any) {
    console.error('[Add Education] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error adding education record.' });
  }
}

// 2. Get all education records for an application
export async function getEducationRecords(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId } = req.params;

  try {
    const records = await pool.query(
      'SELECT * FROM education_records WHERE application_id = $1 ORDER BY start_date DESC',
      [applicationId]
    );
    return res.status(200).json({ education: records.rows });
  } catch (error: any) {
    console.error('[Get Education] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching education records.' });
  }
}

// 3. Delete an education record
export async function deleteEducationRecord(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { id } = req.params;

  try {
    // Verify ownership via join
    const check = await pool.query(
      `SELECT er.id, app.member_id, app.status FROM education_records er
       JOIN applications app ON er.application_id = app.id
       WHERE er.id = $1`, [id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Education record not found.' });
    if (check.rows[0].member_id !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });
    if (check.rows[0].status === 'Approved') {
      return res.status(400).json({ error: 'Cannot delete education records post-approval. You may only add new qualifications.' });
    }

    await pool.query('DELETE FROM education_records WHERE id = $1', [id]);
    return res.status(200).json({ message: 'Education record deleted.' });
  } catch (error: any) {
    console.error('[Delete Education] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error deleting education record.' });
  }
}

// 4. Upsert Student Association Record (1:1 per application)
export async function upsertStudentAssociation(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, associationName, membershipNumber, registrationDate, activeYears } = req.body;

  if (!applicationId || !associationName || !membershipNumber || !registrationDate || !activeYears) {
    return res.status(400).json({ error: 'Missing required student association fields.' });
  }

  try {
    const appCheck = await pool.query('SELECT member_id FROM applications WHERE id = $1', [applicationId]);
    if (appCheck.rows.length === 0) return res.status(404).json({ error: 'Application not found.' });
    if (appCheck.rows[0].member_id !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });

    // Upsert: delete old + insert new (1:1 constraint)
    await pool.query('DELETE FROM student_association_records WHERE application_id = $1', [applicationId]);

    const result = await pool.query(
      `INSERT INTO student_association_records (application_id, association_name, membership_number, registration_date, active_years)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [applicationId, associationName, membershipNumber, registrationDate, activeYears]
    );

    return res.status(200).json({ message: 'Student association record saved.', association: result.rows[0] });
  } catch (error: any) {
    console.error('[Upsert Student Association] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error saving student association.' });
  }
}

// 5. Upsert Mentorship Assignment (1:1 per application)
export async function upsertMentorship(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const {
    applicationId, mentorName, mentorQualification, mentorClass,
    mentorRegistrationNumber, mentorEmployer, mentorContact,
    isSelfAssigned, requestedInstitutionalAssignment, preferredPracticeAreas
  } = req.body;

  if (!applicationId) {
    return res.status(400).json({ error: 'Missing applicationId.' });
  }

  try {
    const appCheck = await pool.query('SELECT member_id FROM applications WHERE id = $1', [applicationId]);
    if (appCheck.rows.length === 0) return res.status(404).json({ error: 'Application not found.' });
    if (appCheck.rows[0].member_id !== req.user.id) return res.status(403).json({ error: 'Access Denied.' });

    // Upsert: delete old + insert new (1:1 constraint)
    await pool.query('DELETE FROM mentorship_assignments WHERE application_id = $1', [applicationId]);

    const result = await pool.query(
      `INSERT INTO mentorship_assignments
       (application_id, mentor_name, mentor_qualification, mentor_class,
        mentor_registration_number, mentor_employer, mentor_contact,
        is_self_assigned, requested_institutional_assignment, preferred_practice_areas)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        applicationId,
        mentorName || null,
        mentorQualification || null,
        mentorClass || null,
        mentorRegistrationNumber || null,
        mentorEmployer || null,
        mentorContact || null,
        isSelfAssigned !== undefined ? isSelfAssigned : true,
        requestedInstitutionalAssignment || false,
        preferredPracticeAreas || null
      ]
    );

    return res.status(200).json({ message: 'Mentorship assignment saved.', mentorship: result.rows[0] });
  } catch (error: any) {
    console.error('[Upsert Mentorship] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error saving mentorship assignment.' });
  }
}
