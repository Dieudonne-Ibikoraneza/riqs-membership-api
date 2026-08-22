ALTER TABLE "mentorship_assignments"
ADD COLUMN "agreed_review_period_start" DATE,
ADD COLUMN "agreed_review_period_end" DATE;

ALTER TABLE "mentorship_reviews"
ADD COLUMN "review_period_start" DATE,
ADD COLUMN "review_period_end" DATE;
