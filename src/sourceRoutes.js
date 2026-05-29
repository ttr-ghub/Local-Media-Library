const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const logger = require('./logger');

const router = express.Router();

// メディアソース一覧取得
router.get('/', (req, res) => {
  const includeArchived = req.query.include_archived === 'true';
  const db = getDb();
  
  try {
    let rows;
    if (includeArchived) {
      rows = db.prepare('SELECT * FROM media_sources ORDER BY id ASC').all();
    } else {
      rows = db.prepare('SELECT * FROM media_sources WHERE archived = 0 ORDER BY id ASC').all();
    }
    res.json(rows);
  } catch (err) {
    logger.error(`Failed to get media sources: ${err.message}`);
    res.status(500).json({ error: 'Failed to retrieve media sources' });
  }
});

// 新規メディアソース登録
router.post('/', (req, res) => {
  const { name, type, path: sourcePath } = req.body;
  
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '表示名（name）は必須です' });
  }
  if (type !== 'screenshot' && type !== 'video') {
    return res.status(400).json({ error: '種類（type）は screenshot または video を指定してください' });
  }
  if (!sourcePath || !sourcePath.trim()) {
    return res.status(400).json({ error: 'ディレクトリパス（path）は必須です' });
  }

  const trimmedPath = sourcePath.trim();

  // 絶対パスチェック
  if (!path.isAbsolute(trimmedPath)) {
    return res.status(400).json({ error: '絶対パスで指定してください' });
  }

  // ディレクトリの実在チェック
  if (!fs.existsSync(trimmedPath)) {
    return res.status(400).json({ error: '指定されたディレクトリパスが存在しません' });
  }

  try {
    const stat = fs.statSync(trimmedPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: '指定されたパスはディレクトリではありません' });
    }
  } catch (err) {
    return res.status(400).json({ error: `ディレクトリの確認に失敗しました: ${err.message}` });
  }

  const db = getDb();
  
  try {
    // 重複チェック (path + type でチェック)
    const existing = db.prepare('SELECT id, archived FROM media_sources WHERE path = ? AND type = ?').get(trimmedPath, type);
    if (existing) {
      if (existing.archived === 1) {
        return res.status(409).json({
          error: '既に登録解除済みの同一ソースが存在します。復元して再利用してください。',
          archivedSourceId: existing.id
        });
      } else {
        return res.status(409).json({ error: 'このディレクトリパスは同じ種別で既に登録されています' });
      }
    }

    const stmt = db.prepare(`
      INSERT INTO media_sources (name, type, path, enabled, archived)
      VALUES (?, ?, ?, 1, 0)
    `);
    const info = stmt.run(name.trim(), type, trimmedPath);
    
    const newSource = db.prepare('SELECT * FROM media_sources WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(newSource);
  } catch (err) {
    logger.error(`Failed to register media source: ${err.message}`);
    res.status(500).json({ error: 'メディアソースの登録に失敗しました' });
  }
});

// メディアソース情報更新（有効/無効、アーカイブ化など）
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const { name, enabled, archived, path: sourcePath, type } = req.body;
  
  // 🔒 安全要件: path または type の変更は 400 Bad Request
  if (sourcePath !== undefined || type !== undefined) {
    return res.status(400).json({ error: 'ディレクトリパス(path)およびメディア種別(type)の変更は許可されていません。変更したい場合は一度アーカイブして新規登録してください。' });
  }

  const db = getDb();

  try {
    const existing = db.prepare('SELECT * FROM media_sources WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Media source not found' });
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: '表示名は必須です' });
      updates.push('name = ?');
      params.push(name.trim());
    }

    if (enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }

    if (archived !== undefined) {
      updates.push('archived = ?');
      params.push(archived ? 1 : 0);
      if (archived) {
        // アーカイブ化する時は自動的に無効化する
        updates.push('enabled = 0');
      }
    }

    if (updates.length === 0) {
      return res.json(existing);
    }

    updates.push("updated_at = datetime('now')");
    const sql = `UPDATE media_sources SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...params, id);

    const updated = db.prepare('SELECT * FROM media_sources WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    logger.error(`Failed to update media source: ${err.message}`);
    res.status(500).json({ error: 'Failed to update media source' });
  }
});

// メディアソース登録解除（🔒 安全最優先要件：論理削除 / アーカイブ）
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id < 1) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const db = getDb();

  try {
    const existing = db.prepare('SELECT * FROM media_sources WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Media source not found' });
    }

    // 🔒 物理削除や実ファイル・サムネイルキャッシュの削除は一切行わない
    // 単に archived = 1, enabled = 0 に更新（論理削除）
    db.prepare("UPDATE media_sources SET archived = 1, enabled = 0, updated_at = datetime('now') WHERE id = ?")
      .run(id);

    res.json({ success: true, message: 'Media source archived successfully (no data or files were deleted)', id });
  } catch (err) {
    logger.error(`Failed to archive media source: ${err.message}`);
    res.status(500).json({ error: 'Failed to archive media source' });
  }
});

module.exports = router;
