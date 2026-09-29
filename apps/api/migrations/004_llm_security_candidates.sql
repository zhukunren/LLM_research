ALTER TABLE documents ADD COLUMN stock_code_source TEXT NOT NULL DEFAULT 'filename';
ALTER TABLE documents ADD COLUMN stock_code_evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE documents ADD COLUMN stock_code_model TEXT;
ALTER TABLE documents ADD COLUMN stock_code_extracted_at TEXT;

