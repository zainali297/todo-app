<?php
// Backup (download) and restore (upload) for the to-do app.
//   GET  backup.php?format=json  -> full backup: categories + tasks
//   GET  backup.php?format=csv   -> tasks as a spreadsheet-friendly CSV
//   POST backup.php              -> restore from a JSON backup ({ mode: "merge"|"replace", backup: {...} })
require __DIR__ . '/db.php';

function fail($code, $msg) {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(['error' => $msg]);
    exit;
}

function bad($msg) { throw new InvalidArgumentException($msg); }

function valid_date($value, $label) {
    if ($value === null || $value === '') return null;
    $d = DateTime::createFromFormat('Y-m-d', (string)$value);
    if (!$d || $d->format('Y-m-d') !== $value) bad("$label has an invalid due date.");
    return $value;
}

function valid_datetime($value, $label) {
    if ($value === null || $value === '') return null;
    $d = DateTime::createFromFormat('Y-m-d H:i:s', (string)$value);
    if (!$d || $d->format('Y-m-d H:i:s') !== $value) bad("$label has an invalid date and time.");
    return $value;
}

// Stops spreadsheet programs from running text like "=1+1" as a formula.
function csv_safe($value) {
    $value = (string)$value;
    return ($value !== '' && strpos("=+-@\t\r", $value[0]) !== false) ? "'" . $value : $value;
}

$method = $_SERVER['REQUEST_METHOD'];

/* ---------------- download ---------------- */
if ($method === 'GET') {
    $format = $_GET['format'] ?? 'json';
    if (!in_array($format, ['json', 'csv'], true)) fail(422, 'Format must be json or csv.');

    try {
        $categories = $pdo->query('SELECT id, name, color FROM categories ORDER BY id')->fetchAll();
        $tasks = $pdo->query(
            'SELECT id, title, notes, is_done, due_date, priority, repeat_rule, category_id, sort_order, completed_at, created_at
             FROM tasks ORDER BY sort_order ASC, id ASC'
        )->fetchAll();
    } catch (PDOException $e) {
        fail(500, 'Database error. Did you run migration_notes.sql and migration_recurring.sql?');
    }

    $stamp = date('Y-m-d');

    if ($format === 'json') {
        foreach ($categories as &$c) { $c['id'] = (int)$c['id']; }
        unset($c);
        foreach ($tasks as &$t) {
            $t['id']          = (int)$t['id'];
            $t['is_done']     = (bool)$t['is_done'];
            $t['category_id'] = $t['category_id'] === null ? null : (int)$t['category_id'];
            $t['sort_order']  = (int)$t['sort_order'];
        }
        unset($t);

        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="todo-backup-' . $stamp . '.json"');
        echo json_encode([
            'app'         => 'todo-app',
            'version'     => 1,
            'exported_at' => date('Y-m-d H:i:s'),
            'categories'  => $categories,
            'tasks'       => $tasks,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    // CSV
    $names = [];
    foreach ($categories as $c) { $names[(int)$c['id']] = $c['name']; }

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="todo-tasks-' . $stamp . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF"); // UTF-8 byte order mark so Excel reads accents and other scripts correctly
    fputcsv($out, ['Title', 'Notes', 'Done', 'Due date', 'Repeats', 'Priority', 'Category', 'Completed at', 'Created at'], ',', '"', '');
    foreach ($tasks as $t) {
        $cat = $t['category_id'] !== null ? ($names[(int)$t['category_id']] ?? '') : '';
        fputcsv($out, [
            csv_safe($t['title']),
            csv_safe($t['notes'] ?? ''),
            $t['is_done'] ? 'yes' : 'no',
            $t['due_date'] ?? '',
            $t['repeat_rule'] ?? 'none',
            $t['priority'],
            csv_safe($cat),
            $t['completed_at'] ?? '',
            $t['created_at'] ?? '',
        ], ',', '"', '');
    }
    fclose($out);
    exit;
}

/* ---------------- restore ---------------- */
if ($method !== 'POST') fail(405, 'Method not allowed.');

header('Content-Type: application/json');

$raw = file_get_contents('php://input');
if (strlen($raw) > 10 * 1024 * 1024) fail(413, 'That file is too large (10 MB limit).');
$input = json_decode($raw, true);
if (!is_array($input)) fail(422, 'The upload could not be read.');

$mode = $input['mode'] ?? '';
if (!in_array($mode, ['merge', 'replace'], true)) fail(422, 'Choose whether to add to or replace your current tasks.');

$backup = $input['backup'] ?? null;
if (!is_array($backup) || ($backup['app'] ?? '') !== 'todo-app'
    || !isset($backup['tasks']) || !is_array($backup['tasks'])
    || !is_array($backup['categories'] ?? [])) {
    fail(422, 'This file is not a backup made by this to-do app.');
}
$rawCategories = $backup['categories'] ?? [];
if (count($backup['tasks']) > 10000 || count($rawCategories) > 500) fail(413, 'That backup has too many items.');

try {
    // 1. Check everything first, so a bad file changes nothing.
    $cats = []; // id in the file => ['name' => ..., 'color' => ...]
    foreach ($rawCategories as $i => $c) {
        $n = $i + 1;
        if (!is_array($c)) bad("Category $n is not valid.");
        $id = filter_var($c['id'] ?? null, FILTER_VALIDATE_INT);
        if ($id === false) bad("Category $n has no valid id.");
        $name = trim((string)($c['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 40) bad("Category $n needs a name of 1 to 40 characters.");
        $color = (string)($c['color'] ?? '');
        if (!preg_match('/^#[0-9a-fA-F]{6}$/', $color)) bad("Category $n has an invalid colour.");
        $cats[$id] = ['name' => $name, 'color' => $color];
    }

    $tasks = [];
    foreach ($backup['tasks'] as $i => $t) {
        $n = $i + 1;
        $label = "Task $n";
        if (!is_array($t)) bad("$label is not valid.");
        $title = trim((string)($t['title'] ?? ''));
        if ($title === '' || mb_strlen($title) > 255) bad("$label needs a title of 1 to 255 characters.");
        // Notes are optional (backups made before notes existed have none).
        $notes = trim((string)($t['notes'] ?? ''));
        if (mb_strlen($notes) > 2000) bad("$label has notes longer than 2000 characters.");
        $priority = $t['priority'] ?? 'medium';
        if (!in_array($priority, ['low', 'medium', 'high'], true)) bad("$label has an invalid priority.");
        // Repeat is optional (older backups have none) and needs a due date.
        $repeat = $t['repeat_rule'] ?? 'none';
        if (!in_array($repeat, ['none', 'daily', 'weekly', 'monthly'], true)) bad("$label has an invalid repeat setting.");
        $dueDate = valid_date($t['due_date'] ?? null, $label);
        if ($dueDate === null) $repeat = 'none';
        $isDone = !empty($t['is_done']) ? 1 : 0;
        $catId = filter_var($t['category_id'] ?? null, FILTER_VALIDATE_INT);
        $order = filter_var($t['sort_order'] ?? null, FILTER_VALIDATE_INT);
        $tasks[] = [
            'title'        => $title,
            'notes'        => $notes === '' ? null : $notes,
            'is_done'      => $isDone,
            'due_date'     => $dueDate,
            'priority'     => $priority,
            'repeat_rule'  => $repeat,
            'category_id'  => ($catId !== false && isset($cats[$catId])) ? $catId : null,
            'sort_order'   => $order === false ? $i : $order,
            'completed_at' => $isDone ? valid_datetime($t['completed_at'] ?? null, $label) : null,
            'created_at'   => valid_datetime($t['created_at'] ?? null, $label),
            'index'        => $i,
        ];
    }
    usort($tasks, function ($a, $b) {
        return [$a['sort_order'], $a['index']] <=> [$b['sort_order'], $b['index']];
    });

    // 2. Write everything in one transaction: all of it, or none of it.
    $pdo->beginTransaction();
    if ($mode === 'replace') {
        $pdo->exec('DELETE FROM tasks');
        $pdo->exec('DELETE FROM categories');
    }

    $map = []; // id in the file => id in this database
    $added = 0;
    $find = $pdo->prepare('SELECT id FROM categories WHERE name = ?');
    $addCat = $pdo->prepare('INSERT INTO categories (name, color) VALUES (?, ?)');
    foreach ($cats as $fileId => $c) {
        $find->execute([$c['name']]);
        $existing = $find->fetchColumn();
        if ($existing) {
            $map[$fileId] = (int)$existing;          // same name already exists: reuse it
        } else {
            $addCat->execute([$c['name'], $c['color']]);
            $map[$fileId] = (int)$pdo->lastInsertId();
            $added++;
        }
    }

    $base = (int)$pdo->query('SELECT COALESCE(MAX(sort_order), 0) FROM tasks')->fetchColumn();
    $addTask = $pdo->prepare(
        'INSERT INTO tasks (title, notes, is_done, due_date, priority, category_id, repeat_rule, sort_order, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()))'
    );
    foreach ($tasks as $k => $t) {
        $addTask->execute([
            $t['title'], $t['notes'], $t['is_done'], $t['due_date'], $t['priority'],
            $t['category_id'] === null ? null : $map[$t['category_id']],
            $t['repeat_rule'],
            $base + $k + 1, $t['completed_at'], $t['created_at'],
        ]);
    }
    $pdo->commit();

    echo json_encode(['ok' => true, 'tasks' => count($tasks), 'categories_added' => $added]);
} catch (InvalidArgumentException $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    fail(422, $e->getMessage());
} catch (PDOException $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    fail(500, 'Database error while restoring. Nothing was changed.');
}
