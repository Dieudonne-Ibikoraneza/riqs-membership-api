-- Allow education/employment records to be attached directly to a Member
-- (post-approval additions), not only to an Application.
ALTER TABLE "education_records"
  ALTER COLUMN "application_id" DROP NOT NULL,
  ADD COLUMN "member_id" UUID,
  ADD COLUMN "certificate_url" TEXT;

ALTER TABLE "education_records"
  ADD CONSTRAINT "education_records_member_id_fkey"
  FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE;

ALTER TABLE "employment_records"
  ALTER COLUMN "application_id" DROP NOT NULL,
  ADD COLUMN "member_id" UUID;

ALTER TABLE "employment_records"
  ADD CONSTRAINT "employment_records_member_id_fkey"
  FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE;

-- Profile edit requests (member-submitted, admin-reviewed)
CREATE TABLE "profile_edit_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "member_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'Pending',
  "proposed_full_name" VARCHAR(255),
  "proposed_residency_address" JSONB,
  "proposed_work_address" JSONB,
  "proposed_profile_photo_url" TEXT,
  "proposed_education" JSONB,
  "proposed_employment" JSONB,
  "member_notes" TEXT,
  "review_notes" TEXT,
  "reviewed_by_email" VARCHAR(255),
  "reviewed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ DEFAULT now(),
  "updated_at" TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT "profile_edit_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "profile_edit_requests"
  ADD CONSTRAINT "profile_edit_requests_member_id_fkey"
  FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE;
