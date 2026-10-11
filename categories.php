<?php
header('Content-Type: application/json');
require __DIR__ . '/db.php';

$method = $_SERVER['REQUEST_METHOD'];
$input  = json_decode(file_get_contents('php://input'), true) ?? [];

function fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function clean_name($value) {
    $name = trim((string)$value);
    if ($name === '' || mb_strlen($name) > 40) fail(422, 'Enter a category name up to 40 characters.');
    return $name;
}

function clean_color($value) {
    $color = (string)$value;
    if (!preg_match('/^#[0-9a-fA-F]{6}$/', $color)) fail(422, 'Choose a valid colour.');
    return $color;
}

try {
    switch ($method) {
        case 'GET':
            $rows = $pdo->query('SELECT id, name, color FROM categories ORDER BY name')->fetchAll();
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; }
            echo json_encode($rows);
            break;

        case 'POST':
            $name  = clean_name($input['name'] ?? '');
            $color = clean_color($input['color'] ?? '');
            $pdo->prepare('INSERT INTO categories (name, color) VALUES (?, ?)')->execute([$name, $color]);
            echo json_encode(['id' => (int)$pdo->lastInsertId()]);
            break;

        case 'PUT': // rename and/or recolour
            $id = (int)($input['id'] ?? 0);
            if (!$id) fail(422, 'Missing category id.');

            $fields = [];
            $params = [];
            if (array_key_exists('name', $input)) {
                $fields[] = 'name = ?';  $params[] = clean_name($input['name']);
            }
            if (array_key_exists('color', $input)) {
                $fields[] = 'color = ?'; $params[] = clean_color($input['color']);
            }
            if (!$fields) fail(422, 'Nothing to update.');

            $params[] = $id;
            $pdo->prepare('UPDATE categories SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($params);
            echo json_encode(['ok' => true]);
            break;

        case 'DELETE': // tasks in this category keep existing, but lose the label
            $id = (int)($input['id'] ?? 0);
            if (!$id) fail(422, 'Missing category id.');
            $pdo->prepare('DELETE FROM categories WHERE id = ?')->execute([$id]);
            echo json_encode(['ok' => true]);
            break;

        default:
            fail(405, 'Method not allowed.');
    }
} catch (PDOException $e) {
    if ($e->getCode() === '23000') fail(409, 'That category already exists.');
    fail(500, 'Database error. Did you import migration_categories.sql?');
}
