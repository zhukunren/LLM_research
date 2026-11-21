-- Switch saved templates that still use the original default. Card versions
-- and templates with a different theme retain their recorded choices.
UPDATE client_service_settings
SET revision = revision + 1,
    config_json = json_set(
        config_json,
        '$.revision', revision + 1,
        '$.templates', (
            SELECT json_group_array(json(template))
            FROM (
                SELECT CASE
                    WHEN coalesce(json_extract(value, '$.content.theme'), 'river') = 'river'
                    THEN json_set(value, '$.content.theme', 'soochow')
                    ELSE value
                END AS template
                FROM json_each(client_service_settings.config_json, '$.templates')
                ORDER BY key
            )
        )
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
WHERE EXISTS (
    SELECT 1 FROM json_each(config_json, '$.templates')
    WHERE coalesce(json_extract(value, '$.content.theme'), 'river') = 'river'
);

UPDATE client_opening_plan_content
SET revision = revision + 1,
    content_json = json_set(content_json, '$.theme', 'soochow'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
WHERE scope = 'template'
  AND coalesce(json_extract(content_json, '$.theme'), 'river') = 'river';
