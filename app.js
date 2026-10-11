const API = 'api.php';
const CAT_API = 'categories.php';
const BACKUP_API = 'backup.php';

const list = document.getElementById('list');
const form = document.getElementById('add-form');
const input = document.getElementById('new-task');
const dueInput = document.getElementById('new-due');
const notesInput = document.getElementById('new-notes');
const prioInput = document.getElementById('new-priority');
const newCatSelect = document.getElementById('new-category');
const catFilterSelect = document.getElementById('category-filter');
const sortSelect = document.getElementById('sort');
const searchInput = document.getElementById('search');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const clearBtn = document.getElementById('clear-done');
const filterBtns = document.querySelectorAll('.filter');
const toastEl = document.getElementById('toast');
const toastMsg = document.getElementById('toast-msg');
const toastUndo = document.getElementById('toast-undo');
const statGrid = document.getElementById('stat-grid');
const statNote = document.getElementById('stat-note');
const statCats = document.getElementById('stat-cats');
const restoreForm = document.getElementById('restore-form');
const restoreFile = document.getElementById('restore-file');
const restoreBtn = document.getElementById('restore-btn');
const restoreMsg = document.getElementById('restore-msg');
const hintEl = document.getElementById('reorder-hint');
const announceEl = document.getElementById('announce');

const catForm = document.getElementById('cat-form');
const catNameInput = document.getElementById('cat-name');
const catColors = document.getElementById('cat-colors');
const catList = document.getElementById('cat-list');
const catEmpty = document.getElementById('cat-empty');

let tasks = [];
let categories = [];
let filter = 'all';          // 'all' | 'open' | 'done' | 'overdue'
let categoryFilter = 'all';  // 'all' | 'none' | a category id as a string
let sortBy = 'newest';       // 'newest' | 'due' | 'priority' | 'manual'
let editingId = null;
let editingCatId = null;
let pendingDelete = null;    // { id, timer } while the Undo toast is showing
let query = '';              // search text, lower-cased

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const EMPTY_TEXT = {
  all: 'Nothing here yet. Add your first task above.',
  open: 'No open tasks. Everything is done.',
  done: 'No completed tasks yet.',
  overdue: 'No overdue tasks.',
};
const PALETTE = [
  { name: 'Teal',   hex: '#2f7d6b' },
  { name: 'Blue',   hex: '#3b6fb6' },
  { name: 'Orange', hex: '#c0702a' },
  { name: 'Purple', hex: '#8a4fa8' },
  { name: 'Rose',   hex: '#c04a6b' },
  { name: 'Olive',  hex: '#7a7f2a' },
];

/* ---------- helpers ---------- */

async function request(method, body, url = API) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function showError(msg) {
  errorEl.textContent = msg || '';
  errorEl.hidden = !msg;
}

const pad = n => String(n).padStart(2, '0');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

function isOverdue(t) {
  return !t.is_done && t.due_date && t.due_date < todayStr();
}

function dueLabel(t) {
  if (!t.due_date) return null;
  if (isOverdue(t)) return { text: 'Overdue: ' + formatDate(t.due_date), cls: 'overdue' };
  if (!t.is_done && t.due_date === todayStr()) return { text: 'Due today', cls: '' };
  return { text: 'Due ' + formatDate(t.due_date), cls: '' };
}

const categoryById = id => categories.find(c => c.id === id);

function makeDot(color) {
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.setProperty('--c', color);
  return dot;
}

/* ---------- sorting ---------- */

function compare(a, b) {
  if (sortBy === 'manual') return a.sort_order - b.sort_order || a.id - b.id;  // exact saved order
  if (a.is_done !== b.is_done) return a.is_done ? 1 : -1;   // done tasks sink to the bottom
  if (sortBy === 'due') {
    if (a.due_date !== b.due_date) {
      if (!a.due_date) return 1;                            // tasks without a date go last
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.id - a.id;
  }
  if (sortBy === 'priority') {
    const diff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (diff) return diff;
    if (a.due_date !== b.due_date) {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
  }
  return b.id - a.id;                                       // newest first
}

/* ---------- loading ---------- */

async function load() {
  try {
    [tasks, categories] = await Promise.all([
      request('GET'),
      request('GET', null, CAT_API),
    ]);
    showError('');
  } catch (e) { showError(e.message); }
  if (pendingDelete) tasks = tasks.filter(t => t.id !== pendingDelete.id);
  renderCategoryControls();
  render();
}

/* ---------- category controls ---------- */

function setOptions(select, options, selected) {
  select.innerHTML = '';
  options.forEach(([value, label]) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  });
  select.value = options.some(([v]) => v === selected) ? selected : options[0][0];
}

function renderCategoryControls() {
  const catOptions = categories.map(c => [String(c.id), c.name]);

  // If the filtered category was deleted, fall back to all.
  if (categoryFilter !== 'all' && categoryFilter !== 'none' &&
      !catOptions.some(([v]) => v === categoryFilter)) {
    categoryFilter = 'all';
  }

  setOptions(newCatSelect, [['', 'No category'], ...catOptions], newCatSelect.value);
  setOptions(catFilterSelect,
    [['all', 'All categories'], ['none', 'No category'], ...catOptions], categoryFilter);

  renderCategoryChips();
}

function renderCategoryChips() {
  catList.innerHTML = '';
  categories.forEach(c => {
    catList.appendChild(c.id === editingCatId ? renderCategoryEdit(c) : renderCategoryChip(c));
  });
  catEmpty.hidden = categories.length > 0;
}

function renderCategoryChip(c) {
  const li = document.createElement('li');
  li.className = 'cat-chip';

  const name = document.createElement('span');
  name.textContent = c.name;

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'cat-edit-btn';
  edit.textContent = 'Edit';
  edit.setAttribute('aria-label', 'Edit category ' + c.name);
  edit.addEventListener('click', () => { editingCatId = c.id; renderCategoryChips(); });

  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Delete category ' + c.name);
  del.addEventListener('click', () => deleteCategory(c));

  li.append(makeDot(c.color), name, edit, del);
  return li;
}

function renderCategoryEdit(c) {
  const li = document.createElement('li');
  li.className = 'cat-edit';

  const f = document.createElement('form');
  f.className = 'cat-form';

  const name = document.createElement('input');
  name.type = 'text';
  name.value = c.name;
  name.maxLength = 40;
  name.required = true;
  name.setAttribute('aria-label', 'Category name');

  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', 'Category colour');
  makeSwatches(swatches, 'cat-color-edit', c.color);

  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save changes';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'e-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { editingCatId = null; renderCategoryChips(); });

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const color = f.querySelector('input[name="cat-color-edit"]:checked').value;
    try {
      await request('PUT', { id: c.id, name: name.value, color }, CAT_API);
      editingCatId = null;
      showError('');
      load();
    } catch (err) { showError(err.message); }
  });
  f.addEventListener('keydown', e => {
    if (e.key === 'Escape') { editingCatId = null; renderCategoryChips(); }
  });

  f.append(name, swatches, save, cancel);
  li.appendChild(f);
  setTimeout(() => name.focus(), 0);
  return li;
}

async function deleteCategory(c) {
  if (!confirm(`Delete the category "${c.name}"? Its tasks will be kept, just without a category.`)) return;
  try { await request('DELETE', { id: c.id }, CAT_API); load(); }
  catch (e) { showError(e.message); }
}

// Colour swatches (radio buttons), used by the new-category and edit-category forms
function makeSwatches(container, group, selected) {
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const options = PALETTE.some(p => same(p.hex, selected))
    ? PALETTE
    : [...PALETTE, { name: 'Current colour', hex: selected }];
  options.forEach(p => {
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = group;
    r.value = p.hex;
    r.className = 'swatch';
    r.checked = same(p.hex, selected);
    r.setAttribute('aria-label', p.name);
    r.style.setProperty('--c', p.hex);
    container.appendChild(r);
  });
}
makeSwatches(catColors, 'cat-color', PALETTE[0].hex);

/* ---------- rendering ---------- */

function emptyMessage() {
  if (query) return `No tasks match "${searchInput.value.trim()}".`;
  if (categoryFilter !== 'all') return 'No tasks in this category.';
  return EMPTY_TEXT[filter];
}

function matchesStatus(t) {
  if (filter === 'open') return !t.is_done;
  if (filter === 'done') return t.is_done;
  if (filter === 'overdue') return isOverdue(t);
  return true;
}

function getVisible() {
  return tasks
    .filter(matchesStatus)
    .filter(t => categoryFilter === 'all' ||
      (categoryFilter === 'none' ? t.category_id === null : String(t.category_id) === categoryFilter))
    .filter(t => !query || t.title.toLowerCase().includes(query) ||
      (t.notes || '').toLowerCase().includes(query))
    .sort(compare);
}

function render() {
  list.innerHTML = '';
  const visible = getVisible();
  visible.forEach(t => {
    const li = t.id === editingId ? renderEditItem(t) : renderItem(t);
    li.dataset.id = t.id;
    list.appendChild(li);
  });
  hintEl.hidden = sortBy !== 'manual';

  filterBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));

  const open = tasks.filter(t => !t.is_done).length;
  const overdue = tasks.filter(isOverdue).length;
  let summary = tasks.length ? `${open} open, ${tasks.length - open} done` : '';
  if (overdue) summary += `, ${overdue} overdue`;
  countEl.textContent = summary;

  emptyEl.textContent = emptyMessage();
  emptyEl.hidden = visible.length > 0;
  clearBtn.hidden = !tasks.some(t => t.is_done);
  renderStats();
}

/* ---------- stats panel (always covers all tasks, ignoring filters) ---------- */

function renderStats() {
  const today = todayStr();
  const weekStart = daysAgoStr(6);                       // today plus the 6 days before it
  const done = tasks.filter(t => t.is_done);
  const doneDate = t => (t.completed_at ? t.completed_at.slice(0, 10) : null);

  const cards = [
    ['Open', tasks.length - done.length, ''],
    ['Overdue', tasks.filter(isOverdue).length, 'overdue'],
    ['Done today', done.filter(t => doneDate(t) === today).length, ''],
    ['Done in last 7 days', done.filter(t => doneDate(t) && doneDate(t) >= weekStart).length, ''],
  ];
  statGrid.innerHTML = '';
  cards.forEach(([label, value, cls]) => {
    const card = document.createElement('div');
    card.className = 'stat ' + cls;
    const num = document.createElement('strong');
    num.textContent = value;
    const lab = document.createElement('span');
    lab.className = 'label';
    lab.textContent = label;
    card.append(num, lab);
    statGrid.appendChild(card);
  });

  const unknown = done.filter(t => !t.completed_at).length;
  statNote.textContent = unknown
    ? `${unknown} completed ${unknown === 1 ? 'task has' : 'tasks have'} no completion date (finished before dates were tracked), so ${unknown === 1 ? 'it is' : 'they are'} left out of the day counts.`
    : '';

  // Breakdown by category
  statCats.innerHTML = '';
  const groups = [...categories, { id: null, name: 'No category', color: 'var(--muted)' }];
  groups.forEach(g => {
    const mine = tasks.filter(t => t.category_id === g.id);
    if (g.id === null && !mine.length) return;
    const doneCount = mine.filter(t => t.is_done).length;
    const overdue = mine.filter(isOverdue).length;
    const pct = mine.length ? Math.round((doneCount / mine.length) * 100) : 0;

    const li = document.createElement('li');
    li.className = 'stat-row';

    const name = document.createElement('span');
    name.className = 'stat-name';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = g.name;
    name.append(makeDot(g.color), text);

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${pct}% done`);
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.setProperty('--c', g.color);
    fill.style.width = pct + '%';
    bar.appendChild(fill);

    const count = document.createElement('span');
    count.className = 'stat-count';
    count.textContent = mine.length
      ? `${doneCount} of ${mine.length} done` + (overdue ? `, ${overdue} overdue` : '')
      : 'No tasks';

    li.append(name, bar, count);
    statCats.appendChild(li);
  });
  if (!tasks.length) {
    const li = document.createElement('li');
    li.className = 'stat-note';
    li.textContent = 'No tasks yet.';
    statCats.innerHTML = '';
    statCats.appendChild(li);
  }
}

// Shows notes under the title; long notes are cut to 2 lines with a Show more button.
function renderNotes(text) {
  const wrap = document.createElement('div');
  const notes = document.createElement('div');
  notes.className = 'notes';
  notes.textContent = text;           // textContent prevents XSS
  wrap.appendChild(notes);

  if (text.length > 120 || text.includes('\n')) {
    notes.classList.add('clamped');
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = 'Show more';
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      const expanded = notes.classList.toggle('clamped') === false;
      more.textContent = expanded ? 'Show less' : 'Show more';
      more.setAttribute('aria-expanded', String(expanded));
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function renderItem(t) {
  const li = document.createElement('li');
  li.className = `item p-${t.priority}` + (t.is_done ? ' done' : '') + (isOverdue(t) ? ' overdue-row' : '');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = t.is_done;
  cb.setAttribute('aria-label', 'Mark "' + t.title + '" as done');
  cb.addEventListener('change', async () => {
    try { await request('PUT', { id: t.id, is_done: cb.checked }); load(); }
    catch (e) { showError(e.message); }
  });

  const body = document.createElement('div');
  body.className = 'body';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = t.title; // textContent prevents XSS

  const meta = document.createElement('div');
  meta.className = 'meta';

  const prio = document.createElement('span');
  prio.className = 'prio-' + t.priority;
  prio.textContent = PRIORITY_LABEL[t.priority] + ' priority';
  meta.appendChild(prio);

  const due = dueLabel(t);
  if (due) {
    const dueEl = document.createElement('span');
    dueEl.className = due.cls;
    dueEl.textContent = due.text;
    meta.appendChild(dueEl);
  }

  const cat = t.category_id !== null ? categoryById(t.category_id) : null;
  if (cat) {
    const catEl = document.createElement('span');
    catEl.className = 'cat';
    const label = document.createElement('span');
    label.textContent = cat.name;
    catEl.append(makeDot(cat.color), label);
    meta.appendChild(catEl);
  }

  body.append(title);
  if (t.notes) body.append(renderNotes(t.notes));
  body.append(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const edit = document.createElement('button');
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => { editingId = t.id; render(); });

  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteTask(t));

  actions.append(edit, del);
  if (sortBy === 'manual') li.append(makeHandle(t), cb, body, actions);
  else li.append(cb, body, actions);
  return li;
}

function renderEditItem(t) {
  const li = document.createElement('li');
  li.className = `item editing p-${t.priority}`;

  const f = document.createElement('form');
  f.className = 'edit-form';

  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'e-title';
  title.value = t.title;
  title.maxLength = 255;
  title.required = true;
  title.setAttribute('aria-label', 'Task title');

  const notes = document.createElement('textarea');
  notes.className = 'e-notes';
  notes.rows = 3;
  notes.maxLength = 2000;
  notes.value = t.notes || '';
  notes.placeholder = 'Notes (optional)';
  notes.setAttribute('aria-label', 'Notes');

  const due = document.createElement('input');
  due.type = 'date';
  due.value = t.due_date || '';
  due.setAttribute('aria-label', 'Due date');

  const prio = document.createElement('select');
  prio.setAttribute('aria-label', 'Priority');
  ['low', 'medium', 'high'].forEach(p => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = PRIORITY_LABEL[p];
    o.selected = p === t.priority;
    prio.appendChild(o);
  });

  const cat = document.createElement('select');
  cat.setAttribute('aria-label', 'Category');
  setOptions(cat,
    [['', 'No category'], ...categories.map(c => [String(c.id), c.name])],
    t.category_id === null ? '' : String(t.category_id));

  const buttons = document.createElement('div');
  buttons.className = 'e-buttons';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save changes';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'e-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { editingId = null; render(); });
  buttons.append(save, cancel);

  f.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await request('PUT', {
        id: t.id,
        title: title.value,
        notes: notes.value,
        due_date: due.value || null,
        priority: prio.value,
        category_id: cat.value === '' ? null : Number(cat.value),
      });
      editingId = null;
      showError('');
      load();
    } catch (err) { showError(err.message); }
  });
  f.addEventListener('keydown', e => {
    if (e.key === 'Escape') { editingId = null; render(); }
  });

  f.append(title, notes, due, prio, cat, buttons);
  li.appendChild(f);
  setTimeout(() => title.focus(), 0);
  return li;
}

/* ---------- reordering ("My order") ---------- */

function announce(msg) { announceEl.textContent = msg; }

function makeHandle(t) {
  const h = document.createElement('button');
  h.type = 'button';
  h.className = 'handle';
  h.textContent = '⋮⋮';
  h.setAttribute('aria-label', `Reorder "${t.title}". Drag, or use the up and down arrow keys.`);
  h.addEventListener('pointerdown', e => startDrag(e, h));
  h.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveBy(t.id, e.key === 'ArrowUp' ? -1 : 1);
    }
  });
  return h;
}

// visibleIds = the visible tasks in their new order. Hidden tasks (other filter,
// category or search) keep their slots, and the visible ones fill the visible slots.
async function commitOrder(visibleIds) {
  const slots = new Set(visibleIds);
  const ordered = tasks.slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  let k = 0;
  const merged = ordered.map(t => (slots.has(t.id) ? visibleIds[k++] : t.id));

  const byId = new Map(tasks.map(t => [t.id, t]));
  merged.forEach((id, i) => { byId.get(id).sort_order = i + 1; });
  render();                                   // update the screen right away

  try { await request('PUT', { order: merged }); }
  catch (e) { showError(e.message); load(); } // save failed: reload the real order
}

function moveBy(id, delta) {
  const ids = getVisible().map(t => t.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  commitOrder(ids);                           // re-renders before its first await
  const handle = list.querySelector(`li[data-id="${id}"] .handle`);
  if (handle) handle.focus();
  announce(`Moved to position ${to + 1} of ${ids.length}.`);
}

function startDrag(e, handle) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();

  const li = handle.closest('li');
  const grabOffset = e.clientY - li.getBoundingClientRect().top;
  const startIds = getVisible().map(t => t.id).join(',');

  handle.setPointerCapture(e.pointerId);
  li.classList.add('dragging');
  list.classList.add('is-dragging');

  const onMove = ev => {
    li.style.transform = 'none';
    // Where would the dragged row's centre sit, if it followed the pointer?
    const centre = ev.clientY - grabOffset + li.offsetHeight / 2;
    let before = null;
    for (const row of list.children) {
      if (row === li) continue;
      const r = row.getBoundingClientRect();
      if (centre < r.top + r.height / 2) { before = row; break; }
    }
    if (before !== li.nextElementSibling) list.insertBefore(li, before);

    const natural = li.getBoundingClientRect().top;
    li.style.transform = `translateY(${ev.clientY - grabOffset - natural}px)`;

    if (ev.clientY < 70) window.scrollBy(0, -12);
    else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 12);
  };

  const finish = save => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    li.classList.remove('dragging');
    li.style.transform = '';
    list.classList.remove('is-dragging');

    const ids = [...list.children].map(row => Number(row.dataset.id));
    if (save && ids.join(',') !== startIds) {
      commitOrder(ids);
      announce('Task moved.');
    } else {
      render();                               // nothing changed (or cancelled): redraw as saved
    }
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
}

/* ---------- events ---------- */

filterBtns.forEach(b => b.addEventListener('click', () => {
  filter = b.dataset.filter;
  render();
}));

catFilterSelect.addEventListener('change', () => {
  categoryFilter = catFilterSelect.value;
  render();
});

searchInput.addEventListener('input', () => {
  query = searchInput.value.trim().toLowerCase();
  render();
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    query = '';
    render();
  }
});

sortSelect.addEventListener('change', () => {
  sortBy = sortSelect.value;
  render();
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  try {
    await request('POST', {
      title,
      notes: notesInput.value,
      due_date: dueInput.value || null,
      priority: prioInput.value,
      category_id: newCatSelect.value === '' ? null : Number(newCatSelect.value),
    });
    input.value = '';
    notesInput.value = '';
    dueInput.value = '';
    prioInput.value = 'medium';   // category stays, handy when adding several tasks in a row
    showError('');
    load();
  } catch (err) { showError(err.message); }
});

catForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = catNameInput.value.trim();
  if (!name) return;
  const color = catForm.querySelector('input[name="cat-color"]:checked').value;
  try {
    await request('POST', { name, color }, CAT_API);
    catNameInput.value = '';
    showError('');
    load();
  } catch (err) { showError(err.message); }
});

clearBtn.addEventListener('click', async () => {
  try { await request('DELETE', { clear_done: true }); load(); }
  catch (e) { showError(e.message); }
});

/* ---------- undo delete ---------- */
// The task disappears at once, but the DELETE is only sent after 7 seconds
// (or when you delete another task, or leave the page). Undo cancels it.

function showToast(msg) {
  toastMsg.textContent = msg;
  toastEl.hidden = false;
}

function hideToast() {
  toastEl.hidden = true;
}

function deleteTask(t) {
  if (pendingDelete) commitPendingDelete();   // the earlier deletion becomes final
  tasks = tasks.filter(x => x.id !== t.id);
  if (editingId === t.id) editingId = null;
  pendingDelete = { id: t.id, timer: setTimeout(commitPendingDelete, 7000) };
  render();
  showToast(`Deleted "${t.title}".`);
}

async function commitPendingDelete() {
  if (!pendingDelete) return;
  const { id, timer } = pendingDelete;
  clearTimeout(timer);
  pendingDelete = null;
  hideToast();
  try { await request('DELETE', { id }); }
  catch (e) { showError(e.message); load(); }
}

function undoDelete() {
  if (!pendingDelete) return;
  clearTimeout(pendingDelete.timer);
  pendingDelete = null;
  hideToast();
  load();                                     // the task is still in MySQL, so just reload
}

toastUndo.addEventListener('click', undoDelete);

// Ctrl+Z / Cmd+Z undoes too, unless you are typing in a field
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || !pendingDelete) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  e.preventDefault();
  undoDelete();
});

// If the page is closed or reloaded during the 7 seconds, still finish the deletion.
window.addEventListener('pagehide', () => {
  if (!pendingDelete) return;
  fetch(API, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: pendingDelete.id }),
    keepalive: true,
  });
});

/* ---------- restore from a backup file ---------- */

function setRestoreMsg(text, isError) {
  restoreMsg.textContent = text;
  restoreMsg.classList.toggle('error', !!isError);
}

restoreForm.addEventListener('submit', async e => {
  e.preventDefault();
  const file = restoreFile.files[0];
  if (!file) return;
  const mode = restoreForm.querySelector('input[name="restore-mode"]:checked').value;

  let backup;
  try { backup = JSON.parse(await file.text()); }
  catch (err) { setRestoreMsg('That file is not valid JSON. Choose a backup made by this app.', true); return; }

  if (mode === 'replace' &&
      !confirm('Replace ALL current tasks and categories with the contents of this file? This cannot be undone. Download a backup first if you are not sure.')) {
    return;
  }

  restoreBtn.disabled = true;
  setRestoreMsg('Restoring...', false);
  try {
    if (pendingDelete) await commitPendingDelete();   // finish any delete still waiting for Undo
    const r = await request('POST', { mode, backup }, BACKUP_API);
    const cats = r.categories_added
      ? ` and ${r.categories_added} new ${r.categories_added === 1 ? 'category' : 'categories'}`
      : '';
    setRestoreMsg(`Restored ${r.tasks} ${r.tasks === 1 ? 'task' : 'tasks'}${cats}.`, false);
    restoreForm.reset();
    editingId = null;
    editingCatId = null;
    load();
  } catch (err) {
    setRestoreMsg(err.message, true);
  } finally {
    restoreBtn.disabled = false;
  }
});

/* ---------- theme ---------- */

const themeBtn = document.getElementById('theme-toggle');

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function updateThemeButton() {
  themeBtn.textContent = currentTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (e) { /* storage unavailable */ }
  updateThemeButton();
});

updateThemeButton();
load();
