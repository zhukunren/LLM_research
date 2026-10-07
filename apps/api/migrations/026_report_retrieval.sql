ALTER TABLE documents ADD COLUMN parser_metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE VIRTUAL TABLE document_pages_search USING fts5(text, tokenize='trigram');
INSERT INTO document_pages_search(rowid,text)
SELECT rowid,llmr_search_text(text) FROM document_pages;

CREATE TRIGGER document_pages_search_insert AFTER INSERT ON document_pages BEGIN
    INSERT INTO document_pages_search(rowid,text) VALUES(new.rowid,llmr_search_text(new.text));
END;
CREATE TRIGGER document_pages_search_update AFTER UPDATE ON document_pages BEGIN
    DELETE FROM document_pages_search WHERE rowid=old.rowid;
    INSERT INTO document_pages_search(rowid,text) VALUES(new.rowid,llmr_search_text(new.text));
END;
CREATE TRIGGER document_pages_search_delete AFTER DELETE ON document_pages BEGIN
    DELETE FROM document_pages_search WHERE rowid=old.rowid;
END;
