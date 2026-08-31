-- Technologists/Professionals no longer become mentors automatically on upgrade — they now
-- either apply here (reviewed by an Admin/Admin Assistant) or are promoted directly by an
-- Admin/Approver from their member profile.
CREATE TABLE "mentor_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "member_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Pending',
    "motivation" TEXT,
    "review_notes" TEXT,
    "reviewed_by_email" VARCHAR(255),
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentor_applications_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "mentor_applications"
  ADD CONSTRAINT "mentor_applications_member_id_fkey"
  FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "mentor_applications_member_id_idx" ON "mentor_applications"("member_id");
CREATE INDEX "mentor_applications_status_idx" ON "mentor_applications"("status");
