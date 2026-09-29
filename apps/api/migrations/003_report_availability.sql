ALTER TABLE documents ADD COLUMN available_at TEXT;
ALTER TABLE documents ADD COLUMN available_at_status TEXT NOT NULL DEFAULT 'filename_candidate';
ALTER TABLE documents ADD COLUMN available_at_confirmed_at TEXT;

UPDATE documents
SET available_at=publication_date
WHERE available_at IS NULL AND publication_date IS NOT NULL;

