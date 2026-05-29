const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { getDb } = require('./db');

const SCAN_CHUNK_SIZE = 500;

function waitImmediate() {
  return new Promise(resolve => setImmediate(resolve));
}

// ffxiv_YYYYMMDD_HHMMSS_*.ext から撮影日時を解析
function parseFilenameDate(filename) {
  const m = filename.match(/^ffxiv_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function isTargetFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return config.SCAN_EXTENSIONS.includes(ext);
}

/**
 * スキャン実行
 * @param {(event: string, data: any) => void} emit
 * @param {number} [sourceId] スキャン対象のメディアソースID
 */
async function scan(emit, sourceId) {
  const db = getDb();

  // スキャン対象のメディアソースを決定
  let targetSources;
  if (sourceId) {
    const row = db.prepare('SELECT * FROM media_sources WHERE id = ? AND type = \'screenshot\' AND enabled = 1 AND archived = 0').get(parseInt(sourceId));
    if (!row) {
      const msg = '有効なスキャン対象の画像フォルダが見つかりません。';
      emit('log', msg);
      emit('error', { message: msg });
      logger.error(msg);
      return { added: 0, updated: 0, missing: 0, total: 0 };
    }
    targetSources = [row];
  } else {
    // sourceId 未指定 → 有効かつ非アーカイブの screenshot ソースをすべてスキャン
    targetSources = db.prepare("SELECT * FROM media_sources WHERE type = 'screenshot' AND enabled = 1 AND archived = 0 ORDER BY id ASC").all();
  }

  if (targetSources.length === 0) {
    const msg = 'スキャン対象の画像フォルダが登録されていません。';
    emit('log', msg);
    emit('error', { message: msg });
    logger.error(msg);
    return { added: 0, updated: 0, missing: 0, total: 0 };
  }

  let totalAdded = 0;
  let totalUpdated = 0;
  let totalMissing = 0;
  let totalFiles = 0;

  for (const sourceRow of targetSources) {
    const result = await scanSource(emit, db, sourceRow);
    totalAdded   += result.added;
    totalUpdated += result.updated;
    totalMissing += result.missing;
    totalFiles   += result.total;
  }

  const msg = `スキャン完了（全ソース）: 新規 ${totalAdded}件, 更新 ${totalUpdated}件, 消失 ${totalMissing}件`;
  emit('log', msg);
  emit('finished', { added: totalAdded, updated: totalUpdated, missing: totalMissing, total: totalFiles });
  logger.info(msg);

  return { added: totalAdded, updated: totalUpdated, missing: totalMissing, total: totalFiles };
}

/**
 * 単一ソースのスキャン
 */
async function scanSource(emit, db, sourceRow) {
  const sourceDir = sourceRow.path;
  const targetSourceId = sourceRow.id;

  emit('log', `スキャン開始: ${sourceRow.name} (${sourceDir})`);
  logger.info(`スキャン開始: ${sourceRow.name} (${sourceDir})`);

  if (!fs.existsSync(sourceDir)) {
    const msg = `スキャン対象フォルダが見つかりません（スキップします）: ${sourceDir}`;
    emit('log', msg);
    logger.warn(msg);
    return { added: 0, updated: 0, missing: 0, total: 0 };
  }

  let files;
  try {
    files = fs.readdirSync(sourceDir);
  } catch (err) {
    const msg = `ディレクトリ読み取りエラー: ${err.message}`;
    emit('log', msg);
    logger.error(msg);
    return { added: 0, updated: 0, missing: 0, total: 0 };
  }

  const imageFiles = files.filter(isTargetFile);
  emit('log', `対象ファイル数: ${imageFiles.length} (${sourceRow.name})`);
  logger.info(`対象ファイル数: ${imageFiles.length}`);

  // このソースに属する既存レコードのみをマップ化
  const existingMap = new Map(
    db.prepare('SELECT id, file_path, file_size, modified_at, missing FROM screenshots WHERE source_id = ?').all(targetSourceId)
      .map(r => [r.file_path, r])
  );

  const currentPaths = new Set();

  const insertStmt = db.prepare(`
    INSERT INTO screenshots (file_path, file_name, taken_at, taken_at_parsed, file_size, modified_at, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE screenshots
    SET file_size = ?,
        modified_at = ?,
        missing = 0,
        thumbnail_generated = CASE WHEN ? = 1 THEN 0 ELSE thumbnail_generated END,
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const markNotMissingStmt = db.prepare(
    "UPDATE screenshots SET missing = 0, updated_at = datetime('now') WHERE id = ?"
  );

  let added = 0;
  let updated = 0;

  // 500件単位でチャンク処理
  for (let chunkStart = 0; chunkStart < imageFiles.length; chunkStart += SCAN_CHUNK_SIZE) {
    const chunk = imageFiles.slice(chunkStart, chunkStart + SCAN_CHUNK_SIZE);

    db.exec('BEGIN');
    try {
      for (const filename of chunk) {
        const filePath = path.join(sourceDir, filename);
        currentPaths.add(filePath);

        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch (err) {
          logger.warn(`ファイル stat 失敗: ${filePath} - ${err.message}`);
          continue;
        }

        const fileSize     = stat.size;
        const modifiedAt   = stat.mtime.toISOString();
        const parsedDate   = parseFilenameDate(filename);
        const takenAt      = parsedDate ?? modifiedAt;
        const takenAtParsed = parsedDate ? 1 : 0;

        const existing = existingMap.get(filePath);
        if (!existing) {
          insertStmt.run(filePath, filename, takenAt, takenAtParsed, fileSize, modifiedAt, targetSourceId);
          added++;
        } else {
          const changed = (existing.file_size !== fileSize || existing.modified_at !== modifiedAt) ? 1 : 0;
          if (changed) {
            updateStmt.run(fileSize, modifiedAt, changed, existing.id);
            updated++;
          }
          if (existing.missing === 1) {
            markNotMissingStmt.run(existing.id);
          }
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      const msg = `スキャン中にDBエラー (チャンク ${chunkStart}〜${chunkStart + chunk.length - 1}): ${err.message}`;
      emit('log', msg);
      logger.error(msg);
      throw err;
    }

    const processed = Math.min(chunkStart + chunk.length, imageFiles.length);
    emit('progress', { processed, total: imageFiles.length, added, updated });

    // イベントループを解放してSSEやログ送信を処理させる
    await waitImmediate();
  }

  // missing 処理（DBにあってファイルが消えたもの）
  const markMissingStmt = db.prepare(
    "UPDATE screenshots SET missing = 1, updated_at = datetime('now') WHERE id = ?"
  );
  const missingIds = [...existingMap.values()]
    .filter(r => !currentPaths.has(r.file_path))
    .map(r => r.id);

  if (missingIds.length > 0) {
    db.exec('BEGIN');
    try {
      missingIds.forEach(id => markMissingStmt.run(id));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      logger.error(`missing 更新エラー: ${err.message}`);
    }
  }

  const msg = `${sourceRow.name}: 新規 ${added}件, 更新 ${updated}件, 消失 ${missingIds.length}件`;
  emit('log', msg);
  logger.info(msg);

  return { added, updated, missing: missingIds.length, total: imageFiles.length };
}

module.exports = { scan };
