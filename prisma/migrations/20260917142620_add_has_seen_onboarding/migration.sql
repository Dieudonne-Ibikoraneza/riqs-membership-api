-- Tracks whether a member has completed (or dismissed) the first-run guided dashboard
-- tour, so it only ever shows once. Existing rows default to false — nobody has seen a
-- tour that didn't exist yet, which is the correct state for them.
ALTER TABLE "members" ADD COLUMN "has_seen_onboarding" BOOLEAN NOT NULL DEFAULT false;
