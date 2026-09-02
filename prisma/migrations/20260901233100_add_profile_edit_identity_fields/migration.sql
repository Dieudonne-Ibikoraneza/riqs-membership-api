-- AlterTable
ALTER TABLE "profile_edit_requests"
  ADD COLUMN "proposed_national_id_or_passport" VARCHAR(100),
  ADD COLUMN "proposed_date_of_birth" DATE,
  ADD COLUMN "proposed_gender" VARCHAR(20);
