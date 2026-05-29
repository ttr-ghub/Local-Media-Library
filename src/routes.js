const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDb } = require('./db');
const { scan } = require('./scanner');
const { generateThumbnail, runBackgroundGeneration } = require('./thumbnail');
const config = require('./config');
const logger = require('./logger');
const { isSafePath } = require('./utils/security');

const router = express.Router();
const SERVER_STARTED_AT = new Date().toISOString();

// ===== ジョブ管理 =====

const jobs = new Map();

function createJob(type) {
  const jobId = `${type}-${Date.now()}`;
  jobs.set(jobId, { type, status: 'running', clients: [], logs: [], result: null });
  return jobId;
}

function emitToJob(jobId, event, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  job.clients.forEach(res => {
    try { res.write(payload); } catch { /* クライアント切断は無視 */ }
  });
  if (event === 'log') job.logs.push(typeof data === 'string' ? data : JSON.stringify(data));
  if (event === 'finished' || event === 'error') {
    job.status = event === 'finished' ? 'done' : 'error';
    job.result = data;
  }
}

// ===== ステータス =====

router.get('/status', (req, res) => {
  const db = getDb();
  const total     = db.prepare('SELECT COUNT(*) AS c FROM screenshots WHERE missing = 0').get().c;
  const thumbDone = db.prepare('SELECT COUNT(*) AS c FROM screenshots WHERE thumbnail_generated = 1  AND missing = 0').get().c;
  const thumbFail = db.prepare('SELECT COUNT(*) AS c FROM screenshots WHERE thumbnail_generated = -1 AND missing = 0').get().c;
  const thumbPend = db.prepare('SELECT COUNT(*) AS c FROM screenshots WHERE thumbnail_generated = 0  AND missing = 0').get().c;
  const favorites = db.prepare('SELECT COUNT(*) AS c FROM screenshots WHERE favorite = 1 AND missing = 0').get().c;
  const missing   = db.prepare('SELECT COUNT(*) AS c FROM screenshots WHERE missing = 1').get().c;

  // メディアソースの統計を追加
  const totalSources = db.prepare('SELECT COUNT(*) AS c FROM media_sources').get().c;
  const activeSources = db.prepare('SELECT COUNT(*) AS c FROM media_sources WHERE enabled = 1 AND archived = 0').get().c;
  const totalScreenshotSources = db.prepare("SELECT COUNT(*) AS c FROM media_sources WHERE type = 'screenshot' AND archived = 0").get().c;
  const activeScreenshotSources = db.prepare("SELECT COUNT(*) AS c FROM media_sources WHERE type = 'screenshot' AND enabled = 1 AND archived = 0").get().c;
  const totalVideoSources = db.prepare("SELECT COUNT(*) AS c FROM media_sources WHERE type = 'video' AND archived = 0").get().c;
  const activeVideoSources = db.prepare("SELECT COUNT(*) AS c FROM media_sources WHERE type = 'video' AND enabled = 1 AND archived = 0").get().c;

  res.json({
    total,
    thumbDone,
    thumbFail,
    thumbPend,
    favorites,
    missing,
    isEmpty: total === 0,
    totalSources,
    activeSources,
    totalScreenshotSources,
    activeScreenshotSources,
    totalVideoSources,
    activeVideoSources,
    serverStartedAt: SERVER_STARTED_AT
  });
});

// ===== スクリーンショット一覧 =====

router.get('/screenshots', (req, res) => {
  const db = getDb();
  const {
    page     = 1,
    limit    = config.PAGE_SIZE,
    sort     = 'taken_at',
    order    = 'DESC',
    search   = '',
    category,
    tag,
    view     = 'all',
    date,
    source_id,
  } = req.query;

  const offset   = (parseInt(page) - 1) * Math.min(parseInt(limit), 300);
  const limitNum = Math.min(parseInt(limit), 300);

  const validSorts = { taken_at: 's.taken_at', file_name: 's.file_name', modified_at: 's.modified_at', favorite: 's.favorite' };
  const sortCol  = validSorts[sort] ?? 's.taken_at';
  const orderDir = order === 'ASC' ? 'ASC' : 'DESC';

  const where  = ['s.missing = 0'];
  const params = [];

  // メディアソース絞り込み（指定がない、または 'all' の場合はアーカイブされていない全有効ソースを表示）
  if (source_id && source_id !== 'all') {
    where.push('s.source_id = ?');
    params.push(parseInt(source_id));
  } else {
    where.push('s.source_id IN (SELECT id FROM media_sources WHERE archived = 0)');
  }

  if (view === 'favorite') {
    where.push('s.favorite = 1');
  } else if (view === 'uncategorized') {
    where.push('s.id NOT IN (SELECT screenshot_id FROM screenshot_categories)');
  }

  if (date) {
    where.push("strftime('%Y-%m-%d', s.taken_at) LIKE ?");
    // date が YYYY-MM の場合も YYYY-MM-DD の場合も対応
    params.push(`${date}%`);
  }

  if (search) {
    const q = `%${search}%`;
    where.push(`(
      s.file_name LIKE ? OR s.memo LIKE ? OR
      EXISTS (SELECT 1 FROM screenshot_categories sc JOIN categories c ON sc.category_id=c.id WHERE sc.screenshot_id=s.id AND c.name LIKE ?) OR
      EXISTS (SELECT 1 FROM screenshot_tags st JOIN tags t ON st.tag_id=t.id WHERE st.screenshot_id=s.id AND t.name LIKE ?)
    )`);
    params.push(q, q, q, q);
  }

  if (category) {
    where.push('EXISTS (SELECT 1 FROM screenshot_categories sc WHERE sc.screenshot_id=s.id AND sc.category_id=?)');
    params.push(parseInt(category));
  }

  if (tag) {
    where.push('EXISTS (SELECT 1 FROM screenshot_tags st WHERE st.screenshot_id=s.id AND st.tag_id=?)');
    params.push(parseInt(tag));
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const sortExpr    = sort === 'favorite'
    ? 's.favorite DESC, s.taken_at DESC'
    : `${sortCol} ${orderDir}`;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM screenshots s ${whereClause}`).get(...params).c;

  const rows = db.prepare(`
    SELECT
      s.id, s.file_name, s.taken_at, s.taken_at_parsed,
      s.favorite, s.thumbnail_generated, s.missing, s.file_size,
      (CASE WHEN s.memo != '' THEN 1 ELSE 0 END) AS has_memo,
      (SELECT GROUP_CONCAT(c.name, ',')
       FROM screenshot_categories sc JOIN categories c ON sc.category_id=c.id
       WHERE sc.screenshot_id=s.id) AS category_names,
      (SELECT GROUP_CONCAT(t.name, ',')
       FROM screenshot_tags st JOIN tags t ON st.tag_id=t.id
       WHERE st.screenshot_id=s.id) AS tag_names,
      (SELECT GROUP_CONCAT(c.id || '::' || c.name || '::' || COALESCE(c.color, '#7aa2f7'), '||')
       FROM screenshot_categories sc JOIN categories c ON sc.category_id=c.id
       WHERE sc.screenshot_id=s.id) AS categories_raw,
      (SELECT GROUP_CONCAT(t.id || '::' || t.name || '::' || COALESCE(t.color, '#9ece6a'), '||')
       FROM screenshot_tags st JOIN tags t ON st.tag_id=t.id
       WHERE st.screenshot_id=s.id) AS tags_raw
    FROM screenshots s
    ${whereClause}
    ORDER BY ${sortExpr}
    LIMIT ? OFFSET ?
  `).all(...params, limitNum, offset);

  function parseLabelRaw(raw) {
    if (!raw) return [];
    return raw.split('||').map(part => {
      const [id, name, color] = part.split('::');
      return {
        id: Number(id),
        name,
        color,
      };
    }).filter(x => Number.isInteger(x.id) && x.name);
  }

  res.json({
    total,
    page: parseInt(page),
    limit: limitNum,
    items: rows.map(r => {
      const categories = parseLabelRaw(r.categories_raw);
      const tags = parseLabelRaw(r.tags_raw);
      return {
        ...r,
        categories,
        tags,
        category_names: categories.length > 0 ? categories.map(c => c.name) : (r.category_names ? r.category_names.split(',') : []),
        tag_names: tags.length > 0 ? tags.map(t => t.name) : (r.tag_names ? r.tag_names.split(',') : []),
      };
    }),
  });
});

// ===== スクリーンショット詳細 =====

router.get('/screenshots/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const row = db.prepare(`
    SELECT s.*,
      (SELECT GROUP_CONCAT(c.id || '::' || c.name || '::' || COALESCE(c.color, '#7aa2f7'), '||')
       FROM screenshot_categories sc JOIN categories c ON sc.category_id=c.id
       WHERE sc.screenshot_id=s.id) AS categories_raw,
      (SELECT GROUP_CONCAT(t.id || '::' || t.name || '::' || COALESCE(t.color, '#9ece6a'), '||')
       FROM screenshot_tags st JOIN tags t ON st.tag_id=t.id
       WHERE st.screenshot_id=s.id) AS tags_raw
    FROM screenshots s WHERE s.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ error: 'not found' });

  const parse = (raw) => {
    if (!raw) return [];
    return raw.split('||').map(part => {
      const [id, name, color] = part.split('::');
      return { id: parseInt(id), name, color };
    });
  };

  const { categories_raw, tags_raw, ...rest } = row;
  res.json({ ...rest, categories: parse(categories_raw), tags: parse(tags_raw) });
});

// ===== 元画像配信（IDベース） =====

router.get('/image/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  try {
    const row = db.prepare(`
      SELECT
        s.id,
        s.file_path,
        s.file_name,
        s.source_id,
        s.missing,
        ms.path AS source_path,
        ms.enabled,
        ms.archived
      FROM screenshots s
      LEFT JOIN media_sources ms ON s.source_id = ms.id
      WHERE s.id = ?
    `).get(id);

    if (!row) {
      return res.status(404).json({ error: 'not found' });
    }

    if (row.missing) {
      return res.status(404).json({ error: 'file missing' });
    }

    // 紐づくメディアソースが存在しない場合
    if (!row.source_path) {
      logger.error(`[Image API Error] source_id ${row.source_id} に紐づく media_sources が見つかりません (Image ID: ${id})`);
      return res.status(404).json({ error: 'media source not found' });
    }

    // ソースが無効、またはアーカイブされている場合
    if (row.enabled === 0 || row.archived === 1) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // パスの解決
    let fullPath;
    if (row.file_path && path.isAbsolute(row.file_path)) {
      fullPath = row.file_path;
    } else {
      fullPath = path.join(row.source_path, row.file_path || row.file_name);
    }
    const normalized = path.resolve(fullPath);

    // パストラバーサル対策 (対象の source_path 配下かチェック)
    const srcResolved = path.resolve(row.source_path).toLowerCase();
    const imgResolved = normalized.toLowerCase();
    const isUnderSource = imgResolved.startsWith(srcResolved + path.sep) || imgResolved === srcResolved;

    if (!isUnderSource) {
      logger.error(`不正パスアクセス検出 (パストラバーサル防御): ${normalized} (Source: ${row.source_path})`);
      return res.status(403).json({ error: 'forbidden' });
    }

    // ディスク上の実体確認
    if (!fs.existsSync(normalized)) {
      logger.warn(`元画像が見つかりません: ${normalized}`);
      return res.status(404).json({ error: 'file not found on disk' });
    }

    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    const mime = mimeMap[path.extname(normalized).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(normalized).pipe(res);

  } catch (err) {
    console.error("[Image API Error]", {
      id: req.params.id,
      message: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'internal server error' });
  }
});

// ===== サムネイル配信 =====

router.get('/thumbnail/:id', async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  // media_sources を JOIN してソースの状態も確認
  const row = db.prepare(`
    SELECT
      s.id,
      s.thumbnail_path,
      s.thumbnail_generated,
      s.missing,
      s.source_id,
      ms.path AS source_path,
      ms.enabled,
      ms.archived
    FROM screenshots s
    LEFT JOIN media_sources ms ON s.source_id = ms.id
    WHERE s.id = ?
  `).get(id);

  if (!row)        return res.status(404).json({ error: 'not found' });
  if (row.missing) return res.status(404).json({ error: 'file missing' });

  // ソースが存在しない・無効・アーカイブ済み
  if (!row.source_path) {
    return res.status(404).json({ error: 'media source not found' });
  }
  if (row.enabled === 0 || row.archived === 1) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // キャッシュ済みサムネイルの配信
  if (row.thumbnail_generated === 1 && row.thumbnail_path) {
    const fileName = path.basename(row.thumbnail_path);
    const normalized = path.resolve(path.join(config.THUMBNAIL_DIR, fileName));
    const thumbDirResolved = path.resolve(config.THUMBNAIL_DIR);
    if (!normalized.toLowerCase().startsWith(thumbDirResolved.toLowerCase() + path.sep)) {
      logger.error(`不正サムネイルアクセス検出: ${row.thumbnail_path} (Resolved: ${normalized})`);
      return res.status(403).json({ error: 'forbidden' });
    }
    if (fs.existsSync(normalized)) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(normalized).pipe(res);
    }
    // ファイルが消えている場合はフラグをリセットして再生成へ進む
    db.prepare("UPDATE screenshots SET thumbnail_generated = 0, thumbnail_path = NULL WHERE id = ?").run(id);
  }

  // thumbnail_generated = 0（未生成）または -1（過去の失敗）もオンデマンド生成を試みる
  // generateThumbnail 内で media_sources を参照するため config.SOURCE_DIR 非依存
  const thumbPath = await generateThumbnail(id);
  if (!thumbPath) {
    return res.status(404).json({ error: 'thumbnail not found or generation failed' });
  }

  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(thumbPath).pipe(res);
});


// ===== スキャン =====

let scanJobId = null;

router.post('/rescan/start', (req, res) => {
  const { sourceId } = req.body;

  if (scanJobId && jobs.get(scanJobId)?.status === 'running') {
    return res.status(409).json({ error: 'スキャン実行中です', jobId: scanJobId });
  }

  const db = getDb();
  let targetSourcesCount = 0;
  if (sourceId) {
    targetSourcesCount = db.prepare(
      "SELECT COUNT(*) AS c FROM media_sources WHERE id = ? AND type = 'screenshot' AND enabled = 1 AND archived = 0"
    ).get(parseInt(sourceId)).c;
  } else {
    targetSourcesCount = db.prepare(
      "SELECT COUNT(*) AS c FROM media_sources WHERE type = 'screenshot' AND enabled = 1 AND archived = 0"
    ).get().c;
  }

  if (targetSourcesCount === 0) {
    return res.status(400).json({ error: 'スキャン対象が登録されていません。' });
  }

  const jobId = createJob('scan');
  scanJobId = jobId;
  res.json({ jobId });

  scan((event, data) => emitToJob(jobId, event, data), sourceId)
    .then(() => {
      runBackgroundGeneration().catch(err =>
        logger.error(`バックグラウンドサムネイル生成エラー: ${err.message}`)
      );
    })
    .catch(err => {
      emitToJob(jobId, 'error', { message: err.message });
      logger.error(`スキャンエラー: ${err.message}`);
    });
});

router.get('/rescan/events/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  job.logs.forEach(log => res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`));

  if (job.status !== 'running') {
    res.write(`event: ${job.status}\ndata: ${JSON.stringify(job.result ?? {})}\n\n`);
    return res.end();
  }

  job.clients.push(res);
  req.on('close', () => {
    job.clients = job.clients.filter(c => c !== res);
  });
});

// ===== お気に入り =====

router.post('/favorite', (req, res) => {
  const { id, value } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  getDb().prepare("UPDATE screenshots SET favorite = ?, updated_at = datetime('now') WHERE id = ?")
    .run(value ? 1 : 0, parseInt(id));
  res.json({ ok: true });
});

// ===== メモ =====

router.post('/memo', (req, res) => {
  const { id, memo } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  getDb().prepare("UPDATE screenshots SET memo = ?, updated_at = datetime('now') WHERE id = ?")
    .run(memo ?? '', parseInt(id));
  res.json({ ok: true });
});

// ===== カテゴリ =====

router.get('/categories', (req, res) => {
  const rows = getDb().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM screenshot_categories WHERE category_id=c.id) AS count
    FROM categories c ORDER BY c.name
  `).all();
  res.json(rows);
});

router.post('/categories', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const r = getDb().prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
    res.json({ id: r.lastInsertRowid, name: name.trim(), count: 0 });
  } catch {
    res.status(409).json({ error: '既に存在するカテゴリ名です' });
  }
});

router.post('/category', (req, res) => {
  const { screenshotId, categoryId, action } = req.body;
  if (!screenshotId || !categoryId) return res.status(400).json({ error: 'params required' });
  const db = getDb();
  if (action === 'remove') {
    db.prepare('DELETE FROM screenshot_categories WHERE screenshot_id=? AND category_id=?')
      .run(parseInt(screenshotId), parseInt(categoryId));
  } else {
    try {
      db.prepare('INSERT OR IGNORE INTO screenshot_categories (screenshot_id, category_id) VALUES (?,?)')
        .run(parseInt(screenshotId), parseInt(categoryId));
    } catch { /* UNIQUE制約違反は無視 */ }
  }
  res.json({ ok: true });
});

// ===== タグ =====

router.get('/tags', (req, res) => {
  const rows = getDb().prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM screenshot_tags WHERE tag_id=t.id) AS count
    FROM tags t ORDER BY t.name
  `).all();
  res.json(rows);
});

router.post('/tags', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const r = getDb().prepare('INSERT INTO tags (name) VALUES (?)').run(name.trim());
    res.json({ id: r.lastInsertRowid, name: name.trim(), count: 0 });
  } catch {
    res.status(409).json({ error: '既に存在するタグ名です' });
  }
});

router.post('/tag', (req, res) => {
  const { screenshotId, tagId, action } = req.body;
  if (!screenshotId || !tagId) return res.status(400).json({ error: 'params required' });
  const db = getDb();
  if (action === 'remove') {
    db.prepare('DELETE FROM screenshot_tags WHERE screenshot_id=? AND tag_id=?')
      .run(parseInt(screenshotId), parseInt(tagId));
  } else {
    try {
      db.prepare('INSERT OR IGNORE INTO screenshot_tags (screenshot_id, tag_id) VALUES (?,?)')
        .run(parseInt(screenshotId), parseInt(tagId));
    } catch { /* UNIQUE制約違反は無視 */ }
  }
  res.json({ ok: true });
});

// ===== カテゴリ 編集 / 削除 / usage =====

const PRESET_COLORS = new Set([
  '#7aa2f7','#9ece6a','#f7768e','#e0af68','#bb9af7','#7dcfff',
  '#2ac3de','#73daca','#41a6b5','#c0caf5','#a9b1d6','#9d7cd8',
  '#6d91de','#449dab','#b4f9f8','#394b70','#3d59a1','#1a1b26',
  '#ff9e64','#db4b4b','#f7768e','#ff007c','#c53b53','#914c54',
  '#e0af68','#d19a66','#d4a959','#cfc9c2','#b5c0d9','#acb0d0',
  '#6183bb','#516198','#2e3c64','#364a82','#0db9d7','#38bdf8',
]);

function validateNameColor(name, color, res) {
  const trimmed = (name ?? '').trim();
  if (!trimmed)           return res.status(400).json({ error: 'name は必須です' });
  if (trimmed.length > 50) return res.status(400).json({ error: 'name は50文字以内にしてください' });
  if (color !== undefined) {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: 'color は #RRGGBB 形式の6桁HEXで指定してください' });
    }
    if (!PRESET_COLORS.has(color)) {
      return res.status(400).json({ error: 'color はプリセット色の中から選択してください' });
    }
  }
  return null; // validation OK
}

// カテゴリ usage
router.get('/categories/:id/usage', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'invalid id' });
  const db  = getDb();
  const row = db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM screenshot_categories WHERE category_id = ?').get(id).c;
  res.json({ id: row.id, name: row.name, count });
});

// カテゴリ 編集
router.patch('/categories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'invalid id' });

  const validErr = validateNameColor(req.body.name, req.body.color, res);
  if (validErr !== null) return;

  const name  = req.body.name.trim();
  const color = req.body.color ?? null;
  const db    = getDb();

  const existing = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  try {
    if (color) {
      db.prepare("UPDATE categories SET name=?, color=?, updated_at=datetime('now') WHERE id=?").run(name, color, id);
    } else {
      db.prepare("UPDATE categories SET name=?, updated_at=datetime('now') WHERE id=?").run(name, id);
    }
    const updated = db.prepare('SELECT *, (SELECT COUNT(*) FROM screenshot_categories WHERE category_id=c.id) AS count FROM categories c WHERE c.id=?').get(id);
    res.json(updated);
  } catch {
    res.status(409).json({ error: '既に存在するカテゴリ名です' });
  }
});

// カテゴリ 削除（DBメタ情報のみ。画像ファイル本体には一切触れない）
router.delete('/categories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'invalid id' });
  const db = getDb();

  const existing = db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM screenshot_categories WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    db.exec('COMMIT');
    res.json({ ok: true, id, name: existing.name });
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`カテゴリ削除エラー: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// タグ usage
router.get('/tags/:id/usage', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'invalid id' });
  const db  = getDb();
  const row = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM screenshot_tags WHERE tag_id = ?').get(id).c;
  res.json({ id: row.id, name: row.name, count });
});

// タグ 編集
router.patch('/tags/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'invalid id' });

  const validErr = validateNameColor(req.body.name, req.body.color, res);
  if (validErr !== null) return;

  const name  = req.body.name.trim();
  const color = req.body.color ?? null;
  const db    = getDb();

  const existing = db.prepare('SELECT id FROM tags WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  try {
    if (color) {
      db.prepare("UPDATE tags SET name=?, color=?, updated_at=datetime('now') WHERE id=?").run(name, color, id);
    } else {
      db.prepare("UPDATE tags SET name=?, updated_at=datetime('now') WHERE id=?").run(name, id);
    }
    const updated = db.prepare('SELECT *, (SELECT COUNT(*) FROM screenshot_tags WHERE tag_id=t.id) AS count FROM tags t WHERE t.id=?').get(id);
    res.json(updated);
  } catch {
    res.status(409).json({ error: '既に存在するタグ名です' });
  }
});

// タグ 削除（DBメタ情報のみ。画像ファイル本体には一切触れない）
router.delete('/tags/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'invalid id' });
  const db = getDb();

  const existing = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM screenshot_tags WHERE tag_id = ?').run(id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    db.exec('COMMIT');
    res.json({ ok: true, id, name: existing.name });
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`タグ削除エラー: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ===== 日付一覧 =====

router.get('/dates', (req, res) => {
  const rows = getDb().prepare(`
    SELECT strftime('%Y-%m-%d', taken_at) AS date, COUNT(*) AS count
    FROM screenshots WHERE missing = 0
    GROUP BY date ORDER BY date DESC
  `).all();
  res.json(rows);
});

// ===== バックアップ =====

let backupJobId = null;

function isBackupDestSafe(srcPath, destPath) {
  if (!srcPath) return false;
  const src  = path.resolve(srcPath).toLowerCase();
  const dest = path.resolve(destPath).toLowerCase();
  if (dest === src) return false;
  if (dest.startsWith(src + path.sep)) return false;
  return true;
}

router.post('/backup/start', (req, res) => {
  const { dest } = req.body;
  if (!dest?.trim()) return res.status(400).json({ error: 'バックアップ先を指定してください' });
  if (!path.isAbsolute(dest)) return res.status(400).json({ error: '絶対パスで指定してください' });

  // 📁 動的ソースパス取得 (有効な最初のスクリーンショットソース)
  const db = getDb();
  const source = db.prepare("SELECT path FROM media_sources WHERE type = 'screenshot' AND enabled = 1 AND archived = 0 ORDER BY id ASC LIMIT 1").get();
  const sourceDir = source ? source.path : '';

  if (!sourceDir) {
    return res.status(400).json({ error: '有効な画像メディアソースが登録されていないため、バックアップを実行できません' });
  }

  if (!isBackupDestSafe(sourceDir, dest)) {
    return res.status(400).json({ error: 'バックアップ先をコピー元フォルダ内に指定することはできません' });
  }
  if (backupJobId && jobs.get(backupJobId)?.status === 'running') {
    return res.status(409).json({ error: 'バックアップ実行中です', jobId: backupJobId });
  }

  const jobId = createJob('backup');
  backupJobId = jobId;
  res.json({ jobId });

  const logPath = path.join(config.LOG_DIR, `backup-${Date.now()}.log`);

  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (err) {
    emitToJob(jobId, 'error', { message: `バックアップ先の作成に失敗しました: ${err.message}` });
    return;
  }

  const args = [
    sourceDir, dest,
    '*.png', '*.jpg', '*.jpeg', '*.webp',
    '*.PNG', '*.JPG', '*.JPEG', '*.WEBP',
    '/E', '/COPY:DAT', '/DCOPY:DAT',
    '/R:1', '/W:1', '/MT:16', '/XJ', '/NP',
    `/LOG:${logPath}`, '/TEE',
  ];

  logger.info(`バックアップ開始: ${config.SOURCE_DIR} -> ${dest}`);
  emitToJob(jobId, 'log', `バックアップ開始: ${config.SOURCE_DIR} → ${dest}`);

  const proc = spawn('robocopy', args, { windowsHide: true });

  proc.stdout.on('data', chunk => {
    chunk.toString('utf8').split('\n')
      .map(l => l.trim()).filter(Boolean)
      .forEach(line => emitToJob(jobId, 'log', line));
  });

  proc.stderr.on('data', chunk => {
    chunk.toString('utf8').split('\n')
      .map(l => l.trim()).filter(Boolean)
      .forEach(line => emitToJob(jobId, 'log', `[stderr] ${line}`));
  });

  proc.on('close', code => {
    // Robocopy: 終了コード 0-7 は正常
    const success = code !== null && code < 8;
    const msg = success
      ? `バックアップ完了 (終了コード: ${code})`
      : `バックアップ失敗 (終了コード: ${code})`;
    emitToJob(jobId, 'log', msg);
    emitToJob(jobId, 'finished', { success, code, logPath });
    logger.info(msg);
  });

  proc.on('error', err => {
    const msg = `Robocopy 実行エラー: ${err.message}`;
    emitToJob(jobId, 'error', { message: msg });
    logger.error(msg);
  });
});

router.get('/backup/events/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  job.logs.forEach(log => res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`));

  if (job.status !== 'running') {
    res.write(`event: ${job.status}\ndata: ${JSON.stringify(job.result ?? {})}\n\n`);
    return res.end();
  }

  job.clients.push(res);
  req.on('close', () => {
    job.clients = job.clients.filter(c => c !== res);
  });
});

router.get('/backup/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({ status: job.status, result: job.result });
});

// ===== 一括操作 =====

function toPositiveIntStrict(value) {
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

function normalizeIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'ids required' };
  }

  const normalized = [];
  for (const id of ids) {
    const n = toPositiveIntStrict(id);
    if (!n) return { error: 'ids must be positive integers' };
    normalized.push(n);
  }

  const unique = [...new Set(normalized)];
  if (unique.length > 1000) {
    return { error: 'ids limit exceeded' };
  }

  return { ids: unique };
}

// 一括お気に入り更新
router.post('/bulk/favorite', (req, res) => {
  const { ids: rawIds, favorite } = req.body;
  const validation = normalizeIds(rawIds);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const ids = validation.ids;

  if (typeof favorite !== 'boolean') return res.status(400).json({ error: 'favorite must be boolean' });

  const db    = getDb();
  const value = favorite ? 1 : 0;
  const stmt  = db.prepare("UPDATE screenshots SET favorite = ?, updated_at = datetime('now') WHERE id = ?");

  db.exec('BEGIN');
  try {
    ids.forEach(id => stmt.run(value, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`bulk/favorite エラー: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }

  res.json({ ok: true, count: ids.length });
});

// 一括カテゴリ操作
router.post('/bulk/category', (req, res) => {
  const { ids: rawIds, categoryId, action } = req.body;
  const validation = normalizeIds(rawIds);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const ids = validation.ids;

  const catId = toPositiveIntStrict(categoryId);
  if (!catId) return res.status(400).json({ error: 'categoryId must be a positive integer' });
  if (action !== 'add' && action !== 'remove') return res.status(400).json({ error: 'action must be add or remove' });

  const db   = getDb();
  const existingCat = db.prepare('SELECT id FROM categories WHERE id = ?').get(catId);
  if (!existingCat) return res.status(404).json({ error: 'category not found' });

  const addStmt    = db.prepare('INSERT OR IGNORE INTO screenshot_categories (screenshot_id, category_id) VALUES (?, ?)');
  const removeStmt = db.prepare('DELETE FROM screenshot_categories WHERE screenshot_id = ? AND category_id = ?');

  db.exec('BEGIN');
  try {
    ids.forEach(id => {
      if (action === 'add') addStmt.run(id, catId);
      else                  removeStmt.run(id, catId);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`bulk/category エラー: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }

  res.json({ ok: true, count: ids.length });
});

// 一括タグ操作
router.post('/bulk/tag', (req, res) => {
  const { ids: rawIds, tagId, action } = req.body;
  const validation = normalizeIds(rawIds);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const ids = validation.ids;

  const tId = toPositiveIntStrict(tagId);
  if (!tId) return res.status(400).json({ error: 'tagId must be a positive integer' });
  if (action !== 'add' && action !== 'remove') return res.status(400).json({ error: 'action must be add or remove' });

  const db   = getDb();
  const existingTag = db.prepare('SELECT id FROM tags WHERE id = ?').get(tId);
  if (!existingTag) return res.status(404).json({ error: 'tag not found' });

  const addStmt    = db.prepare('INSERT OR IGNORE INTO screenshot_tags (screenshot_id, tag_id) VALUES (?, ?)');
  const removeStmt = db.prepare('DELETE FROM screenshot_tags WHERE screenshot_id = ? AND tag_id = ?');

  db.exec('BEGIN');
  try {
    ids.forEach(id => {
      if (action === 'add') addStmt.run(id, tId);
      else                  removeStmt.run(id, tId);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`bulk/tag エラー: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }

  res.json({ ok: true, count: ids.length });
});

module.exports = router;
