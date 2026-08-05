CREATE TABLE "mentorship_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "application_id" UUID NOT NULL,
  "mentorship_assignment_id" UUID NOT NULL,
  "reviewer_id" UUID NOT NULL,
  "recommendation" VARCHAR(50) NOT NULL DEFAULT 'Recommend',
  "proposed_assessment_date" TIMESTAMPTZ,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mentorship_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mentorship_reviews_application_id_reviewer_id_key" UNIQUE ("application_id", "reviewer_id"),
  CONSTRAINT "mentorship_reviews_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "mentorship_reviews_mentorship_assignment_id_fkey" FOREIGN KEY ("mentorship_assignment_id") REFERENCES "mentorship_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "mentorship_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Existing requests that were waiting for the old direct Admin review must
-- pass through the new reviewer-board gate as well.
UPDATE "mentorship_assignments"
SET "status" = 'Pending_Reviewer_Board'
WHERE "status" = 'Pending_Admin_Review'
  AND "upgrade_requested" = true;
