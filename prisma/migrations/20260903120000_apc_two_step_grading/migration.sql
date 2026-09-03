-- Two-step APC grading: Admin Assistant stages a grade, Admin/Approver confirms it.
ALTER TYPE "ApcStatus" ADD VALUE IF NOT EXISTS 'Pending_Approval';

ALTER TABLE "apc_assessments"
  ADD COLUMN "pre_approval_status" "ApcStatus",
  ADD COLUMN "proposed_status" "ApcStatus",
  ADD COLUMN "proposed_score_percentage" DECIMAL(5,2),
  ADD COLUMN "proposed_assessment_notes" TEXT,
  ADD COLUMN "proposed_stamp_fee_paid" BOOLEAN,
  ADD COLUMN "proposed_license_issued" BOOLEAN,
  ADD COLUMN "graded_by_email" VARCHAR(255),
  ADD COLUMN "graded_at" TIMESTAMPTZ,
  ADD COLUMN "approved_by_email" VARCHAR(255),
  ADD COLUMN "approved_at" TIMESTAMPTZ,
  ADD COLUMN "grading_rejection_reason" TEXT;
