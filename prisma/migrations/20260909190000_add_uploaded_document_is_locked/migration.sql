-- Marks a document as immutable once uploaded outside the normal review flow (e.g. a
-- bulk-imported member self-uploading their missing documents after the application
-- was already Approved). Existing rows all default to false — they went through the
-- normal wizard/review flow and are unaffected.
ALTER TABLE "uploaded_documents" ADD COLUMN "is_locked" BOOLEAN NOT NULL DEFAULT false;
