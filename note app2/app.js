// Notes App — Tailwind + Vanilla JS + File System Access API
// Works best in Chrome/Edge over HTTPS or localhost.

const supportsFS = 'showDirectoryPicker' in window;

const els = {
  sidebar: document.getElementById('sidebar'),
  backdrop: document.getElementById('backdrop'),
  toggleSidebar: document.getElementById('toggleSidebar'),

  wsStatus: document.getElementById('wsStatus'),
  btnPickFolder: document.getElementById('btnPickFolder'),
  btnNewNote: document.getElementById('btnNewNote'),
  btnDeleteSelected: document.getElementById('btnDeleteSelected'),
  selectAll: document.getElementById('selectAll'),
  search: document.getElementById('search'),
  noteList: document.getElementById('noteList'),

  btnSave: document.getElementById('btnSave'),
  btnSaveAs: document.getElementById('btnSaveAs'),
  btnDelete: document.getElementById('btnDelete'),

  titleInput: document.getElementById('titleInput'),
  contentInput: document.getElementById('contentInput'),
  saveStatus: document.getElementById('saveStatus'),
  metaInfo: document.getElementById('metaInfo'),
  emptyState: document.getElementById('emptyState'),
};

const state = {
  workspace: null,          // FileSystemDirectoryHandle | null
  notes: new Map(),         // id -> note
  currentId: null,          // selected note id
  selection: new Set(),     // bulk selection ids
  debouncers: new Map(),    // id -> timeout
};

const LOCAL_KEY = 'notes:local-db:v1';


function uuid() {
  return 'xxxxxxxx'.replace(/[x]/g, () =>
    (Math.random() * 16 | 0).toString(16)
  ) + Date.now().toString(16);
}

function slug(s) {
  return (s || 'note').toLowerCase().replace(/[/\\?%*:|"<>]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'note';
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function setStatus(text, color = 'text-slate-500') {
  els.saveStatus.className = `text-xs ${color}`;
  els.saveStatus.textContent = text;
}

function setMeta(note) {
  if (!note) {
    els.metaInfo.textContent = '—';
    return;
  }
  els.metaInfo.textContent = `Created ${fmtDate(note.createdAt)} • Updated ${timeAgo(note.updatedAt)}${note.fileName ? ` • ${note.fileName}` : ''}`;
}

function showEmptyState(show) {
  els.emptyState.classList.toggle('hidden', !show);
}


els.toggleSidebar?.addEventListener('click', () => {
  els.sidebar.classList.remove('-translate-x-full');
  els.backdrop.classList.remove('hidden');
});
els.backdrop?.addEventListener('click', hideSidebar);
function hideSidebar() {
  els.sidebar.classList.add('-translate-x-full');
  els.backdrop.classList.add('hidden');
}


async function ensureDirWrite(dirHandle) {
  if (!dirHandle?.requestPermission) return false;
  const opts = { mode: 'readwrite' };
  let p = await dirHandle.queryPermission(opts);
  if (p === 'granted') return true;
  p = await dirHandle.requestPermission(opts);
  return p === 'granted';
}

async function writeFile(fileHandle, content) {
  const w = await fileHandle.createWritable();
  await w.write(content);
  await w.close();
}

async function deleteEntry(dirHandle, name) {
  if (!dirHandle?.removeEntry) return false;
  await dirHandle.removeEntry(name, { recursive: false });
  return true;
}


function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveLocal() {
  const arr = [...state.notes.values()].map(n => {
    const { fileHandle, ...safe } = n;
    return safe;
  });
  localStorage.setItem(LOCAL_KEY, JSON.stringify(arr));
}


function renderList(filter = '') {
  const q = filter.trim().toLowerCase();
  els.noteList.innerHTML = '';

  const items = [...state.notes.values()]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .filter(n => (n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q));

  if (!items.length) {
    els.noteList.innerHTML = `
      <div class="p-6 text-sm text-slate-500">No notes yet.</div>
    `;
    return;
  }

  for (const n of items) {
    const li = document.createElement('button');
    li.className = `
      w-full text-left px-3 py-2 border-b border-slate-100 hover:bg-slate-50 flex items-start gap-2
      ${n.id === state.currentId ? 'bg-brand-50' : ''}
    `;
    li.dataset.id = n.id;

    li.innerHTML = `
      <input type="checkbox" class="mt-1 h-4 w-4 shrink-0 selectBox" ${state.selection.has(n.id) ? 'checked' : ''} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <div class="truncate font-medium">${n.title || 'Untitled'}</div>
          ${n._dirty ? '<span class="text-[10px] text-amber-600">• unsaved</span>' : ''}
        </div>
        <div class="text-xs text-slate-500 truncate">${timeAgo(n.updatedAt)}${n.fileName ? ` • ${n.fileName}` : ''}</div>
      </div>
    `;

    const checkbox = li.querySelector('.selectBox');
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checkbox.checked) state.selection.add(n.id);
      else state.selection.delete(n.id);
      updateBulkControls();
    });

    li.addEventListener('click', () => {
      selectNote(n.id);
      if (window.innerWidth < 1024) hideSidebar();
    });

    els.noteList.appendChild(li);
  }
}

function updateBulkControls() {
  els.btnDeleteSelected.disabled = state.selection.size === 0;
  els.selectAll.checked = state.selection.size && state.selection.size === state.notes.size;
}

function selectNote(id) {
  if (!id || !state.notes.has(id)) {
    state.currentId = null;
    els.titleInput.value = '';
    els.contentInput.value = '';
    setStatus('No note selected');
    setMeta(null);
    showEmptyState(true);
    renderList(els.search.value);
    return;
  }
  state.currentId = id;
  const n = state.notes.get(id);
  els.titleInput.value = n.title || '';
  els.contentInput.value = n.content || '';
  setStatus(n._dirty ? 'Unsaved changes' : (n.fileName ? 'Saved to disk' : 'Local (not saved to folder)'), n._dirty ? 'text-amber-600' : 'text-slate-500');
  setMeta(n);
  showEmptyState(false);
  renderList(els.search.value);
}


function newNote() {
  const id = uuid();
  const now = new Date().toISOString();
  const note = {
    id, title: 'Untitled', content: '',
    createdAt: now, updatedAt: now,
    fileName: null, fileHandle: null,
    _dirty: true
  };
  state.notes.set(id, note);
  saveLocal();
  selectNote(id);
}

function setDirty(id, dirty) {
  const n = state.notes.get(id);
  if (!n) return;
  n._dirty = dirty;
  renderList(els.search.value);
}

function scheduleSave(id, immediate = false) {
  const n = state.notes.get(id);
  if (!n) return;
  setDirty(id, true);
  setStatus('Saving…', 'text-slate-500');

  if (state.debouncers.has(id)) {
    clearTimeout(state.debouncers.get(id));
  }
  if (immediate) return doSave(id);

  const t = setTimeout(() => doSave(id), 600);
  state.debouncers.set(id, t);
}

async function doSave(id) {
  const n = state.notes.get(id);
  if (!n) return;

  n.updatedAt = new Date().toISOString();

  saveLocal();

  if (state.workspace && supportsFS) {
    try {
      const ok = await ensureDirWrite(state.workspace);
      if (!ok) throw new Error('Permission denied');
      t
      if (!n.fileName) {
        n.fileName = `${slug(n.title || 'note')}-${n.id}.json`;
      }
     
      if (!n.fileHandle) {
        n.fileHandle = await state.workspace.getFileHandle(n.fileName, { create: true });
      }
   
      const payload = JSON.stringify({
        id: n.id,
        title: n.title,
        content: n.content,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt
      }, null, 2);
      await writeFile(n.fileHandle, payload);
      setStatus('Saved to disk', 'text-emerald-600');
      setDirty(id, false);
      setMeta(n);
      return;
    } catch (e) {
      console.error(e);
      setStatus('Save failed (check permissions)', 'text-red-600');
    }
  } else {
    setStatus('Saved locally (no folder)', 'text-slate-500');
    setDirty(id, false);
    setMeta(n);
  }
}


async function pickWorkspace() {
  if (!supportsFS) {
    alert('File System Access API not supported in this browser. Use Chrome/Edge over HTTPS or localhost.');
    return;
  }
  try {
    const dir = await showDirectoryPicker();
    const ok = await ensureDirWrite(dir);
    if (!ok) return;

    state.workspace = dir;
    els.wsStatus.textContent = 'Folder selected';
    await loadWorkspaceNotes();
  } catch {
   
  }
}

async function loadWorkspaceNotes() {
  state.notes.clear();
  state.selection.clear();
  state.currentId = null;

  try {
    for await (const [name, handle] of state.workspace.entries()) {
      if (!name.endsWith('.json')) continue;
      if (handle.kind !== 'file') continue;
      const file = await handle.getFile();
      const text = await file.text();
      let data = null;
      try { data = JSON.parse(text); } catch { continue; }
      const id = data?.id || uuid();
      const note = {
        id,
        title: data?.title || 'Untitled',
        content: data?.content || '',
        createdAt: data?.createdAt || new Date().toISOString(),
        updatedAt: data?.updatedAt || new Date().toISOString(),
        fileName: name,
        fileHandle: handle,
        _dirty: false
      };
      state.notes.set(id, note);
    }
  } catch (e) {
    console.error('Failed reading directory', e);
  }

  renderList(els.search.value);
  updateBulkControls();

  const latest = [...state.notes.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  if (latest) selectNote(latest.id);
  else {
    selectNote(null);
    showEmptyState(true);
  }
}


async function deleteNote(id) {
  const n = state.notes.get(id);
  if (!n) return;
  
  if (state.workspace && n.fileName) {
    try { await deleteEntry(state.workspace, n.fileName); } catch {}
  }
  state.notes.delete(id);
  state.selection.delete(id);
  saveLocal();
  if (state.currentId === id) {
    const next = [...state.notes.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    selectNote(next?.id || null);
  } else {
    renderList(els.search.value);
    updateBulkControls();
  }
}

async function deleteSelected() {
  if (!state.selection.size) return;
  const ok = confirm(`Delete ${state.selection.size} selected note(s)? This cannot be undone.`);
  if (!ok) return;
  const ids = [...state.selection];
  for (const id of ids) {
  
    await deleteNote(id);
  }
  state.selection.clear();
  updateBulkControls();
}


async function saveAsCurrent() {
  const n = state.notes.get(state.currentId);
  if (!n) return;
  try {
    const handle = await showSaveFilePicker({
      suggestedName: `${slug(n.title || 'note')}-${n.id}.json`,
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
    });
    const payload = JSON.stringify({
      id: n.id,
      title: n.title,
      content: n.content,
      createdAt: n.createdAt,
      updatedAt: new Date().toISOString()
    }, null, 2);
    await writeFile(handle, payload);
    setStatus('Saved (Save As)', 'text-emerald-600');
  } catch {
  
  }
}


els.btnPickFolder.addEventListener('click', pickWorkspace);

els.btnNewNote.addEventListener('click', () => {
  newNote();
  renderList(els.search.value);
});

els.search.addEventListener('input', () => renderList(els.search.value));

els.selectAll.addEventListener('change', (e) => {
  if (e.target.checked) {
    state.selection = new Set([...state.notes.keys()]);
  } else {
    state.selection.clear();
  }
  renderList(els.search.value);
  updateBulkControls();
});

els.btnDeleteSelected.addEventListener('click', deleteSelected);

els.btnSave.addEventListener('click', () => {
  if (!state.currentId) return;
  scheduleSave(state.currentId, true);
});

els.btnSaveAs.addEventListener('click', saveAsCurrent);

els.btnDelete.addEventListener('click', async () => {
  if (!state.currentId) return;
  const n = state.notes.get(state.currentId);
  const ok = confirm(`Delete "${n.title || 'Untitled'}"?`);
  if (!ok) return;
  await deleteNote(state.currentId);
});

els.titleInput.addEventListener('input', () => {
  if (!state.currentId) return;
  const n = state.notes.get(state.currentId);
  n.title = els.titleInput.value;
  n.updatedAt = new Date().toISOString();
  renderList(els.search.value);
  setMeta(n);
  scheduleSave(state.currentId);
});

els.contentInput.addEventListener('input', () => {
  if (!state.currentId) return;
  const n = state.notes.get(state.currentId);
  n.content = els.contentInput.value;
  n.updatedAt = new Date().toISOString();
  setMeta(n);
  scheduleSave(state.currentId);
});

(function init() {
  const local = loadLocal();
  if (local.length) {
    for (const n of local) {
      state.notes.set(n.id, { ...n, fileHandle: null, _dirty: false });
    }
    renderList('');
    selectNote(local[0]?.id || null);
  } else {
    showEmptyState(true);
  }
})();