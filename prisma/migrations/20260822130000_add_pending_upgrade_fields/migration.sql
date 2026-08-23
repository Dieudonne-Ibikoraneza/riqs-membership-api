-- Adds fields tracking a membership-class upgrade (APC pass or Associate award)
-- that has been decided but is held pending the member paying the new
-- category's first-year fee. Cleared once that fee's FinancialTransaction is
-- marked Cleared.
ALTER TABLE "applications"
  ADD COLUMN "pending_upgrade_class" "MemberClass",
  ADD COLUMN "pending_upgrade_category_id" UUID,
  ADD COLUMN "pending_upgrade_cert_code" VARCHAR(10),
  ADD COLUMN "pending_upgrade_promote_to_mentor" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "applications"
  ADD CONSTRAINT "applications_pending_upgrade_category_id_fkey"
  FOREIGN KEY ("pending_upgrade_category_id") REFERENCES "membership_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
