-- Adds a notes field to every task.
-- Run once in phpMyAdmin: select the `todo_app` database, open the SQL tab, paste this, click Go.
-- Existing tasks are kept and simply get an empty note.

ALTER TABLE tasks ADD COLUMN notes TEXT NULL AFTER title;
