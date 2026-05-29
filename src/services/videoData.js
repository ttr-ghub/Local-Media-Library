const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { getDb } = require('../db');

const SETTINGS_DB = path.join(config.DATA_DIR, 'settings.json');

const defaultSettings = {
  videoSourceDir: "",
  clipOutputDir: "",
  compressedOutputDir: "",
  ffmpegPath: "",
  deleteMode: "none",
  autoThumbnailGeneration: false
};

function readJsonFile(filePath, defaultData) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultData;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    logger.error(`Failed to read JSON file ${filePath}: ${err.message}`);
    return defaultData;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    logger.error(`Failed to write JSON file ${filePath}: ${err.message}`);
    return false;
  }
}

function getSettings() {
  return readJsonFile(SETTINGS_DB, defaultSettings);
}

function saveSettings(newSettings) {
  const current = getSettings();
  const merged = { ...current, ...newSettings };
  return writeJsonFile(SETTINGS_DB, merged);
}

// SQLite から動画一覧を取得する処理に差し替え
function getVideos() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM videos').all();
    
    // タグを紐付ける
    const videoTags = db.prepare(`
      SELECT vt.video_id, t.name
      FROM video_tags vt JOIN tags t ON vt.tag_id = t.id
    `).all();
    
    const tagMap = new Map();
    for (const vt of videoTags) {
      if (!tagMap.has(vt.video_id)) tagMap.set(vt.video_id, []);
      tagMap.get(vt.video_id).push(vt.name);
    }
    
    return rows.map(r => ({
      id: r.id,
      sourceId: r.source_id,
      filePath: r.file_path,
      fileName: r.file_name,
      size: r.file_size,
      duration: r.duration,
      thumbnailPath: r.thumbnail_path,
      status: r.status,
      memo: r.memo,
      isKeepOriginal: r.is_keep_original === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      tags: tagMap.get(r.id) || []
    }));
  } catch (err) {
    logger.error(`Failed to get videos from SQLite: ${err.message}`);
    return [];
  }
}

// SQLite に動画一覧を保存（全件上書きを模倣）する処理に差し替え
function saveVideos(videos) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM videos').run();
    
    const insertStmt = db.prepare(`
      INSERT INTO videos (id, source_id, file_path, file_name, file_size, duration, thumbnail_path, status, memo, is_keep_original, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertTagStmt = db.prepare(`
      INSERT OR IGNORE INTO tags (name, color) VALUES (?, '#9ece6a')
    `);
    
    const getTagIdStmt = db.prepare('SELECT id FROM tags WHERE name = ?');
    
    const insertVideoTagStmt = db.prepare(`
      INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)
    `);
    
    for (const v of videos) {
      insertStmt.run(
        v.id,
        v.sourceId || null,
        v.filePath,
        v.fileName,
        v.size || 0,
        v.duration || null,
        v.thumbnailPath || null,
        v.status || '未確認',
        v.memo || '',
        v.isKeepOriginal ? 1 : 0,
        v.createdAt || new Date().toISOString(),
        v.updatedAt || new Date().toISOString()
      );
      
      if (Array.isArray(v.tags)) {
        for (const tagName of v.tags) {
          const trimmed = tagName.trim();
          if (!trimmed) continue;
          insertTagStmt.run(trimmed);
          const tagRow = getTagIdStmt.get(trimmed);
          if (tagRow) {
            insertVideoTagStmt.run(v.id, tagRow.id);
          }
        }
      }
    }
    
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`Failed to save videos to SQLite: ${err.message}`);
    return false;
  }
}

// SQLite からクリップ一覧を取得する処理に差し替え
function getClips() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM clips').all();
    
    // タグを紐付ける
    const clipTags = db.prepare(`
      SELECT ct.clip_id, t.name
      FROM clip_tags ct JOIN tags t ON ct.tag_id = t.id
    `).all();
    
    const tagMap = new Map();
    for (const ct of clipTags) {
      if (!tagMap.has(ct.clip_id)) tagMap.set(ct.clip_id, []);
      tagMap.get(ct.clip_id).push(ct.name);
    }
    
    return rows.map(r => ({
      id: r.id,
      sourceVideoId: r.source_video_id,
      sourceVideoPath: r.source_video_path,
      clipPath: r.clip_path,
      fileName: r.file_name,
      startTime: r.start_time,
      endTime: r.end_time,
      duration: r.duration,
      size: r.file_size,
      memo: r.memo,
      favorite: r.favorite === 1,
      trimMode: r.trim_mode,
      createdAt: r.created_at,
      tags: tagMap.get(r.id) || []
    }));
  } catch (err) {
    logger.error(`Failed to get clips from SQLite: ${err.message}`);
    return [];
  }
}

// SQLite にクリップ一覧を保存（全件上書きを模倣）する処理に差し替え
function saveClips(clips) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM clips').run();
    
    const insertStmt = db.prepare(`
      INSERT INTO clips (id, source_video_id, source_video_path, clip_path, file_name, start_time, end_time, duration, file_size, memo, favorite, trim_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertTagStmt = db.prepare(`
      INSERT OR IGNORE INTO tags (name, color) VALUES (?, '#9ece6a')
    `);
    
    const getTagIdStmt = db.prepare('SELECT id FROM tags WHERE name = ?');
    
    const insertClipTagStmt = db.prepare(`
      INSERT OR IGNORE INTO clip_tags (clip_id, tag_id) VALUES (?, ?)
    `);
    
    for (const c of clips) {
      insertStmt.run(
        c.id,
        c.sourceVideoId || null,
        c.sourceVideoPath,
        c.clipPath,
        c.fileName,
        c.startTime || 0,
        c.endTime || 0,
        c.duration || 0,
        c.size || 0,
        c.memo || '',
        c.favorite ? 1 : 0,
        c.trimMode || 'fast',
        c.createdAt || new Date().toISOString()
      );
      
      if (Array.isArray(c.tags)) {
        for (const tagName of c.tags) {
          const trimmed = tagName.trim();
          if (!trimmed) continue;
          insertTagStmt.run(trimmed);
          const tagRow = getTagIdStmt.get(trimmed);
          if (tagRow) {
            insertClipTagStmt.run(c.id, tagRow.id);
          }
        }
      }
    }
    
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`Failed to save clips to SQLite: ${err.message}`);
    return false;
  }
}

function updateVideoStatus(videoId, status) {
  const data = getVideos();
  const video = data.find(v => v.id === videoId);
  if (video) {
    video.status = status;
    saveVideos(data);
    return true;
  }
  return false;
}

function updateClipInfo(clipId, updates) {
  const data = getClips();
  const clipIndex = data.findIndex(c => c.id === clipId);
  if (clipIndex !== -1) {
    const clip = data[clipIndex];
    if (updates.memo !== undefined) clip.memo = updates.memo;
    if (updates.tags !== undefined) clip.tags = updates.tags;
    if (updates.favorite !== undefined) clip.favorite = updates.favorite;
    saveClips(data);
    return true;
  }
  return false;
}

module.exports = {
  getVideos,
  saveVideos,
  getClips,
  saveClips,
  getSettings,
  saveSettings,
  updateVideoStatus,
  updateClipInfo
};
