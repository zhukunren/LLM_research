DROP TRIGGER task_revisions_immutable;

CREATE TRIGGER task_revision_update_guard
BEFORE UPDATE ON screening_task_revisions
WHEN OLD.revision != (SELECT task_revision FROM conversations WHERE id=OLD.conversation_id)
  OR NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.revision IS NOT OLD.revision
  OR NEW.source_message_id IS NOT OLD.source_message_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'Only the current screening task JSON may be updated');
END;
