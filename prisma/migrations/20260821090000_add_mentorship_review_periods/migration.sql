ALTER TABLE "mentorship_assignments"
ADD COLUMN "agreed_review_period_months" INTEGER;

ALTER TABLE "mentorship_reviews"
ADD COLUMN "review_period_months" INTEGER;
