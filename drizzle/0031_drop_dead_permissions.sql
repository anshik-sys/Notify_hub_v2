-- reminders.view and reminders.delete were never checked by any code (visibility
-- rules decide what you see; cancelling needs reminders.edit). They're gone
-- from the catalogue; strip them from stored roles, the Member system role included.
UPDATE roles
SET permissions = array_remove(array_remove(permissions, 'reminders.view'), 'reminders.delete')
WHERE permissions && ARRAY['reminders.view', 'reminders.delete'];
