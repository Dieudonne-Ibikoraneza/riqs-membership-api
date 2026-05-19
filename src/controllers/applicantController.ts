import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { pool } from '../config/db';

// 1. Fetch complete application packet (including educations, documents, mentorships, and shareholders)
export async function getApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  try {
    const appQuery = await pool.query(
      `SELECT app.*, cat.category_name, cat.processing_fee, cat.first_year_fee, cat.annual_renewal_fee 
       FROM applications app
       JOIN membership_categories cat ON app.category_id = cat.id
       WHERE app.member_id = $1`,
      [req.user.id]
    );

    if (appQuery.rows.length === 0) {
      return res.status(200).json({ application: null, message: 'No active application draft found for this member.' });
    }

    const application = appQuery.rows[0];

    // Fetch related database packets in parallel
    const [eduRes, shareRes, mentorRes, docRes] = await Promise.all([
      pool.query('SELECT * FROM education_records WHERE application_id = $1', [application.id]),
      pool.query('SELECT * FROM firm_shareholders WHERE application_id = $1', [application.id]),
      pool.query('SELECT * FROM mentorship_assignments WHERE application_id = $1', [application.id]),
      pool.query('SELECT id, document_type, file_name, uploaded_at FROM uploaded_documents WHERE application_id = $1', [application.id])
    ]);

    return res.status(200).json({
      application,
      education: eduRes.rows,
      shareholders: shareRes.rows,
      mentorship: mentorRes.rows[0] || null,
      documents: docRes.rows
    });
  } catch (error: any) {
    console.error('[Get Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching application details.' });
  }
}

// 2. Upsert Application (Draft Auto-Saver & Phase B Lock Policy Enforcer)
export async function createOrUpdateApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const {
    practiceLocation,
    entityType,
    categoryId,
    isEmployed,
    currentEmployer,
    jobTitle,
    prevEmployer,
    prevJobTitle,
    fullName,
    phoneNumber,
    dob,
    gender,
    nationality,
    nationalIdOrPassport,
    residencyAddress,
    workAddress,
    yearsInProfession,
    countryOfOrigin
  } = req.body;

  if (!practiceLocation || !entityType || !categoryId) {
    return res.status(400).json({ error: 'Missing mandatory registration classifiers: location, entity type, and category.' });
  }

  try {
    const checkQuery = await pool.query('SELECT * FROM applications WHERE member_id = $1', [req.user.id]);
    
    // Perform dynamic updates to the members profile table in parallel
    await pool.query(
      `UPDATE members 
       SET full_name = COALESCE($1, full_name), 
           phone_number = COALESCE($2, phone_number), 
           date_of_birth = COALESCE($3, date_of_birth), 
           gender = COALESCE($4, gender), 
           nationality = COALESCE($5, nationality), 
           national_id_or_passport = COALESCE($6, national_id_or_passport), 
           residency_address = COALESCE($7, residency_address), 
           work_address = COALESCE($8, work_address), 
           years_in_profession = COALESCE($9, years_in_profession), 
           country_of_origin = COALESCE($10, country_of_origin),
           updated_at = NOW()
       WHERE id = $11`,
      [
        fullName || null,
        phoneNumber || null,
        dob || null,
        gender || null,
        nationality || null,
        nationalIdOrPassport || null,
        residencyAddress || null,
        workAddress || null,
        yearsInProfession !== undefined && yearsInProfession !== null && yearsInProfession !== '' ? parseInt(String(yearsInProfession)) : null,
        countryOfOrigin || null,
        req.user.id
      ]
    );

    if (checkQuery.rows.length > 0) {
      const existingApp = checkQuery.rows[0];

      // STRICT COMPLIANCE: If status is 'Approved' (Phase B), verify locked categories
      if (existingApp.status === 'Approved') {
        if (
          existingApp.practice_location !== practiceLocation ||
          existingApp.entity_type !== entityType ||
          existingApp.category_id !== categoryId
        ) {
          return res.status(400).json({ error: 'Compliance Lock Violation: You cannot alter registration categories or entity scopes post-approval.' });
        }
      }

      // Update the existing draft
      const updateRes = await pool.query(
        `UPDATE applications 
         SET practice_location = $1, entity_type = $2, category_id = $3, is_employed = $4, 
             current_employer = $5, job_title = $6, prev_employer = $7, prev_job_title = $8, updated_at = NOW()
         WHERE member_id = $9 RETURNING *`,
        [
          practiceLocation,
          entityType,
          categoryId,
          isEmployed || false,
          currentEmployer || null,
          jobTitle || null,
          prevEmployer || null,
          prevJobTitle || null,
          req.user.id
        ]
      );

      // Audit Log for Phase B modifications
      if (existingApp.status === 'Approved') {
        await pool.query(
          `INSERT INTO audit_logs (member_id, action_by_email, action_type, details)
           VALUES ($1, $2, 'PHASE_B_EDIT', 'Approved member updated dynamic employer profile records.')`,
          [req.user.id, req.user.email]
        );
      }

      return res.status(200).json({ 
        message: 'Application draft successfully auto-saved.', 
        application: updateRes.rows[0] 
      });
    }

    // Create fresh Application Draft (Phase A initiation)
    const insertRes = await pool.query(
      `INSERT INTO applications (member_id, practice_location, entity_type, category_id, is_employed, current_employer, job_title, prev_employer, prev_job_title, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Draft') RETURNING *`,
      [
        req.user.id,
        practiceLocation,
        entityType,
        categoryId,
        isEmployed || false,
        currentEmployer || null,
        jobTitle || null,
        prevEmployer || null,
        prevJobTitle || null
      ]
    );

    return res.status(201).json({ 
      message: 'Application initialized as Draft.', 
      application: insertRes.rows[0] 
    });
  } catch (error: any) {
    console.error('[Upsert Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error auto-saving application draft.' });
  }
}

// 3. Upsert Shareholders - Bulk loads and checks for 100.00% exact shareholdings
export async function upsertShareholders(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId, shareholders } = req.body;
  if (!applicationId || !Array.isArray(shareholders) || shareholders.length === 0) {
    return res.status(400).json({ error: 'Missing applicationId or invalid shareholders payload list.' });
  }

  // Enforce strict 100.00% Shareholding total sum validation
  let totalShares = 0;
  for (const s of shareholders) {
    const percentage = parseFloat(s.shareholdingPercentage);
    if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
      return res.status(400).json({ error: 'Invalid shareholding percentage. Percentage per partner must be between 0% and 100%.' });
    }
    totalShares += percentage;
  }

  // Handle potential float decimal rounding (e.g., 3 shareholders dividing equally)
  const roundedSum = Math.round(totalShares * 100) / 100;
  if (roundedSum !== 100.00) {
    return res.status(400).json({
      error: `Compliance Validation Violation: Total firm shareholding must sum to exactly 100.00%. Sum currently calculated: ${roundedSum}%`
    });
  }

  try {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      // Clear previous shareholder details
      await dbClient.query('DELETE FROM firm_shareholders WHERE application_id = $1', [applicationId]);

      // Bulk Load Partner Rows
      for (const s of shareholders) {
        await dbClient.query(
          `INSERT INTO firm_shareholders (application_id, full_name, email, phone_number, citizenship, shareholding_percentage, riqs_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            applicationId,
            s.fullName,
            s.email,
            s.phoneNumber,
            s.citizenship || 'Rwandan',
            s.shareholdingPercentage,
            s.riqsMembershipId || null
          ]
        );
      }

      await dbClient.query('COMMIT');
      return res.status(200).json({ message: 'Firm shareholder percentages successfully verified and locked.' });
    } catch (err: any) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }
  } catch (error: any) {
    console.error('[Upsert Shareholders] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while verifying shareholder records.' });
  }
}

// 4. Submit Application - Finalizes and locks Phase A drafts, entering the Reviewer Queue
export async function submitApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId } = req.body;
  if (!applicationId) {
    return res.status(400).json({ error: 'Missing applicationId in submission request.' });
  }

  try {
    // Lock state transitions: Applications can only be submitted if currently in 'Draft' or 'Correction Required'
    const submitRes = await pool.query(
      `UPDATE applications 
       SET status = 'Pending', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND member_id = $2 AND status IN ('Draft', 'Correction Required') RETURNING *`,
      [applicationId, req.user.id]
    );

    if (submitRes.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid submission request. Application is not in Draft or Correction state.' });
    }

    return res.status(200).json({
      message: 'Application locked and successfully submitted to review queue.',
      application: submitRes.rows[0]
    });
  } catch (error: any) {
    console.error('[Submit Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error locking application.' });
  }
}
