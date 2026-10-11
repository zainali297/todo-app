<?php
header('Content-Type: application/json');
require __DIR__ . '/db.php';

$method = $_SERVER['REQUEST_METHOD'];
$input  = json_decode(file_get_contents('php://input'), true) ?? [];
const PRIORITIES = ['low', 'medium', 'high'];
const REPEATS = ['none', 'daily', 'weekly', 'monthly'];

function fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function clean_title($value) {
    $title = trim((string)$value);
    if ($title === '' || mb_strlen($title) > 255) fail(422, 'Enter a task between 1 and 255 characters.');
    return $title;
}

// Returns trimmed notes, or null when empty.
function clean_notes($value) {
    $notes = trim((string)($value ?? ''));
    if (mb_strlen($notes) > 2000) fail(422, 'Notes can be up to 2000 characters.');
    return $notes === '' ? null : $notes;
}

// Returns a YYYY-MM-DD string, or null when the date is empty.
function clean_date($value) {
    if ($value === null || $value === '') return null;
    $d = DateTime::createFromFormat('Y-m-d', (string)$value);
    if (!$d || $d->format('Y-m-d') !== $value) fail(422, 'Enter a valid due date.');
    return $value;
}

function clean_priority($value) {
    if (!in_array($value, PRIORITIES, true)) fail(422, 'Priority must be low, medium or high.');
    return $value;
}

function clean_repeat($value) {
    if ($value === null || $value === '') return 'none';
    if (!in_array($value, REPEATS, true)) fail(422, 'Repeat must be none, daily, weekly or monthly.');
    return $value;
}

// Adds whole months to a date, keeping the day of the month (31 Jan + 1 month = 28/29 Feb).
function add_months(DateTime $base, $n) {
    $y = (int)$base->format('Y');
    $m = (int)$base->format('n');
    $d = (int)$base->format('j');
    $total = $y * 12 + ($m - 1) + $n;
    $ny = intdiv($total, 12);
    $nm = $total % 12 + 1;
    $last = (int)(new DateTime(sprintf('%04d-%02d-01', $ny, $nm)))->format('t');
    return new DateTime(sprintf('%04d-%02d-%02d', $ny, $nm, min($d, $last)));
}

// The next due date after $due for a repeating task. Dates before $today are skipped,
// so a task that was finished late does not create a new task that is already overdue.
function next_due($due, $rule, $today) {
    $base = new DateTime($due);
    for ($n = 1; $n <= 5000; $n++) {
        if ($rule === 'daily')      $c = (clone $base)->modify("+$n day");
        elseif ($rule === 'weekly') $c = (clone $base)->modify('+' . (7 * $n) . ' day');
        else                        $c = add_months($base, $n);
        $s = $c->format('Y-m-d');
        if ($s >= $today) return $s;
    }
    return $s;
}

// Returns an existing category id, or null for "no category".
function clean_category($pdo, $value) {
    if ($value === null || $value === '') return null;
    $id = filter_var($value, FILTER_VALIDATE_INT);
    if ($id === false) fail(422, 'Choose a valid category.');
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM categories WHERE id = ?');
    $stmt->execute([$id]);
    if (!$stmt->fetchColumn()) fail(422, 'That category no longer exists.');
    return $id;
}

try {
    switch ($method) {
        case 'GET':
            $rows = $pdo->query(
                'SELECT id, title, notes, is_done, due_date, priority, repeat_rule, category_id, sort_order, completed_at
                 FROM tasks ORDER BY sort_order ASC, id ASC'
            )->fetchAll();
            foreach ($rows as &$r) {
                $r['id']          = (int)$r['id'];
                $r['is_done']     = (bool)$r['is_done'];
                $r['sort_order']  = (int)$r['sort_order'];
                $r['category_id'] = $r['category_id'] === null ? null : (int)$r['category_id'];
            }
            echo json_encode($rows);
            break;

        case 'POST': // add
            $title    = clean_title($input['title'] ?? '');
            $notes    = clean_notes($input['notes'] ?? null);
            $due      = clean_date($input['due_date'] ?? null);
            $priority = clean_priority($input['priority'] ?? 'medium');
            $category = clean_category($pdo, $input['category_id'] ?? null);
            $repeat   = clean_repeat($input['repeat_rule'] ?? 'none');
            if ($repeat !== 'none' && $due === null) fail(422, 'A repeating task needs a due date.');
            // New tasks go to the end of "My order".
            $next = (int)$pdo->query('SELECT COALESCE(MAX(sort_order), 0) FROM tasks')->fetchColumn() + 1;
            $stmt = $pdo->prepare(
                'INSERT INTO tasks (title, notes, due_date, priority, category_id, repeat_rule, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([$title, $notes, $due, $priority, $category, $repeat, $next]);
            echo json_encode(['id' => (int)$pdo->lastInsertId()]);
            break;

        case 'PUT': // update any of: title, notes, is_done, due_date, priority, category_id; or save a new order
            if (array_key_exists('order', $input)) {
                $ids = $input['order'];
                if (!is_array($ids) || count($ids) > 5000) fail(422, 'Invalid order.');
                $pdo->beginTransaction();
                $stmt = $pdo->prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
                foreach (array_values($ids) as $i => $taskId) {
                    $taskId = filter_var($taskId, FILTER_VALIDATE_INT);
                    if ($taskId === false) {
                        $pdo->rollBack();
                        fail(422, 'Invalid order.');
                    }
                    $stmt->execute([$i + 1, $taskId]);
                }
                $pdo->commit();
                echo json_encode(['ok' => true]);
                break;
            }

            $id = (int)($input['id'] ?? 0);
            if (!$id) fail(422, 'Missing task id.');

            // A repeating task needs a due date.
            if (array_key_exists('repeat_rule', $input) || array_key_exists('due_date', $input)) {
                $stmt = $pdo->prepare('SELECT due_date, repeat_rule FROM tasks WHERE id = ?');
                $stmt->execute([$id]);
                $cur = $stmt->fetch();
                if (!$cur) fail(404, 'Task not found.');
                $finalDue  = array_key_exists('due_date', $input) ? clean_date($input['due_date']) : $cur['due_date'];
                $finalRule = array_key_exists('repeat_rule', $input) ? clean_repeat($input['repeat_rule']) : $cur['repeat_rule'];
                if ($finalRule !== 'none' && $finalDue === null) fail(422, 'A repeating task needs a due date.');
            }

            // Remember the task as it was, so its next date can be scheduled if it is being completed now.
            $spawn = null;
            if (!empty($input['is_done'])) {
                $stmt = $pdo->prepare(
                    'SELECT title, notes, is_done, due_date, priority, category_id, repeat_rule FROM tasks WHERE id = ?'
                );
                $stmt->execute([$id]);
                $old = $stmt->fetch();
                if ($old && !(int)$old['is_done'] && $old['repeat_rule'] !== 'none' && $old['due_date'] !== null) {
                    $spawn = $old;
                }
            }

            $fields = [];
            $params = [];
            if (array_key_exists('title', $input)) {
                $fields[] = 'title = ?';       $params[] = clean_title($input['title']);
            }
            if (array_key_exists('notes', $input)) {
                $fields[] = 'notes = ?';       $params[] = clean_notes($input['notes']);
            }
            if (array_key_exists('repeat_rule', $input)) {
                $fields[] = 'repeat_rule = ?'; $params[] = clean_repeat($input['repeat_rule']);
            }
            if (array_key_exists('is_done', $input)) {
                $done = $input['is_done'] ? 1 : 0;
                $fields[] = 'is_done = ?';     $params[] = $done;
                // Remember when a task was completed (used by the stats panel).
                $fields[] = $done ? 'completed_at = NOW()' : 'completed_at = NULL';
            }
            if (array_key_exists('due_date', $input)) {
                $fields[] = 'due_date = ?';    $params[] = clean_date($input['due_date']);
            }
            if (array_key_exists('priority', $input)) {
                $fields[] = 'priority = ?';    $params[] = clean_priority($input['priority']);
            }
            if (array_key_exists('category_id', $input)) {
                $fields[] = 'category_id = ?'; $params[] = clean_category($pdo, $input['category_id']);
            }
            if (!$fields) fail(422, 'Nothing to update.');

            $params[] = $id;
            $pdo->beginTransaction();
            $pdo->prepare('UPDATE tasks SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($params);

            // A repeating task that was just completed schedules its next occurrence.
            $nextDue = null;
            if ($spawn) {
                $today   = clean_date($input['today'] ?? null) ?? date('Y-m-d');
                $nextDue = next_due($spawn['due_date'], $spawn['repeat_rule'], $today);
                $dup = $pdo->prepare(
                    'SELECT COUNT(*) FROM tasks WHERE is_done = 0 AND title = ? AND repeat_rule = ? AND due_date = ?'
                );
                $dup->execute([$spawn['title'], $spawn['repeat_rule'], $nextDue]);
                if (!$dup->fetchColumn()) {   // skip if the same task is already scheduled (e.g. ticked twice)
                    $order = (int)$pdo->query('SELECT COALESCE(MAX(sort_order), 0) FROM tasks')->fetchColumn() + 1;
                    $pdo->prepare(
                        'INSERT INTO tasks (title, notes, due_date, priority, category_id, repeat_rule, sort_order)
                         VALUES (?, ?, ?, ?, ?, ?, ?)'
                    )->execute([
                        $spawn['title'], $spawn['notes'], $nextDue, $spawn['priority'],
                        $spawn['category_id'], $spawn['repeat_rule'], $order,
                    ]);
                }
            }
            $pdo->commit();
            echo json_encode(['ok' => true, 'next_due' => $nextDue]);
            break;

        case 'DELETE':
            if (isset($input['clear_done'])) {
                $pdo->exec('DELETE FROM tasks WHERE is_done = 1');
            } else {
                $id = (int)($input['id'] ?? 0);
                if (!$id) fail(422, 'Missing task id.');
                $pdo->prepare('DELETE FROM tasks WHERE id = ?')->execute([$id]);
            }
            echo json_encode(['ok' => true]);
            break;

        default:
            fail(405, 'Method not allowed.');
    }
} catch (PDOException $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    fail(500, 'Database error. Did you run migration_notes.sql and migration_recurring.sql?');
}
