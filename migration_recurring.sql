-- Adds repeating tasks (daily, weekly, monthly).
-- Run once in phpMyAdmin: select the `todo_app` database, open the SQL tab, paste this, click Go.
-- Existing tasks are kept and simply do not repeat.

ALTER TABLE tasks
  ADD COLUMN repeat_rule ENUM('none','daily','weekly','monthly') NOT NULL DEFAULT 'none' AFTER priority;
