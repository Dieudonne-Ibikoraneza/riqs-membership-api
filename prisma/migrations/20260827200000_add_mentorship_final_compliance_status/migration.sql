-- The Head Reviewer's own final Compliant / Non-compliant conclusion, recorded when
-- forwarding an Associate-route mentorship upgrade to the Admin/Approver — distinct
-- from the individual board members' verdicts already captured in mentorship_reviews.
ALTER TABLE "mentorship_assignments"
  ADD COLUMN "final_compliance_status" VARCHAR(20);
