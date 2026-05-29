const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const logger = require('./logger');
const { getDb } = require('./db');

const generating = new Set();

/**
 * source_path 配下に対象パスが含まれるかを安全に判定する
 * startsWith 単体は separator の境界で誤判定するため path.relative を使う
 */
function isInsideSource(sourceRoot, targetPath) {
  const rel = path.relative(sourceRoot, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * スクリーンショットIDからサムネイルを生成する
 * media_sources に JOIN してパスを解決するため、config.SOURCE_DIR に依存しない
 *
 * @param {number} screenshotId
 * @returns {string|null} 生成したサムネイルの絶対パス。失敗時は null
 */
async function generateThumbnail(screenshotId) {
  if (generating.has(screenshotId)) return null;
  generating.add(screenshotId);

  const db = getDb();

  // media_sources を JOIN して元画像パスとソースパスを取得
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
    WHERE s.id = ? AND s.missing = 0
  `).get(screenshotId);

  if (!row) {
    generating.delete(screenshotId);
    return null;
  }

  // ソースが存在しない・無効・アーカイブ済みの場合はスキップ（DB更新なし）
  if (!row.source_path || row.enabled === 0 || row.archived === 1) {
    logger.warn(`サムネイル生成スキップ: ソース無効または未登録 (ID: ${screenshotId})`);
    generating.delete(screenshotId);
    return null;
  }

  // 元画像パスの解決
  let fullPath;
  if (row.file_path && path.isAbsolute(row.file_path)) {
    fullPath = row.file_path;
  } else {
    fullPath = path.join(row.source_path, row.file_path || row.file_name);
  }
  const normalized = path.resolve(fullPath);
  const sourceRoot  = path.resolve(row.source_path);

  // パストラバーサル防御
  if (!isInsideSource(sourceRoot, normalized)) {
    logger.error(`不正画像パス検出（サムネイル生成拒否）: ${normalized}`);
    db.prepare("UPDATE screenshots SET thumbnail_generated = -1, updated_at = datetime('now') WHERE id = ?").run(screenshotId);
    generating.delete(screenshotId);
    return null;
  }

  // 元画像の実在確認
  if (!fs.existsSync(normalized)) {
    logger.warn(`元画像が見つかりません（サムネイル生成スキップ）: ${normalized}`);
    generating.delete(screenshotId);
    return null;
  }

  const thumbPath = path.join(config.THUMBNAIL_DIR, `${screenshotId}.webp`);

  try {
    fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });

    await sharp(normalized)
      .resize({
        width: config.THUMBNAIL_MAX_SIZE,
        height: config.THUMBNAIL_MAX_SIZE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: config.THUMBNAIL_QUALITY })
      .toFile(thumbPath);

    const thumbFileName = `${screenshotId}.webp`;
    db.prepare(
      "UPDATE screenshots SET thumbnail_path = ?, thumbnail_generated = 1, updated_at = datetime('now') WHERE id = ?"
    ).run(thumbFileName, screenshotId);

    logger.info(`サムネイル生成: ${row.file_name} (ID: ${screenshotId})`);
    generating.delete(screenshotId);
    return thumbPath;
  } catch (err) {
    db.prepare(
      "UPDATE screenshots SET thumbnail_generated = -1, updated_at = datetime('now') WHERE id = ?"
    ).run(screenshotId);
    logger.error(`サムネイル生成失敗: ${row.file_name} (ID: ${screenshotId}) - ${err.message}`);
    generating.delete(screenshotId);
    return null;
  }
}

let bgRunning = false;

async function runBackgroundGeneration() {
  if (bgRunning) return;
  bgRunning = true;
  logger.info('バックグラウンドサムネイル生成 開始');

  const db = getDb();
  const BATCH = 50;

  try {
    while (true) {
      // thumbnail_generated = 0（未生成）のみ対象。-1（失敗済み）は含めない
      const rows = db.prepare(`
        SELECT id FROM screenshots
        WHERE thumbnail_generated = 0 AND missing = 0
        LIMIT ?
      `).all(BATCH);

      if (rows.length === 0) break;

      for (let i = 0; i < rows.length; i += config.THUMBNAIL_CONCURRENCY) {
        const chunk = rows.slice(i, i + config.THUMBNAIL_CONCURRENCY);
        await Promise.all(chunk.map(r => generateThumbnail(r.id)));
        await new Promise(r => setTimeout(r, 20));
      }
    }
  } finally {
    bgRunning = false;
    logger.info('バックグラウンドサムネイル生成 完了');
  }
}

module.exports = { generateThumbnail, runBackgroundGeneration };
