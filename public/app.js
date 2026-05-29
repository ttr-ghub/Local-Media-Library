/* ===================================================
   FF14SS フロントエンド
   =================================================== */

'use strict';

// ===== 定数 =====
const API          = '/api';
const THUMB_SIZES  = [160, 220, 300, 380]; // CSS px
const PAGE_SIZE    = 150;
const DEBOUNCE_MS  = 300;

// ===== フィルター定数 =====
const FILTER_PRESETS = {
  'none': { label: 'なし', filter: '' },
  
  // 補正系
  'natural_bright': { label: '明るく自然（暗所救済）', filter: 'brightness(1.25) contrast(1.03) saturate(1.04)' },
  'dark_fix': { label: '暗部補正（影を持ち上げ）', filter: 'brightness(1.2) contrast(0.88) saturate(1.04)' },
  'vivid': { label: '鮮やか（色強め）', filter: 'brightness(1.03) contrast(1.08) saturate(1.4)' },
  'clear': { label: '透明感（明るくクリア）', filter: 'brightness(1.16) contrast(1.08) saturate(1.16) hue-rotate(350deg)' },
  'soft': { label: '柔らか（淡くふんわり）', filter: 'brightness(1.16) contrast(0.82) saturate(0.92)' },
  
  // 雰囲気系
  'cinema': { label: 'シネマ（暗め高コントラスト）', filter: 'brightness(0.94) contrast(1.32) saturate(0.72)' },
  'warm': { label: '暖色（夕焼け・室内）', filter: 'brightness(1.08) contrast(1.06) saturate(1.18) sepia(0.24) hue-rotate(350deg)' },
  'cool': { label: '寒色（雪原・夜）', filter: 'brightness(1.04) contrast(1.1) saturate(1.12) hue-rotate(200deg)' },
  'night': { label: '夜景補正（暗い夜向け）', filter: 'brightness(1.28) contrast(1.08) saturate(1.18)' },
  'battle': { label: '戦闘くっきり（派手め）', filter: 'brightness(1.06) contrast(1.26) saturate(1.24)' },
  
  // 特殊系
  'mono': { label: 'モノクロ', filter: 'grayscale(1) contrast(1.18)' },
  'sepia': { label: 'セピア', filter: 'sepia(0.78) contrast(1.05) brightness(1.04) saturate(0.9)' },
  'retro': { label: 'レトロ', filter: 'sepia(0.38) saturate(0.68) contrast(0.88) brightness(1.08)' },
  'pale': { label: '淡色', filter: 'brightness(1.18) contrast(0.86) saturate(0.62)' },
  'high_sat': { label: '高彩度（かなり色強め）', filter: 'brightness(1.04) contrast(1.1) saturate(1.7)' },

  // 検証用
  'test_strong': { label: '強めテスト（確認用）', filter: 'brightness(1.3) contrast(1.3) saturate(1.6)' }
};

function applyPreviewFilter() {
  const presetKey = $('filter-preset')?.value || 'none';
  const strength = parseInt($('filter-strength')?.value || '100', 10);
  const previewImg = $('preview-image');
  if (!previewImg) return;
  
  if (presetKey === 'none') {
    previewImg.style.filter = '';
    return;
  }
  
  const preset = FILTER_PRESETS[presetKey].filter;
  const ratio = strength / 100;
  
  const blended = preset.replace(/([a-z-]+)\(([^)]+)\)/g, (match, fn, val) => {
    let num = parseFloat(val);
    let unit = val.replace(/[0-9.-]/g, '');
    let base = 1;
    if (fn === 'grayscale' || fn === 'sepia') base = 0;
    if (fn === 'hue-rotate') base = 0;
    
    let newVal = base + (num - base) * ratio;
    return `${fn}(${newVal}${unit})`;
  });
  
  previewImg.style.filter = blended;
}

// ===== 状態 =====
const state = {
  view:            'all',
  selectedDate:    null,
  selectedCategory: null,
  selectedTag:     null,
  selectedSource:  'all', // 追加：現在選択中のメディアソースID
  sources:         [],    // 追加：登録済みメディアソース一覧
  search:          '',
  sort:            'taken_at',
  order:           'DESC',
  page:            1,
  total:           0,
  selectedId:      null,
  thumbSizeIdx:    parseInt(localStorage.getItem('localmedia.thumbnailSize') ?? '1'),
  categories:      [],
  tags:            [],
  scanJobId:       null,
  backupJobId:     null,
  previewDetail:   null,
  memoSaveTimer:   null,

  // 選択モード
  selectMode:      false,
  selectedIds:     new Set(),

  // 現在ページのアイテム（全選択用）
  currentPageItems: [],
};

// ===== DOM参照 =====
const $  = id => document.getElementById(id);
const $$ = (sel, root = document) => root.querySelectorAll(sel);

// ===== API ユーティリティ =====
async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ===== トースト =====
function showToast(msg, type = 'ok', durationMs = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// ===== モーダル =====
function openModal(title, placeholder) {
  return new Promise(resolve => {
    $('modal-title').textContent = title;
    $('modal-input').placeholder = placeholder;
    $('modal-input').value = '';
    $('modal').classList.remove('hidden');
    $('modal-input').focus();

    const ok = () => {
      const val = $('modal-input').value.trim();
      cleanup();
      resolve(val || null);
    };
    const cancel = () => { cleanup(); resolve(null); };
    const onKey = e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') cancel(); };

    $('modal-ok').addEventListener('click', ok);
    $('modal-cancel').addEventListener('click', cancel);
    $('modal').querySelector('.modal__backdrop').addEventListener('click', cancel);
    document.addEventListener('keydown', onKey);

    function cleanup() {
      $('modal').classList.add('hidden');
      $('modal-ok').removeEventListener('click', ok);
      $('modal-cancel').removeEventListener('click', cancel);
      document.removeEventListener('keydown', onKey);
    }
  });
}

// ===== カテゴリ/タグ 編集モーダル =====
function openEditModal(type, item) {
  const label = type === 'category' ? 'カテゴリ' : 'タグ';
  const el    = $('edit-modal');

  el.querySelector('.edit-modal__title').textContent = `${label}を編集`;
  const nameInput = el.querySelector('.edit-modal__name');
  nameInput.value = item.name;

  const picker = el.querySelector('.edit-modal__colors');
  const currentColor = item.color ?? (type === 'category' ? '#7aa2f7' : '#9ece6a');
  picker.innerHTML = colorPickerHtml(currentColor);
  let selectedColor = currentColor;

  // 色選択イベント（毎回 clone して多重バインド防止）
  const newPicker = picker.cloneNode(true);
  picker.parentNode.replaceChild(newPicker, picker);
  newPicker.innerHTML = colorPickerHtml(currentColor);
  newPicker.addEventListener('click', e => {
    const sw = e.target.closest('.color-swatch');
    if (!sw) return;
    selectedColor = sw.dataset.color;
    newPicker.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('active', s.dataset.color === selectedColor));
  });

  el.classList.remove('hidden');
  nameInput.focus();

  const saveBtn   = el.querySelector('.edit-modal__save');
  const cancelBtn = el.querySelector('.edit-modal__cancel');
  const backdrop  = el.querySelector('.modal__backdrop');

  const cleanup = () => {
    el.classList.add('hidden');
    saveBtn.removeEventListener('click', onSave);
    cancelBtn.removeEventListener('click', onCancel);
    backdrop.removeEventListener('click', onCancel);
    document.removeEventListener('keydown', onKey);
  };

  const onSave = async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('名前を入力してください', 'error'); return; }
    if (name.length > 50) { showToast('名前は50文字以内にしてください', 'error'); return; }
    try {
      const endpoint = type === 'category' ? `/categories/${item.id}` : `/tags/${item.id}`;
      await apiFetch(endpoint, { method: 'PATCH', body: { name, color: selectedColor } });
      showToast(`${label}を更新しました`);
      cleanup();
      await loadSidebarData();
      if ((type === 'category' && state.selectedCategory == item.id) ||
          (type === 'tag'      && state.selectedTag      == item.id)) {
        loadGallery();
      }
      if (state.previewDetail) renderPreviewMeta(state.previewDetail);
    } catch (err) {
      showToast(`更新失敗: ${err.message}`, 'error');
    }
  };

  const onCancel = () => cleanup();
  const onKey    = e => { if (e.key === 'Escape') cleanup(); };

  saveBtn.addEventListener('click', onSave);
  cancelBtn.addEventListener('click', onCancel);
  backdrop.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey);
}

// ===== カテゴリ/タグ 削除 =====
async function deleteItem(type, item) {
  const label    = type === 'category' ? 'カテゴリ' : 'タグ';
  const usageEp  = type === 'category' ? `/categories/${item.id}/usage` : `/tags/${item.id}/usage`;

  let usage;
  try {
    usage = await apiFetch(usageEp);
  } catch (err) {
    showToast(`件数取得失敗: ${err.message}`, 'error');
    return;
  }

  const msg = `${label}『${usage.name}』を削除します。\nこの${label}は ${usage.count} 枚の画像に付与されています。\n削除すると、この${label}の紐付けも解除されます。\n画像ファイル本体は削除されません。\n\n本当に削除しますか？`;
  if (!window.confirm(msg)) return;

  try {
    const delEp = type === 'category' ? `/categories/${item.id}` : `/tags/${item.id}`;
    await apiFetch(delEp, { method: 'DELETE' });
    showToast(`${label}『${item.name}』を削除しました`);

    if (type === 'category' && state.selectedCategory == item.id) {
      setView('all');
    } else if (type === 'tag' && state.selectedTag == item.id) {
      setView('all');
    } else {
      loadGallery();
    }

    await loadSidebarData();
    if (state.previewDetail) renderPreviewMeta(state.previewDetail);
  } catch (err) {
    showToast(`削除失敗: ${err.message}`, 'error');
  }
}

// ===== サムネイルサイズ =====
function applyThumbSize() {
  const size = THUMB_SIZES[state.thumbSizeIdx];
  document.documentElement.style.setProperty('--thumb-size', `${size}px`);
  $$('.thumb-size-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.size) === state.thumbSizeIdx);
  });
}

// ===== リサイザー =====
function initResizers() {
  const sidebar      = $('sidebar');
  const previewPanel = $('preview-panel');
  const rLeft        = $('resizer-left');
  const rRight       = $('resizer-right');

  // 保存済み幅を復元
  const savedLeft  = parseInt(localStorage.getItem('localmedia.leftWidth')   ?? '260');
  const savedRight = parseInt(localStorage.getItem('localmedia.previewWidth') ?? '720');
  sidebar.style.width      = `${clamp(savedLeft,  200, 420)}px`;
  previewPanel.style.width = `${clamp(savedRight, 360, 1400)}px`;

  let dragging = null;
  let startX   = 0;
  let startW   = 0;

  rLeft.addEventListener('mousedown', e => {
    dragging = 'left'; startX = e.clientX; startW = sidebar.offsetWidth;
    rLeft.classList.add('dragging'); e.preventDefault();
  });
  rRight.addEventListener('mousedown', e => {
    dragging = 'right'; startX = e.clientX; startW = previewPanel.offsetWidth;
    rRight.classList.add('dragging'); e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (dragging === 'left') {
      const w = clamp(startW + dx, 200, 420);
      sidebar.style.width = `${w}px`;
      localStorage.setItem('localmedia.leftWidth', w);
    } else {
      const w = clamp(startW - dx, 360, 1400);
      previewPanel.style.width = `${w}px`;
      localStorage.setItem('localmedia.previewWidth', w);
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    rLeft.classList.remove('dragging');
    rRight.classList.remove('dragging');
    dragging = null;
  });
}

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

// ===== 選択モード管理 =====
function enterSelectMode() {
  state.selectMode = true;
  state.selectedIds.clear();

  $('btn-select-mode').classList.add('hidden');
  $('btn-select-all-page').classList.remove('hidden');
  $('btn-deselect-all').classList.remove('hidden');
  $('btn-exit-select-mode').classList.remove('hidden');
  $('bulk-bar').classList.remove('hidden');

  // プレビューを閉じる
  $('preview-panel').classList.add('hidden');
  $('resizer-right').classList.add('hidden');
  if (state.selectedId) {
    const prev = document.querySelector(`.thumb-card[data-id="${state.selectedId}"]`);
    if (prev) prev.classList.remove('selected');
    state.selectedId = null;
  }

  // カードを選択モードUIに更新
  $$('.thumb-card').forEach(card => {
    card.classList.add('select-mode');
    const cb = card.querySelector('.thumb-card__checkbox');
    if (cb) {
      cb.disabled = false;
      cb.tabIndex = 0;
    }
  });
  updateBulkBar();
}

function exitSelectMode() {
  state.selectMode = false;
  state.selectedIds.clear();

  $('btn-select-mode').classList.remove('hidden');
  $('btn-select-all-page').classList.add('hidden');
  $('btn-deselect-all').classList.add('hidden');
  $('btn-exit-select-mode').classList.add('hidden');
  $('bulk-bar').classList.add('hidden');

  $$('.thumb-card').forEach(card => {
    card.classList.remove('select-mode', 'multi-selected');
    const cb = card.querySelector('.thumb-card__checkbox');
    if (cb) {
      cb.checked = false;
      cb.disabled = true;
      cb.tabIndex = -1;
    }
  });
  updateBulkBar();
}

function clearSelectionState() {
  state.selectedIds.clear();
  $$('.thumb-card').forEach(card => {
    card.classList.remove('multi-selected');
    const cb = card.querySelector('.thumb-card__checkbox');
    if (cb) cb.checked = false;
  });
  updateBulkBar();
}

function toggleSelectCard(id, card) {
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
    card.classList.remove('multi-selected');
    const cb = card.querySelector('.thumb-card__checkbox');
    if (cb) cb.checked = false;
  } else {
    state.selectedIds.add(id);
    card.classList.add('multi-selected');
    const cb = card.querySelector('.thumb-card__checkbox');
    if (cb) cb.checked = true;
  }
  updateBulkBar();
}

function updateBulkBar() {
  const count = state.selectedIds.size;
  $('bulk-count').textContent = `${count}枚選択中`;

  const hasSelection = count > 0;
  $('btn-bulk-category').disabled = !hasSelection;
  $('btn-bulk-tag').disabled      = !hasSelection;
  $('btn-bulk-fav-on').disabled   = !hasSelection;
  $('btn-bulk-fav-off').disabled  = !hasSelection;
}

function syncBulkSelects() {
  // カテゴリ選択肢を同期
  const catSel = $('bulk-category-select');
  const catVal = catSel.value;
  catSel.innerHTML = '<option value="">カテゴリを選択</option>';
  state.categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    catSel.appendChild(opt);
  });
  catSel.value = catVal;

  // タグ選択肢を同期
  const tagSel = $('bulk-tag-select');
  const tagVal = tagSel.value;
  tagSel.innerHTML = '<option value="">タグを選択</option>';
  state.tags.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    tagSel.appendChild(opt);
  });
  tagSel.value = tagVal;
}

// ===== 左メニューの描画 =====
async function loadSidebarData() {
  const params = new URLSearchParams();
  if (state.selectedSource && state.selectedSource !== 'all') {
    params.set('source_id', state.selectedSource);
  }

  const [status, categories, tags, sources] = await Promise.all([
    apiFetch(`/status?${params}`),
    apiFetch('/categories'),
    apiFetch('/tags'),
    apiFetch('/sources'),
  ]);

  $('count-all').textContent      = status.total;
  $('count-favorite').textContent = status.favorites;

  state.categories = categories;
  state.tags       = tags;
  state.sources    = sources;

  renderCategoryList();
  renderTagList();
  syncBulkSelects();
  renderSourceFilterSelect(); // メディアソース選択ドロップダウンの描画
  await loadDateList();
}

const formatSelectLabel = (name, type) => {
  let cleanName = name.trim();
  cleanName = cleanName
    .replace(/[\(\)\[\]（）]/g, '')
    .replace(/(screenshot|screenshots|Screenshot|Screenshots|📸|🎬|の画像|の動画)/gi, '')
    .trim();
  
  if (type === 'screenshot') {
    if (cleanName.endsWith('画像')) return cleanName;
    return `${cleanName} 画像`;
  } else {
    if (cleanName.endsWith('動画')) return cleanName;
    return `${cleanName} 動画`;
  }
};

function renderSourceFilterSelect() {
  const sidebarSelect = $('source-filter-select');
  const gallerySelect = $('gallery-source-filter-select');
  const currentVal = state.selectedSource;

  // 1. サイドバーセレクト（画像のみに制限）
  if (sidebarSelect) {
    sidebarSelect.innerHTML = '<option value="all">すべての画像</option>';
    state.sources.forEach(src => {
      if (src.enabled === 1 && src.archived === 0 && src.type === 'screenshot') {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.textContent = formatSelectLabel(src.name, 'screenshot');
        opt.title = src.path;
        sidebarSelect.appendChild(opt);
      }
    });
    sidebarSelect.value = currentVal;
  }

  // 2. トップバーギャラリーセレクト（画像のみに制限）
  if (gallerySelect) {
    gallerySelect.innerHTML = '<option value="all">すべての画像</option>';
    state.sources.forEach(src => {
      if (src.enabled === 1 && src.archived === 0 && src.type === 'screenshot') {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.textContent = formatSelectLabel(src.name, 'screenshot');
        opt.title = src.path;
        gallerySelect.appendChild(opt);
      }
    });
    gallerySelect.value = currentVal;
  }
}

// 36色プリセット（routes.js の PRESET_COLORS と同期）
const PRESET_COLORS = [
  '#7aa2f7','#9ece6a','#f7768e','#e0af68','#bb9af7','#7dcfff',
  '#2ac3de','#73daca','#41a6b5','#c0caf5','#a9b1d6','#9d7cd8',
  '#6d91de','#449dab','#b4f9f8','#394b70','#3d59a1','#1a1b26',
  '#ff9e64','#db4b4b','#ff007c','#c53b53','#914c54',
  '#d19a66','#d4a959','#cfc9c2','#b5c0d9','#acb0d0',
  '#6183bb','#516198','#2e3c64','#364a82','#0db9d7','#38bdf8',
];

function colorPickerHtml(selected) {
  return PRESET_COLORS.map(c =>
    `<button type="button" class="color-swatch${c === selected ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
  ).join('');
}

function renderCategoryList() {
  const ul = $('category-list');
  ul.innerHTML = '';
  state.categories.forEach(cat => {
    const li = document.createElement('li');
    li.className = 'menu-item menu-item--with-actions';
    if (state.view === 'category' && state.selectedCategory == cat.id) li.classList.add('active');
    li.innerHTML = `
      <span class="menu-item__dot" style="background:${escHtml(cat.color ?? '#7aa2f7')}"></span>
      <span class="menu-item__name" data-cat-id="${cat.id}">${escHtml(cat.name)}</span>
      <span class="menu-item__count">${cat.count ?? 0}</span>
      <span class="menu-item__actions">
        <button class="item-btn item-btn--edit" data-type="category" data-id="${cat.id}" title="編集">✏</button>
        <button class="item-btn item-btn--delete" data-type="category" data-id="${cat.id}" title="削除">🗑</button>
      </span>
    `;
    li.querySelector('.menu-item__name').addEventListener('click', () => setView('category', { category: cat.id }));
    li.querySelector('.item-btn--edit').addEventListener('click', e => { e.stopPropagation(); openEditModal('category', cat); });
    li.querySelector('.item-btn--delete').addEventListener('click', e => { e.stopPropagation(); deleteItem('category', cat); });
    ul.appendChild(li);
  });
}

function renderTagList() {
  const ul = $('tag-list');
  ul.innerHTML = '';
  state.tags.forEach(tag => {
    const li = document.createElement('li');
    li.className = 'menu-item menu-item--with-actions';
    if (state.view === 'tag' && state.selectedTag == tag.id) li.classList.add('active');
    li.innerHTML = `
      <span class="menu-item__dot" style="background:${escHtml(tag.color ?? '#9ece6a')}"></span>
      <span class="menu-item__name" data-tag-id="${tag.id}">${escHtml(tag.name)}</span>
      <span class="menu-item__count">${tag.count ?? 0}</span>
      <span class="menu-item__actions">
        <button class="item-btn item-btn--edit" data-type="tag" data-id="${tag.id}" title="編集">✏</button>
        <button class="item-btn item-btn--delete" data-type="tag" data-id="${tag.id}" title="削除">🗑</button>
      </span>
    `;
    li.querySelector('.menu-item__name').addEventListener('click', () => setView('tag', { tag: tag.id }));
    li.querySelector('.item-btn--edit').addEventListener('click', e => { e.stopPropagation(); openEditModal('tag', tag); });
    li.querySelector('.item-btn--delete').addEventListener('click', e => { e.stopPropagation(); deleteItem('tag', tag); });
    ul.appendChild(li);
  });
}

async function loadDateList() {
  const dates = await apiFetch('/dates');
  const ul    = $('date-list');
  ul.innerHTML = '';

  // 年月でグループ化
  const byYearMonth = {};
  dates.forEach(d => {
    const ym = d.date.slice(0, 7); // YYYY-MM
    if (!byYearMonth[ym]) byYearMonth[ym] = { count: 0, dates: [] };
    byYearMonth[ym].count += d.count;
    byYearMonth[ym].dates.push(d);
  });

  Object.entries(byYearMonth).forEach(([ym, { count }]) => {
    const li = document.createElement('li');
    li.className = 'menu-item';
    if (state.view === 'date' && state.selectedDate?.startsWith(ym)) li.classList.add('active');
    const [y, m] = ym.split('-');
    li.innerHTML = `
      <span class="menu-item__icon" style="font-size:10px">📅</span>
      <span class="menu-item__name">${y}年${parseInt(m)}月</span>
      <span class="menu-item__count">${count}</span>
    `;
    li.addEventListener('click', () => setView('date', { date: ym }));
    ul.appendChild(li);
  });
}

function setView(view, { date, category, tag } = {}) {
  state.view             = view;
  state.selectedDate     = date ?? null;
  state.selectedCategory = category ?? null;
  state.selectedTag      = tag ?? null;
  state.page             = 1;
  state.search           = '';
  $('search-input').value = '';

  clearSelectionState();

  // アクティブ状態更新
  $$('.menu-item').forEach(el => el.classList.remove('active'));

  if (view === 'all')               { $('menu-all').classList.add('active'); }
  else if (view === 'favorite')     { $('menu-favorite').classList.add('active'); }
  else if (view === 'uncategorized'){ $('menu-uncategorized').classList.add('active'); }
  else if (view === 'backup')       { $('menu-backup').classList.add('active'); }

  // 全セクションを非表示にする
  $('gallery-section').classList.add('hidden');
  $('backup-section').classList.add('hidden');

  if (view === 'backup') {
    $('backup-section').classList.remove('hidden');
    // 📁 コピー元表示を動的更新
    const srcPathEl = $('backup-src-path');
    if (srcPathEl) {
      let srcPath = '未設定（画像メディアソースを登録してください）';
      const activeSsSources = state.sources.filter(s => s.type === 'screenshot' && s.enabled === 1 && s.archived === 0);
      if (activeSsSources.length > 0) {
        const currentSrc = activeSsSources.find(s => s.id == state.selectedSource);
        srcPath = currentSrc ? currentSrc.path : activeSsSources[0].path;
      }
      srcPathEl.textContent = srcPath;
    }
    return;
  }

  $('gallery-section').classList.remove('hidden');

  loadGallery();
}

// ===== ギャラリー読み込み =====
async function loadGallery() {
  const params = new URLSearchParams({
    page:  state.page,
    limit: PAGE_SIZE,
    sort:  state.sort,
    order: state.order,
    view:  state.view,
  });

  if (state.search)           params.set('search',   state.search);
  if (state.selectedDate)     params.set('date',      state.selectedDate);
  if (state.selectedCategory) params.set('category',  state.selectedCategory);
  if (state.selectedTag)      params.set('tag',       state.selectedTag);
  if (state.selectedSource && state.selectedSource !== 'all') {
    params.set('source_id', state.selectedSource);
  }

  let data;
  try {
    data = await apiFetch(`/screenshots?${params}`);
  } catch (err) {
    showToast(`一覧の取得に失敗しました: ${err.message}`, 'error');
    return;
  }

  state.total = data.total;
  state.currentPageItems = data.items;
  $('count-label').textContent = `${data.total.toLocaleString()}件`;

  renderGallery(data.items);
  renderPagination(data.total, data.page, data.limit);
}

// ===== ギャラリー描画 =====
function renderGallery(items) {
  const gallery = $('gallery');
  gallery.innerHTML = '';

  if (items.length === 0) {
    gallery.innerHTML = `
      <div class="gallery__empty">
        <div class="gallery__empty-icon">🔍</div>
        <div class="gallery__empty-text">表示できる画像がありません</div>
      </div>
    `;
    return;
  }

  // 日付でグループ化
  const groups = groupByDate(items);

  for (const [date, groupItems] of groups) {
    const header = document.createElement('div');
    header.className = 'gallery__date-header';
    header.innerHTML = `${formatDate(date)} <span class="gallery__date-count">${groupItems.length}枚</span>`;
    gallery.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'gallery__grid';

    groupItems.forEach(item => {
      const card = buildThumbCard(item);
      grid.appendChild(card);
    });

    gallery.appendChild(grid);
  }

  // Intersection Observer で遅延ロード
  initLazyLoad();
}

function groupByDate(items) {
  const map = new Map();
  items.forEach(item => {
    const date = item.taken_at ? item.taken_at.slice(0, 10) : '不明';
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(item);
  });
  return map;
}

function formatDate(dateStr) {
  if (dateStr === '不明') return '日時不明';
  const [y, m, d] = dateStr.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function buildThumbCard(item) {
  const card = document.createElement('div');
  card.className = 'thumb-card';
  card.dataset.id = item.id;
  if (item.missing) card.classList.add('missing');

  // 選択モード中は即座に select-mode クラスを付ける
  if (state.selectMode) card.classList.add('select-mode');
  if (state.selectedIds.has(item.id)) {
    card.classList.add('multi-selected');
  }

  // サムネイル（data-src で遅延ロード）
  // thumbnail_generated = -1 の場合も API 側で再生成するため常に URL を設定する
  const img = document.createElement('img');
  img.className = 'thumb-card__img';
  img.alt = item.file_name;
  img.dataset.src = `/api/thumbnail/${item.id}`;
  img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
  // サムネイル取得失敗時は元画像へフォールバック
  img.addEventListener('error', () => {
    if (!img.dataset.fallback) {
      img.dataset.fallback = '1';
      img.src = `/api/image/${item.id}`;
    }
  }, { once: false });
  card.appendChild(img);

  // チェックボックス（左上）
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'thumb-card__checkbox';
  cb.checked = state.selectedIds.has(item.id);
  cb.disabled = !state.selectMode;
  cb.tabIndex = state.selectMode ? 0 : -1;
  cb.addEventListener('change', e => {
    e.stopPropagation();
    if (cb.checked) {
      state.selectedIds.add(item.id);
      card.classList.add('multi-selected');
    } else {
      state.selectedIds.delete(item.id);
      card.classList.remove('multi-selected');
    }
    updateBulkBar();
  });
  card.appendChild(cb);

  // ハートボタン（右上）
  const heart = document.createElement('button');
  heart.className = `thumb-card__heart${item.favorite ? ' active' : ''}`;
  heart.title = item.favorite ? 'お気に入り解除' : 'お気に入りに追加';
  heart.textContent = item.favorite ? '♥' : '♡';
  heart.addEventListener('click', async e => {
    e.stopPropagation(); // カードクリックを発火させない
    const newVal = item.favorite ? 0 : 1;
    try {
      await apiFetch('/favorite', { method: 'POST', body: { id: item.id, value: newVal } });
      item.favorite = newVal;
      heart.textContent = newVal ? '♥' : '♡';
      heart.title = newVal ? 'お気に入り解除' : 'お気に入りに追加';
      heart.classList.toggle('active', !!newVal);
      // プレビューが開いている同じ画像なら更新
      if (state.previewDetail?.id === item.id) {
        state.previewDetail.favorite = newVal;
        renderPreviewMeta(state.previewDetail);
      }
      loadSidebarData();
    } catch (err) {
      showToast(`お気に入りの更新に失敗: ${err.message}`, 'error');
    }
  });
  card.appendChild(heart);

  // その他オーバーレイ（メモアイコン）
  const overlays = document.createElement('div');
  overlays.className = 'thumb-card__overlays';
  if (item.has_memo) overlays.innerHTML += `<span class="thumb-card__has-memo">📝</span>`;
  card.appendChild(overlays);

  renderThumbLabels(card, item);

  // カードクリック
  card.addEventListener('click', () => {
    if (suppressNextCardClick) return;
    if (state.selectMode) {
      toggleSelectCard(item.id, card);
    } else {
      selectImage(item.id);
    }
  });

  return card;
}

function normalizeItemCategories(item) {
  if (Array.isArray(item.categories) && item.categories.length > 0) {
    return item.categories.map(c => ({
      id: c.id,
      name: c.name,
      color: c.color || '#7aa2f7',
    }));
  }
  return (item.category_names ?? []).map(name => ({
    id: null,
    name,
    color: '#7aa2f7',
  }));
}

function normalizeItemTags(item) {
  if (Array.isArray(item.tags) && item.tags.length > 0) {
    return item.tags.map(t => ({
      id: t.id,
      name: t.name,
      color: t.color || '#9ece6a',
    }));
  }
  return (item.tag_names ?? []).map(name => ({
    id: null,
    name,
    color: '#9ece6a',
  }));
}

function renderThumbLabels(card, item) {
  const old = card.querySelector('.thumb-card__labels');
  if (old) old.remove();

  const labels = document.createElement('div');
  labels.className = 'thumb-card__labels';

  const categories = normalizeItemCategories(item);

  if (categories.length > 0) {
    categories.slice(0, 2).forEach(cat => {
      const span = document.createElement('span');
      span.className = 'thumb-card__label';
      span.textContent = cat.name;
      const catColor = cat.color || '#7aa2f7';
      span.style.backgroundColor = hexToRgba(catColor, 0.85);
      span.style.color = getReadableTextColor(catColor);
      labels.appendChild(span);
    });
  } else if (!item.missing) {
    const span = document.createElement('span');
    span.className = 'thumb-card__label thumb-card__label--uncategorized';
    span.textContent = '未分類';
    labels.appendChild(span);
  }

  const tags = normalizeItemTags(item);

  if (tags.length > 0) {
    const displayTags = tags.slice(0, 3);
    const hiddenCount = tags.length - 3;
    
    displayTags.forEach(tag => {
      const span = document.createElement('span');
      span.className = 'thumb-card__tag-label';
      span.textContent = `#${tag.name}`;
      const tagColor = tag.color || '#9ece6a';
      span.style.backgroundColor = hexToRgba(tagColor, 0.85);
      span.style.color = getReadableTextColor(tagColor);
      labels.appendChild(span);
    });
    
    if (hiddenCount > 0) {
      const more = document.createElement('span');
      more.className = 'thumb-card__tag-more';
      more.textContent = `+${hiddenCount}`;
      labels.appendChild(more);
    }
  }

  if (labels.children.length > 0) {
    card.appendChild(labels);
  }
}

function updateCurrentPageItemLabels(id, categories, tags) {
  const item = state.currentPageItems.find(x => x.id === id);
  if (!item) return;

  item.categories = categories;
  item.tags = tags;
  item.category_names = categories.map(c => c.name);
  item.tag_names = tags.map(t => t.name);

  const card = document.querySelector(`.thumb-card[data-id="${id}"]`);
  if (card) {
    renderThumbLabels(card, item);
  }
}

// ===== 遅延ロード =====
let observer = null;

function initLazyLoad() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      if (img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
        observer.unobserve(img);
      }
    });
  }, { rootMargin: '200px' });

  $$('img[data-src]').forEach(img => observer.observe(img));
}

// ===== ページング =====
function renderPagination(total, page, limit) {
  const totalPages = Math.ceil(total / limit);
  const pag = $('pagination');
  pag.innerHTML = '';
  if (totalPages <= 1) return;

  const addBtn = (label, targetPage, isActive = false, disabled = false) => {
    const btn = document.createElement('button');
    btn.className = `page-btn${isActive ? ' active' : ''}`;
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener('click', () => {
      state.page = targetPage;
      clearSelectionState();
      loadGallery();
      $('main-content').scrollTop = 0;
    });
    pag.appendChild(btn);
  };

  addBtn('‹', page - 1, false, page <= 1);

  const pages = getPageRange(page, totalPages);
  let prev = null;
  pages.forEach(p => {
    if (prev !== null && p - prev > 1) {
      const ellipsis = document.createElement('span');
      ellipsis.className = 'page-info';
      ellipsis.textContent = '…';
      pag.appendChild(ellipsis);
    }
    addBtn(p, p, p === page);
    prev = p;
  });

  addBtn('›', page + 1, false, page >= totalPages);

  const info = document.createElement('span');
  info.className = 'page-info';
  info.textContent = `${page} / ${totalPages}`;
  pag.appendChild(info);
}

function getPageRange(current, total) {
  const delta = 3;
  const left  = Math.max(1, current - delta);
  const right = Math.min(total, current + delta);
  const range = [];
  if (left > 1) range.push(1);
  for (let i = left; i <= right; i++) range.push(i);
  if (right < total) range.push(total);
  return [...new Set(range)];
}

// ===== 画像選択・プレビュー（通常モード） =====
async function selectImage(id) {
  if (state.selectedId) {
    const prev = document.querySelector(`.thumb-card[data-id="${state.selectedId}"]`);
    if (prev) prev.classList.remove('selected');
  }

  state.selectedId = id;

  const card = document.querySelector(`.thumb-card[data-id="${id}"]`);
  if (card) card.classList.add('selected');

  $('resizer-right').classList.remove('hidden');
  $('preview-panel').classList.remove('hidden');

  const previewImg = $('preview-image');
  previewImg.style.filter = '';

  // サムネイルを先に試み、失敗時は元画像へフォールバック
  const trySetPreview = () => {
    const thumb = new Image();
    thumb.onload = () => { previewImg.src = thumb.src; };
    thumb.onerror = () => { previewImg.src = `/api/image/${id}`; };
    thumb.src = `/api/thumbnail/${id}`;
  };
  trySetPreview();

  let detail;
  try {
    detail = await apiFetch(`/screenshots/${id}`);
  } catch (err) {
    showToast(`詳細の取得に失敗しました: ${err.message}`, 'error');
    return;
  }

  state.previewDetail = detail;
  previewImg.src = `/api/image/${id}`;
  renderPreviewMeta(detail);
}

function renderPreviewMeta(detail) {
  const meta   = $('preview-meta');
  const isFav  = detail.favorite === 1;
  const fileSize = detail.file_size ? formatFileSize(detail.file_size) : '不明';
  const takenAt  = detail.taken_at  ? formatDateTime(detail.taken_at)  : '不明';
  const catHtml  = state.categories.map(c => {
    const active = detail.categories.some(dc => dc.id === c.id);
    return `<button class="tag-pill ${active ? 'active' : ''}" data-id="${c.id}" data-type="category">${escHtml(c.name)}</button>`;
  }).join('');
  const tagHtml  = state.tags.map(t => {
    const active = detail.tags.some(dt => dt.id === t.id);
    return `<button class="tag-pill ${active ? 'active' : ''}" data-id="${t.id}" data-type="tag">${escHtml(t.name)}</button>`;
  }).join('');

  meta.innerHTML = `
    <!-- 2. 操作バー -->
    <div class="preview-action-bar">
      <button class="btn btn--ghost btn--sm ${isFav ? 'active' : ''}" id="btn-toggle-fav" style="${isFav ? 'color: var(--fav); border-color: var(--fav); background: rgba(246,193,119,0.1);' : ''}">
        ${isFav ? '★' : '☆'}
      </button>

      <select id="filter-preset" class="form-input preview-filter-select">
        <option value="none">フィルター: なし</option>
        <optgroup label="補正">
          <option value="natural_bright">明るく自然（暗所救済）</option>
          <option value="dark_fix">暗部補正（影を持ち上げ）</option>
          <option value="vivid">鮮やか（色強め）</option>
          <option value="clear">透明感（明るくクリア）</option>
          <option value="soft">柔らか（淡くふんわり）</option>
        </optgroup>
        <optgroup label="雰囲気">
          <option value="cinema">シネマ（暗め高コントラスト）</option>
          <option value="warm">暖色（夕焼け・室内）</option>
          <option value="cool">寒色（雪原・夜）</option>
          <option value="night">夜景補正（暗い夜向け）</option>
          <option value="battle">戦闘くっきり（派手め）</option>
        </optgroup>
        <optgroup label="特殊">
          <option value="mono">モノクロ</option>
          <option value="sepia">セピア</option>
          <option value="retro">レトロ</option>
          <option value="pale">淡色</option>
          <option value="high_sat">高彩度（かなり色強め）</option>
        </optgroup>
        <optgroup label="検証用">
          <option value="test_strong">強めテスト（確認用）</option>
        </optgroup>
      </select>

      <div class="preview-filter-strength">
        <input type="range" id="filter-strength" min="0" max="100" value="100" style="flex: 1; accent-color: var(--accent);">
        <span id="filter-strength-val" style="font-size: 12px; width: 24px; text-align: right; color: var(--subtext);">100</span>
      </div>

      <button class="btn btn--ghost btn--sm" id="btn-copy-image" title="画像をコピー">📋</button>
    </div>

    <!-- 3. コンパクト情報バー -->
    <div class="preview-info-compact">
      <span class="preview-info-compact__file"><span style="opacity:0.6">ファイル:</span> ${escHtml(detail.file_name)}</span>
      <span><span style="opacity:0.6">撮影:</span> ${takenAt}</span>
      <span><span style="opacity:0.6">サイズ:</span> ${fileSize}</span>
    </div>

    <!-- 4. カテゴリ・タグ編集エリア -->
    <div class="preview-label-editor">
      <div class="preview-label-box">
        <div class="preview-label-box__title">カテゴリ</div>
        <div class="tag-picker" id="category-picker">
          ${catHtml || '<span style="color:var(--subtext);font-size:12px">なし</span>'}
        </div>
      </div>
      <div class="preview-label-box">
        <div class="preview-label-box__title">タグ</div>
        <div class="tag-picker" id="tag-picker">
          ${tagHtml || '<span style="color:var(--subtext);font-size:12px">なし</span>'}
        </div>
      </div>
    </div>

    <!-- 5. メモ (折りたたみ) -->
    <details class="preview-memo-details" ${detail.memo ? 'open' : ''}>
      <summary>メモ ${detail.memo ? '<span style="opacity:0.6;font-weight:normal">(入力あり)</span>' : ''}</summary>
      <textarea class="preview-memo-textarea" id="preview-memo" placeholder="メモを入力...">${escHtml(detail.memo ?? '')}</textarea>
    </details>
  `;

  // お気に入りトグル
  $('btn-toggle-fav').addEventListener('click', async () => {
    const newVal = detail.favorite === 1 ? 0 : 1;
    try {
      await apiFetch('/favorite', { method: 'POST', body: { id: detail.id, value: newVal } });
      detail.favorite = newVal;
      state.previewDetail.favorite = newVal;
      renderPreviewMeta(detail);
      updateCardFav(detail.id, newVal);
      // カード上のハートも更新
      const heartBtn = document.querySelector(`.thumb-card[data-id="${detail.id}"] .thumb-card__heart`);
      if (heartBtn) {
        heartBtn.textContent = newVal ? '♥' : '♡';
        heartBtn.classList.toggle('active', !!newVal);
      }
      await loadSidebarData();
    } catch (err) {
      showToast(`お気に入りの更新に失敗: ${err.message}`, 'error');
    }
  });

  // カテゴリ・タグのトグル（重複登録防止のためonclick使用）
  meta.onclick = async e => {
    const pill = e.target.closest('.tag-pill');
    if (!pill) return;
    const type   = pill.dataset.type;
    const itemId = parseInt(pill.dataset.id);
    const isActive = pill.classList.contains('active');
    const action = isActive ? 'remove' : 'add';

    try {
      if (type === 'category') {
        await apiFetch('/category', { method: 'POST', body: { screenshotId: detail.id, categoryId: itemId, action } });
        if (action === 'add') {
          const src = state.categories.find(c => c.id === itemId);
          detail.categories.push({ id: itemId, name: src?.name ?? '', color: src?.color ?? '#7aa2f7' });
        } else {
          detail.categories = detail.categories.filter(c => c.id !== itemId);
        }
      } else {
        await apiFetch('/tag', { method: 'POST', body: { screenshotId: detail.id, tagId: itemId, action } });
        if (action === 'add') {
          const src = state.tags.find(t => t.id === itemId);
          detail.tags.push({ id: itemId, name: src?.name ?? '', color: src?.color ?? '#9ece6a' });
        } else {
          detail.tags = detail.tags.filter(t => t.id !== itemId);
        }
      }
      pill.classList.toggle('active', action === 'add');
      updateCurrentPageItemLabels(detail.id, detail.categories, detail.tags);
    } catch (err) {
      showToast(`更新失敗: ${err.message}`, 'error');
    }
  };

  // メモ（デバウンス保存）
  $('preview-memo').addEventListener('input', e => {
    clearTimeout(state.memoSaveTimer);
    state.memoSaveTimer = setTimeout(async () => {
      try {
        await apiFetch('/memo', { method: 'POST', body: { id: detail.id, memo: e.target.value } });
      } catch (err) {
        showToast(`メモ保存失敗: ${err.message}`, 'error');
      }
    }, 600);
  });

  // 画像コピー
  $('btn-copy-image').addEventListener('click', () => copyImageToClipboard(detail.id));

  // フィルター
  const presetSelect = $('filter-preset');
  const strengthRange = $('filter-strength');
  const strengthVal = $('filter-strength-val');

  if (presetSelect && strengthRange) {
    presetSelect.addEventListener('change', () => {
      applyPreviewFilter();
    });
    strengthRange.addEventListener('input', e => {
      strengthVal.textContent = e.target.value;
      applyPreviewFilter();
    });
  }
}

function updateCardFav(id, isFav) {
  const card = document.querySelector(`.thumb-card[data-id="${id}"]`);
  if (!card) return;
  // ハートボタンを更新（overlays の ★ は削除）
  const overlays = card.querySelector('.thumb-card__overlays');
  const favSpan  = overlays?.querySelector('.thumb-card__fav');
  if (isFav && !favSpan) {
    overlays?.insertAdjacentHTML('afterbegin', `<span class="thumb-card__fav">★</span>`);
  } else if (!isFav && favSpan) {
    favSpan.remove();
  }
}

// ===== 画像コピー =====
async function copyImageToClipboard(id) {
  const btn = $('btn-copy-image');
  if (btn) { btn.disabled = true; btn.textContent = 'コピー中...'; }

  try {
    if (!navigator.clipboard?.write) {
      throw new Error('このブラウザは Clipboard API に対応していません。Chrome を使用してください。');
    }

    const response = await fetch(`/api/image/${id}`);
    if (!response.ok) throw new Error('画像の読み込みに失敗しました');
    const blob = await response.blob();

    const bmp    = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width  = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);

    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    showToast('クリップボードにコピーしました');
  } catch (err) {
    showToast(`コピー失敗: ${err.message}`, 'error', 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '📋 画像をコピー'; }
  }
}

// ===== スキャン =====
async function startScan(isInitial = false) {
  let jobId;
  try {
    const body = {};
    if (state.selectedSource && state.selectedSource !== 'all') {
      body.sourceId = parseInt(state.selectedSource);
    }
    const res = await apiFetch('/rescan/start', { method: 'POST', body });
    jobId = res.jobId;
    state.scanJobId = jobId;
  } catch (err) {
    if (err.message.includes('スキャン実行中')) {
      showToast('スキャン実行中です', 'ok');
    } else {
      showToast(`スキャン開始に失敗: ${err.message}`, 'error');
    }
    return;
  }

  $('initial-scan-screen').classList.add('hidden');
  $('scan-overlay').classList.remove('hidden');
  $('scan-log').textContent = '';

  const es = new EventSource(`/api/rescan/events/${jobId}`);

  es.addEventListener('log', e => {
    const log = $('scan-log');
    log.textContent += JSON.parse(e.data) + '\n';
    log.scrollTop = log.scrollHeight;
  });

  es.addEventListener('progress', e => {
    const d   = JSON.parse(e.data);
    const pct = d.total > 0 ? Math.round((d.processed / d.total) * 100) : 0;
    const fill = $('scan-progress-bar').querySelector('.progress-bar__fill');
    if (fill) fill.style.width = `${pct}%`;
    $('scan-progress-text').textContent = `${pct}%`;
  });

  es.addEventListener('finished', async e => {
    es.close();
    $('scan-overlay').classList.add('hidden');
    const d = JSON.parse(e.data);
    showToast(`スキャン完了: 新規 ${d.added}件, 更新 ${d.updated}件`);
    if (isInitial) {
      $('initial-scan-screen').classList.add('hidden');
      setupMainListeners();
    }
    await loadSidebarData();
    loadGallery();

    // サマリーモーダルの表示
    try {
      const status = await apiFetch('/status');
      $('summary-total').textContent = status.total.toLocaleString();
      $('summary-added').textContent = d.added.toLocaleString();
      $('summary-updated').textContent = d.updated.toLocaleString();
      $('summary-missing').textContent = status.missing.toLocaleString();
      $('summary-thumb-done').textContent = status.thumbDone.toLocaleString();
      $('summary-thumb-pend').textContent = status.thumbPend.toLocaleString();
      $('summary-thumb-fail').textContent = status.thumbFail.toLocaleString();
      $('summary-favorites').textContent = status.favorites.toLocaleString();
      $('summary-modal').classList.remove('hidden');
    } catch (err) {
      console.error('サマリー取得失敗:', err);
    }
  });

  es.addEventListener('error', e => {
    es.close();
    $('scan-overlay').classList.add('hidden');
    const msg = e.data ? JSON.parse(e.data)?.message : 'スキャンエラー';
    showToast(msg, 'error');
    if (isInitial) {
      $('initial-scan-screen').classList.remove('hidden');
      $('app').classList.add('hidden');
    }
  });
}

// ===== バックアップ =====
function initBackup() {
  const destInput   = $('backup-dest');
  const checkEl     = $('backup-dest-check');
  const btnStart    = $('btn-backup-start');
  const statusEl    = $('backup-status');
  const statusLabel = $('backup-status-label');
  const logEl       = $('backup-log');

  let checkTimer = null;

  destInput.addEventListener('input', () => {
    clearTimeout(checkTimer);
    checkEl.className = 'backup-dest-check';
    checkEl.textContent = '';
    checkTimer = setTimeout(() => validateBackupDest(destInput.value.trim(), checkEl), 400);
  });

  btnStart.addEventListener('click', async () => {
    const dest = destInput.value.trim();
    if (!dest) { showToast('バックアップ先を入力してください', 'error'); return; }

    // 📁 コピー元パスを動的に決定
    let srcPath = '';
    const activeSsSources = state.sources.filter(s => s.type === 'screenshot' && s.enabled === 1 && s.archived === 0);
    if (activeSsSources.length > 0) {
      const currentSrc = activeSsSources.find(s => s.id == state.selectedSource);
      srcPath = currentSrc ? currentSrc.path : activeSsSources[0].path;
    }

    if (!srcPath) {
      showToast('有効な画像メディアソースが登録されていないため、バックアップを実行できません', 'error');
      return;
    }

    const confirmed = window.confirm(
      `バックアップを開始します。\n\nコピー元: ${srcPath}\nコピー先: ${dest}\n\nよろしいですか？`
    );
    if (!confirmed) return;

    btnStart.disabled = true;
    statusEl.classList.remove('hidden');
    statusLabel.className = 'backup-status__label';
    statusLabel.textContent = '実行中...';
    logEl.textContent = '';

    let jobId;
    try {
      const res = await apiFetch('/backup/start', { method: 'POST', body: { dest } });
      jobId = res.jobId;
    } catch (err) {
      showToast(`バックアップ開始失敗: ${err.message}`, 'error');
      btnStart.disabled = false;
      statusEl.classList.add('hidden');
      return;
    }

    const es = new EventSource(`/api/backup/events/${jobId}`);

    es.addEventListener('log', e => {
      logEl.textContent += JSON.parse(e.data) + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    });

    es.addEventListener('finished', d => {
      es.close();
      const data = JSON.parse(d.data);
      statusLabel.textContent = data.success ? 'バックアップ完了' : `バックアップ失敗 (コード: ${data.code})`;
      statusLabel.className   = `backup-status__label ${data.success ? 'ok' : 'ng'}`;
      btnStart.disabled = false;
      showToast(data.success ? 'バックアップが完了しました' : 'バックアップが失敗しました', data.success ? 'ok' : 'error');
    });

    es.addEventListener('error', e => {
      es.close();
      const msg = e.data ? JSON.parse(e.data)?.message : 'バックアップエラー';
      statusLabel.textContent = msg;
      statusLabel.className   = 'backup-status__label ng';
      btnStart.disabled = false;
    });
  });
}

async function validateBackupDest(dest, el) {
  if (!dest) return;

  if (!/^[A-Za-z]:[\\/]/.test(dest)) {
    el.className = 'backup-dest-check ng';
    el.textContent = '絶対パスで入力してください';
    return;
  }

  // 📁 コピー元パスを動的に決定
  let srcPath = '';
  const activeSsSources = state.sources.filter(s => s.type === 'screenshot' && s.enabled === 1 && s.archived === 0);
  if (activeSsSources.length > 0) {
    const currentSrc = activeSsSources.find(s => s.id == state.selectedSource);
    srcPath = currentSrc ? currentSrc.path : activeSsSources[0].path;
  }

  if (!srcPath) {
    el.className = 'backup-dest-check ng';
    el.textContent = '有効な画像メディアソースが登録されていません';
    return;
  }

  const srcNorm  = srcPath.toLowerCase().replace(/\//g, '\\');
  const destNorm = dest.toLowerCase().replace(/\//g, '\\').replace(/\\$/, '');
  if (destNorm === srcNorm || destNorm.startsWith(srcNorm + '\\')) {
    el.className = 'backup-dest-check ng';
    el.textContent = 'コピー元フォルダ内には指定できません';
    return;
  }

  el.className = 'backup-dest-check ok';
  el.textContent = '✓ 入力OK（存在しない場合は自動作成されます）';
}

// ===== ショートカット =====
function initShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      e.preventDefault();
      if (state.selectedId) copyImageToClipboard(state.selectedId);
    }
  });
}

// ===== フォーマット補助 =====
function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024)        return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// 日本語の自然な日時にフォーマット
function formatDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} `
       + `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getReadableTextColor(hexColor) {
  if (!hexColor) return '#ffffff';
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) return '#ffffff';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 150 ? '#111827' : '#ffffff';
}

function hexToRgba(hexColor, alpha = 1) {
  if (!hexColor) return `rgba(0,0,0,${alpha})`;
  let hex = hexColor.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ===== debounce =====
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ===== 初期化 =====
async function init() {
  applyThumbSize();
  initResizers();
  initShortcuts();
  initBackup();

  let status;
  try {
    status = await apiFetch('/status');
  } catch (err) {
    showToast(`サーバーへの接続に失敗しました: ${err.message}`, 'error', 8000);
    return;
  }

  if (status.isEmpty) {
    showInitialSetup(status);
    return;
  }

  setupMainListeners();
  await loadSidebarData();
  loadGallery();
}

function showInitialSetup(status) {
  const container = $('initial-scan-screen');
  if (!container) return;

  container.classList.remove('hidden');
  $('app').classList.add('hidden');

  let title = 'Local Media Library';
  let desc = '';
  let icon = '📂';
  let actionButtonHtml = '';

  // 1. media_sources が0件の場合
  if (status.totalSources === 0) {
    title = 'フォルダを追加してください';
    icon = '📁';
    desc = '画像や動画を表示するには、まず設定画面からフォルダを追加してください。';
    actionButtonHtml = '<button id="btn-go-to-settings" class="btn btn--primary btn--large">⚙️ フォルダを追加する</button>';
  }
  // 2. 画像フォルダが未登録の場合
  else if (status.totalScreenshotSources === 0) {
    title = '画像フォルダが未登録です';
    icon = '📸';
    desc = '画像を表示するには、設定画面から画像フォルダを追加してください。';
    actionButtonHtml = '<button id="btn-go-to-settings" class="btn btn--primary btn--large">⚙️ 画像フォルダを追加する</button>';
  }
  // 3. 有効な画像フォルダがない場合
  else if (status.activeScreenshotSources === 0) {
    title = '有効な画像フォルダがありません';
    icon = '⚠️';
    desc = '設定画面で画像フォルダを有効化するか、新しい画像フォルダを追加してください。';
    actionButtonHtml = '<button id="btn-go-to-settings" class="btn btn--primary btn--large">⚙️ 設定を開く</button>';
  }
  // 4. 画像フォルダはあるが画像未読込の場合
  else {
    title = '画像フォルダが追加されています';
    icon = '📸';
    desc = 'まだ画像が読み込まれていません。<br>下のボタンを押して、追加済みフォルダ内の画像を読み込んでください。<br><br>' +
           '<span style="font-size: 12px; color: var(--subtext); font-weight: normal;">' +
           '画像の読み込み後、一覧画面に画像が表示されます。' +
           '</span>';
    actionButtonHtml = '<button id="btn-initial-scan" class="btn btn--primary btn--large">🔍 画像を読み込む</button>';
  }

  container.innerHTML = `
    <div class="initial-scan__box" style="max-width: 520px; width: 90vw; padding: 40px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); text-align: center;">
      <div class="initial-scan__icon" style="font-size: 48px; margin-bottom: 16px;">${icon}</div>
      <h1 class="initial-scan__title" style="font-size: 20px; font-weight: 600; color: var(--text); margin-bottom: 16px;">${title}</h1>
      <p class="initial-scan__desc" style="line-height: 1.6; font-size: 13px; color: var(--text); margin-bottom: 24px; text-align: left;">
        ${desc}
      </p>
      <div style="display: flex; justify-content: center; gap: 12px;">
        ${actionButtonHtml}
      </div>
    </div>
  `;

  // イベントハンドラ割り当て
  const btnScan = $('btn-initial-scan');
  if (btnScan) {
    btnScan.addEventListener('click', () => startScan(true));
  }

  const btnSettings = $('btn-go-to-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', async () => {
      // 初回スキャン画面を隠す
      $('initial-scan-screen').classList.add('hidden');
      
      // メインUIをセットアップして表示
      setupMainListeners();
      await loadSidebarData();
      
      // 設定タブをクリック
      const settingsTab = document.querySelector('.global-tab[data-target="settings"]');
      if (settingsTab) {
        settingsTab.click();
      }
    });
  }
}

// ===== メインのイベントリスナー登録 =====
function setupMainListeners() {
  $('app').classList.remove('hidden');

  const sourceSelect = $('source-filter-select');
  const gallerySelect = $('gallery-source-filter-select');

  const handleSourceChange = (val) => {
    state.selectedSource = val;
    state.page = 1;
    clearSelectionState();

    if (sourceSelect) sourceSelect.value = val;
    if (gallerySelect) gallerySelect.value = val;

    loadSidebarData();
    
    // アクティブなタブに応じて処理を切り替える
    const activeTab = document.querySelector('.global-tab.active');
    const activeTarget = activeTab ? activeTab.dataset.target : 'gallery';
    
    if (activeTarget === 'gallery') {
      loadGallery();
    } else if (activeTarget === 'video') {
      if (window.LocalMediaVideo && window.LocalMediaVideo.VideoApp) {
        window.LocalMediaVideo.VideoApp.loadVideos();
      }
    }
  };

  if (sourceSelect) {
    sourceSelect.addEventListener('change', e => handleSourceChange(e.target.value));
  }
  if (gallerySelect) {
    gallerySelect.addEventListener('change', e => handleSourceChange(e.target.value));
  }

  $('menu-all').addEventListener('click',           () => setView('all'));
  $('menu-favorite').addEventListener('click',      () => setView('favorite'));
  $('menu-uncategorized').addEventListener('click', () => setView('uncategorized'));
  $('menu-backup').addEventListener('click',        () => setView('backup'));

  $('search-input').addEventListener('input', debounce(e => {
    state.search = e.target.value.trim();
    state.page   = 1;
    clearSelectionState();
    loadGallery();
  }, DEBOUNCE_MS));

  $('sort-select').addEventListener('change', e => {
    const [sort, order] = e.target.value.split(':');
    state.sort  = sort;
    state.order = order;
    state.page  = 1;
    clearSelectionState();
    loadGallery();
  });

  $$('.thumb-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.thumbSizeIdx = parseInt(btn.dataset.size);
      localStorage.setItem('localmedia.thumbnailSize', state.thumbSizeIdx);
      applyThumbSize();
    });
  });

  // 選択モード
  $('btn-select-mode').addEventListener('click', () => enterSelectMode());
  $('btn-exit-select-mode').addEventListener('click', () => exitSelectMode());

  $('btn-select-all-page').addEventListener('click', () => {
    const targets = state.currentPageItems.filter(item => !item.missing);
    targets.forEach(item => {
      state.selectedIds.add(item.id);
      const card = document.querySelector(`.thumb-card[data-id="${item.id}"]`);
      if (card) {
        card.classList.add('multi-selected');
        const cb = card.querySelector('.thumb-card__checkbox');
        if (cb) cb.checked = true;
      }
    });
    updateBulkBar();
  });

  $('btn-deselect-all').addEventListener('click', () => {
    state.selectedIds.clear();
    $$('.thumb-card').forEach(card => {
      card.classList.remove('multi-selected');
      const cb = card.querySelector('.thumb-card__checkbox');
      if (cb) cb.checked = false;
    });
    updateBulkBar();
  });

  $('btn-bulk-deselect').addEventListener('click', () => {
    state.selectedIds.clear();
    $$('.thumb-card').forEach(card => {
      card.classList.remove('multi-selected');
      const cb = card.querySelector('.thumb-card__checkbox');
      if (cb) cb.checked = false;
    });
    updateBulkBar();
  });

  // 一括お気に入りON
  $('btn-bulk-fav-on').addEventListener('click', async () => {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    try {
      await apiFetch('/bulk/favorite', { method: 'POST', body: { ids, favorite: true } });
      showToast(`${ids.length}枚をお気に入りに追加しました`);
      await loadSidebarData();
      loadGallery();
    } catch (err) {
      showToast(`一括お気に入り更新に失敗: ${err.message}`, 'error');
    }
  });

  // 一括お気に入りOFF
  $('btn-bulk-fav-off').addEventListener('click', async () => {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    try {
      await apiFetch('/bulk/favorite', { method: 'POST', body: { ids, favorite: false } });
      showToast(`${ids.length}枚のお気に入りを解除しました`);
      await loadSidebarData();
      loadGallery();
    } catch (err) {
      showToast(`一括お気に入り更新に失敗: ${err.message}`, 'error');
    }
  });

  // 一括カテゴリ追加
  $('btn-bulk-category').addEventListener('click', async () => {
    const ids = [...state.selectedIds];
    const categoryId = parseInt($('bulk-category-select').value);
    if (!ids.length) return;
    if (!categoryId) { showToast('カテゴリを選択してください', 'error'); return; }
    try {
      await apiFetch('/bulk/category', { method: 'POST', body: { ids, categoryId, action: 'add' } });
      showToast(`${ids.length}枚にカテゴリを追加しました`);
      const cat = state.categories.find(c => c.id === categoryId);
      ids.forEach(id => {
        const item = state.currentPageItems.find(x => x.id === id);
        if (!item || !cat) return;
        item.categories = item.categories ?? [];
        if (!item.categories.some(c => c.id === cat.id)) {
          item.categories.push({ id: cat.id, name: cat.name, color: cat.color ?? '#7aa2f7' });
        }
        item.category_names = item.categories.map(c => c.name);
        const card = document.querySelector(`.thumb-card[data-id="${id}"]`);
        if (card) renderThumbLabels(card, item);
      });
    } catch (err) {
      showToast(`一括カテゴリ追加に失敗: ${err.message}`, 'error');
    }
  });

  // 一括タグ追加
  $('btn-bulk-tag').addEventListener('click', async () => {
    const ids = [...state.selectedIds];
    const tagId = parseInt($('bulk-tag-select').value);
    if (!ids.length) return;
    if (!tagId) { showToast('タグを選択してください', 'error'); return; }
    try {
      await apiFetch('/bulk/tag', { method: 'POST', body: { ids, tagId, action: 'add' } });
      showToast(`${ids.length}枚にタグを追加しました`);
      const tag = state.tags.find(t => t.id === tagId);
      ids.forEach(id => {
        const item = state.currentPageItems.find(x => x.id === id);
        if (!item || !tag) return;
        item.tags = item.tags ?? [];
        if (!item.tags.some(t => t.id === tag.id)) {
          item.tags.push({ id: tag.id, name: tag.name, color: tag.color ?? '#9ece6a' });
        }
        item.tag_names = item.tags.map(t => t.name);
        const card = document.querySelector(`.thumb-card[data-id="${id}"]`);
        if (card) renderThumbLabels(card, item);
      });
    } catch (err) {
      showToast(`一括タグ追加に失敗: ${err.message}`, 'error');
    }
  });

  $('btn-rescan').addEventListener('click', async () => {
    const ok = window.confirm('再スキャンを実行します。時間がかかる場合があります。続けますか？');
    if (ok) startScan(false);
  });

  $('btn-close-preview').addEventListener('click', () => {
    $('preview-panel').classList.add('hidden');
    $('resizer-right').classList.add('hidden');
    const prev = document.querySelector('.thumb-card.selected');
    if (prev) prev.classList.remove('selected');
    state.selectedId = null;
  });

  $('btn-add-category').addEventListener('click', async () => {
    const name = await openModal('カテゴリを追加', '例: 自キャラ、風景、戦闘');
    if (!name) return;
    try {
      const cat = await apiFetch('/categories', { method: 'POST', body: { name } });
      state.categories.push(cat);
      renderCategoryList();
      syncBulkSelects();
      showToast(`カテゴリ「${name}」を追加しました`);
    } catch (err) {
      showToast(`追加失敗: ${err.message}`, 'error');
    }
  });

  $('btn-add-tag').addEventListener('click', async () => {
    const name = await openModal('タグを追加', '例: 夜景、雪原、機工士');
    if (!name) return;
    try {
      const tag = await apiFetch('/tags', { method: 'POST', body: { name } });
      state.tags.push(tag);
      renderTagList();
      syncBulkSelects();
      showToast(`タグ「${name}」を追加しました`);
    } catch (err) {
      showToast(`追加失敗: ${err.message}`, 'error');
    }
  });

  const btnCloseSummary = $('btn-close-summary');
  if (btnCloseSummary) {
    btnCloseSummary.addEventListener('click', () => {
      $('summary-modal').classList.add('hidden');
    });
  }

  setupDragSelection();
}

// ===== ドラッグ範囲選択 =====
let isDraggingSelection = false;
let suppressNextCardClick = false;

function setupDragSelection() {
  let selectionRect = null;
  let dragStartX = 0;
  let dragStartY = 0;

  document.body.addEventListener('mousedown', (e) => {
    if (!state.selectMode) return;
    if (e.button !== 0) return; // 左クリックのみ

    const target = e.target;
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('select') ||
      target.closest('textarea') ||
      target.closest('.thumb-card__heart') ||
      target.closest('.thumb-card__checkbox') ||
      target.closest('.tag-pill') ||
      target.closest('.preview-panel') ||
      target.closest('.sidebar')
    ) {
      return;
    }

    if (!target.closest('#main-content') && !target.closest('.gallery')) {
      return;
    }

    isDraggingSelection = false;
    suppressNextCardClick = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const onMouseMove = (moveEvent) => {
      const dx = moveEvent.clientX - dragStartX;
      const dy = moveEvent.clientY - dragStartY;
      
      if (!isDraggingSelection && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        isDraggingSelection = true;
        document.body.classList.add('is-range-selecting');
        
        selectionRect = document.createElement('div');
        selectionRect.className = 'selection-rect';
        document.body.appendChild(selectionRect);
      }

      if (isDraggingSelection) {
        const currentX = moveEvent.clientX;
        const currentY = moveEvent.clientY;
        
        const left = Math.min(dragStartX, currentX);
        const top = Math.min(dragStartY, currentY);
        const width = Math.abs(currentX - dragStartX);
        const height = Math.abs(currentY - dragStartY);
        
        selectionRect.style.left = `${left}px`;
        selectionRect.style.top = `${top}px`;
        selectionRect.style.width = `${width}px`;
        selectionRect.style.height = `${height}px`;
      }
    };

    const onMouseUp = (upEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (isDraggingSelection) {
        suppressNextCardClick = true;
        document.body.classList.remove('is-range-selecting');

        if (selectionRect) {
          const rectA = selectionRect.getBoundingClientRect();

          document.querySelectorAll('.thumb-card').forEach(card => {
            const rectB = card.getBoundingClientRect();
            if (rectsIntersect(rectA, rectB)) {
              const id = parseInt(card.dataset.id);
              if (!isNaN(id)) selectCardById(id);
            }
          });

          if (selectionRect.parentNode) {
            selectionRect.parentNode.removeChild(selectionRect);
          }
          selectionRect = null;
        }

        isDraggingSelection = false;
        
        // click発火を待って解除
        setTimeout(() => { suppressNextCardClick = false; }, 0);
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function rectsIntersect(a, b) {
  return !(
    a.right < b.left ||
    a.left > b.right ||
    a.bottom < b.top ||
    a.top > b.bottom
  );
}

function selectCardById(id) {
  const card = document.querySelector(`.thumb-card[data-id="${id}"]`);
  if (!card) return;

  state.selectedIds.add(id);
  card.classList.add('multi-selected');

  const cb = card.querySelector('.thumb-card__checkbox');
  if (cb) cb.checked = true;
  
  updateBulkBar();
}

document.addEventListener('DOMContentLoaded', init);
