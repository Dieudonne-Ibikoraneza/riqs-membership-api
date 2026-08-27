-- The mentorship reviewer board previously only captured a free-text
-- "recommendation" (always defaulted to 'Recommend' and never actually
-- surfaced in the UI). Reviewers need an explicit Compliant / Non-compliant
-- verdict, mirroring the application_reviews.compliance_status column, so
-- their assessment can gate the Head Reviewer's forwarding decision the same
-- way it does for the main application review flow.
ALTER TABLE "mentorship_reviews"
  ADD COLUMN "compliance_status" VARCHAR(20);
