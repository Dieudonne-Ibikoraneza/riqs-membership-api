-- Every code path assumes exactly one Application per member (createOrUpdateApplication
-- looks it up via findFirst({where:{memberId}}) and reuses it forever, across every
-- status). Nothing enforced that at the DB level, leaving a narrow race window where two
-- concurrent auto-saves for a brand-new member's first draft could each miss the other
-- and insert two rows. Verified no duplicates exist in the live data before adding this.
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_member_id_key" UNIQUE ("member_id");
