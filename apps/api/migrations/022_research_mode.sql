ALTER TABLE conversations ADD COLUMN research_mode TEXT NOT NULL DEFAULT 'research'
    CHECK (research_mode IN ('research','screening','advanced'));
