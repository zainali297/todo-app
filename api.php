<?php
header('Content-Type: application/json');
require __DIR__ . '/db.php';

$method = $_SERVER['REQUEST_METHOD'];
$input  = json_decode(file_get_contents('php://input'), true) ?? [];
const PRIORITIES = ['low', 'medium', 'high'];

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
                'SELECT id, title, notes, is_done, due_date, priority, category_id, sort_order, completed_at
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
            // New tasks go to the end of "My order".
            $next = (int)$pdo->query('SELECT COALESCE(MAX(sort_order), 0) FROM tasks')->fetchColumn() + 1;
            $stmt = $pdo->prepare(
                'INSERT INTO tasks (title, notes, due_date, priority, category_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([$title, $notes, $due, $priority, $category, $next]);
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

            $fields = [];
            $params = [];
            if (array_key_exists('title', $input)) {
                $fields[] = 'title = ?';       $params[] = clean_title($input['title']);
            }
            if (array_key_exists('notes', $input)) {
                $fields[] = 'notes = ?';       $params[] = clean_notes($input['notes']);
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
            $pdo->prepare('UPDATE tasks SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($params);
            echo json_encode(['ok' => true]);
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
    fail(500, 'Database error. Did you run migration_notes.sql?');
}
