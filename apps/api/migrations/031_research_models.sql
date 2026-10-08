ALTER TABLE conversations ADD COLUMN model_id TEXT;
ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT;
ALTER TABLE conversations ADD COLUMN model_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_turns ADD COLUMN model_id TEXT;
ALTER TABLE conversation_turns ADD COLUMN reasoning_effort TEXT;
ALTER TABLE conversation_turns ADD COLUMN model_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_turns ADD COLUMN requested_model_revision INTEGER;

-- Preserve execution evidence before the new snapshot trigger is installed.
-- Some early result blobs are empty, JSON scalars or invalid JSON. Nested CASE
-- guards keep JSON extraction safe; missing values never invent a historical ID.
CREATE TEMP TABLE legacy_research_model_evidence AS
SELECT id AS turn_id, conversation_id, rowid AS turn_order,
    CASE WHEN json_valid(result_json) THEN
        CASE WHEN json_type(result_json,'$.model')='text'
            AND length(trim(json_extract(result_json,'$.model'))) BETWEEN 1 AND 120
            AND trim(json_extract(result_json,'$.model')) NOT GLOB '*[^A-Za-z0-9_.:-]*'
        THEN trim(json_extract(result_json,'$.model')) END
    END AS actual_model_id,
    COALESCE(CASE WHEN json_valid(result_json) THEN
        CASE WHEN json_type(result_json,'$.reasoning_effort')='text'
            AND trim(json_extract(result_json,'$.reasoning_effort')) IN ('none','minimal','low','medium','high','xhigh','max','ultra')
        THEN trim(json_extract(result_json,'$.reasoning_effort')) END
    END, CASE WHEN research_depth='deep' THEN 'max' ELSE 'high' END) AS actual_reasoning_effort
FROM conversation_turns;

UPDATE conversation_turns SET
    model_id=COALESCE(
        (SELECT actual_model_id FROM legacy_research_model_evidence WHERE turn_id=conversation_turns.id),
        (SELECT trim(model) FROM codex_threads WHERE conversation_id=conversation_turns.conversation_id
            AND length(trim(model)) BETWEEN 1 AND 120 AND trim(model) NOT GLOB '*[^A-Za-z0-9_.:-]*')
    ),
    reasoning_effort=(SELECT actual_reasoning_effort FROM legacy_research_model_evidence WHERE turn_id=conversation_turns.id);

-- Per-turn results are stronger evidence than the mutable latest thread binding.
-- An unavailable or retired model remains selected until the user changes it.
UPDATE conversations SET
    model_id=COALESCE(
        (SELECT actual_model_id FROM legacy_research_model_evidence
            WHERE conversation_id=conversations.id AND actual_model_id IS NOT NULL ORDER BY turn_order DESC LIMIT 1),
        (SELECT trim(model) FROM codex_threads WHERE conversation_id=conversations.id
            AND length(trim(model)) BETWEEN 1 AND 120 AND trim(model) NOT GLOB '*[^A-Za-z0-9_.:-]*')
    ),
    reasoning_effort=COALESCE(
        (SELECT actual_reasoning_effort FROM legacy_research_model_evidence
            WHERE conversation_id=conversations.id AND actual_model_id IS NOT NULL ORDER BY turn_order DESC LIMIT 1),
        (SELECT actual_reasoning_effort FROM legacy_research_model_evidence
            WHERE conversation_id=conversations.id ORDER BY turn_order DESC LIMIT 1),
        CASE WHEN research_depth='deep' THEN 'max' ELSE 'high' END
    );

DROP TABLE legacy_research_model_evidence;

CREATE TRIGGER conversation_turn_model_immutable
BEFORE UPDATE OF model_id,reasoning_effort,model_revision,requested_model_revision ON conversation_turns
BEGIN
    SELECT RAISE(ABORT, 'Turn model snapshots are immutable');
END;
