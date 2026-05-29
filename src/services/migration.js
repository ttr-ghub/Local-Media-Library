const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

/**
 * 現在日時からフォーマットされたタイムスタンプ文字列(YYYYMMDD_HHMMSS)を取得
 * @returns {string}
 */
function getFormattedTimestamp() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

/**
 * 既存の JSON データから SQLite データベースへの移行処理を実行
 * @param {DatabaseSync} db node:sqlite のデータベースインスタンス
 */
function runMigration(db) {
  // media_sources が空かチェック
  const sourceCount = db.prepare('SELECT COUNT(*) AS c FROM media_sources').get().c;
  if (sourceCount > 0) {
    logger.info('[Migration] すでに初期登録（または移行）済みのため、マイグレーションをスキップします。');
    return;
  }

  logger.info('[Migration] 移行処理を開始します...');

  // タイムスタンプの取得とバックアップ用フォルダの作成
  const timestamp = getFormattedTimestamp();
  const backupDir = path.join(config.DATA_DIR, 'migration_backup', timestamp);
  
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    logger.info(`[Migration] 世代バックアップディレクトリを作成しました: ${backupDir}`);
  } catch (err) {
    logger.error(`[Migration] バックアップディレクトリの作成に失敗しました: ${err.message}`);
    throw err;
  }

  // 既存の動画設定（settings.json）から動画読み込み元ディレクトリを読み込む
  let videoSourceDir = '';
  const settingsPath = path.join(config.DATA_DIR, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      videoSourceDir = settings.videoSourceDir || '';
    } catch (err) {
      logger.error(`[Migration] settings.json の読み込みに失敗しました: ${err.message}`);
    }
  }

  // 移行元ファイルパス
  const videosPath = path.join(config.DATA_DIR, 'videos.json');
  const clipsPath = path.join(config.DATA_DIR, 'clips.json');
  const dbPath = config.DB_PATH;

  // 1. 移行前に世代バックアップへ全関連データを物理コピー (screenshots.db, videos.json, clips.json)
  logger.info('[Migration] 移行前データの世代バックアップコピーを開始します...');
  
  try {
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, path.join(backupDir, 'screenshots.db'));
      logger.info('[Migration] screenshots.db をバックアップフォルダにコピーしました');
    }
    if (fs.existsSync(videosPath)) {
      fs.copyFileSync(videosPath, path.join(backupDir, 'videos.json'));
      logger.info('[Migration] videos.json をバックアップフォルダにコピーしました');
    }
    if (fs.existsSync(clipsPath)) {
      fs.copyFileSync(clipsPath, path.join(backupDir, 'clips.json'));
      logger.info('[Migration] clips.json をバックアップフォルダにコピーしました');
    }
  } catch (err) {
    logger.error(`[Migration] 移行前バックアップコピー中にエラーが発生しました: ${err.message}`);
    throw err;
  }

  let ssCount = 0;
  let videoMigratedCount = 0;
  let clipMigratedCount = 0;
  const sourcesCreated = [];

  db.exec('BEGIN');
  try {
    // デフォルトのメディアソースを登録
    const insertSourceStmt = db.prepare(`
      INSERT INTO media_sources (name, type, path, enabled, archived)
      VALUES (?, ?, ?, 1, 0)
    `);

    // 静止画（画像）ソース
    const ssSourcePath = config.SOURCE_DIR;
    let ssSourceId = null;
    if (ssSourcePath && fs.existsSync(ssSourcePath) && fs.statSync(ssSourcePath).isDirectory()) {
      insertSourceStmt.run('Default Screenshots', 'screenshot', ssSourcePath);
      ssSourceId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      sourcesCreated.push({ name: 'Default Screenshots', type: 'screenshot', path: ssSourcePath, id: ssSourceId });
      logger.info(`[Migration] デフォルト画像ソースを登録しました: ${ssSourcePath} (ID: ${ssSourceId})`);
    } else {
      logger.info('[Migration] config.SOURCE_DIR が未設定または存在しないため、デフォルト画像ソースの登録をスキップしました。');
    }

    // 動画ソース
    let videoSourceId = null;
    if (videoSourceDir && fs.existsSync(videoSourceDir) && fs.statSync(videoSourceDir).isDirectory()) {
      insertSourceStmt.run('Default Videos', 'video', videoSourceDir);
      videoSourceId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      sourcesCreated.push({ name: 'Default Videos', type: 'video', path: videoSourceDir, id: videoSourceId });
      logger.info(`[Migration] デフォルト動画ソースを登録しました: ${videoSourceDir} (ID: ${videoSourceId})`);
    } else {
      logger.info('[Migration] settings.json 内の videoSourceDir が未設定または存在しないため、デフォルト動画ソースの登録をスキップしました。');
    }

    // 既存の全 screenshots の source_id を更新
    if (ssSourceId) {
      const ssResult = db.prepare('UPDATE screenshots SET source_id = ? WHERE source_id IS NULL').run(ssSourceId);
      ssCount = ssResult.changes;
      logger.info(`[Migration] 既存スクリーンショット ${ssCount}件 の source_id を更新しました`);
    }

    // videos.json からの移行
    if (fs.existsSync(videosPath) && videoSourceId) {
      const videosData = JSON.parse(fs.readFileSync(videosPath, 'utf-8'));
      logger.info(`[Migration] videos.json から ${videosData.length}件 のデータを移行します...`);

      const insertVideoStmt = db.prepare(`
        INSERT OR IGNORE INTO videos (id, source_id, file_path, file_name, file_size, duration, thumbnail_path, status, memo, is_keep_original, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertTagStmt = db.prepare(`
        INSERT OR IGNORE INTO tags (name, color) VALUES (?, '#9ece6a')
      `);

      const getTagIdStmt = db.prepare('SELECT id FROM tags WHERE name = ?');

      const insertVideoTagStmt = db.prepare(`
        INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)
      `);

      for (const v of videosData) {
        const vResult = insertVideoStmt.run(
          v.id,
          videoSourceId,
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

        if (vResult.changes > 0) {
          videoMigratedCount++;
        }

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
    }

    // clips.json からの移行
    if (fs.existsSync(clipsPath)) {
      const clipsData = JSON.parse(fs.readFileSync(clipsPath, 'utf-8'));
      logger.info(`[Migration] clips.json から ${clipsData.length}件 のデータを移行します...`);

      const insertClipStmt = db.prepare(`
        INSERT OR IGNORE INTO clips (id, source_video_id, source_video_path, clip_path, file_name, start_time, end_time, duration, file_size, memo, favorite, trim_mode, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertTagStmt = db.prepare(`
        INSERT OR IGNORE INTO tags (name, color) VALUES (?, '#9ece6a')
      `);

      const getTagIdStmt = db.prepare('SELECT id FROM tags WHERE name = ?');

      const insertClipTagStmt = db.prepare(`
        INSERT OR IGNORE INTO clip_tags (clip_id, tag_id) VALUES (?, ?)
      `);

      const checkVideoStmt = db.prepare('SELECT id FROM videos WHERE id = ?');

      for (const c of clipsData) {
        let parentVideoId = c.sourceVideoId || null;
        if (parentVideoId) {
          const parentExists = checkVideoStmt.get(parentVideoId);
          if (!parentExists) {
            logger.warn(`[Migration Warning] クリップ ${c.id} の親動画 ${parentVideoId} が存在しないため、紐付けを解除(null)して移行します。`);
            parentVideoId = null;
          }
        }

        const cResult = insertClipStmt.run(
          c.id,
          parentVideoId,
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

        if (cResult.changes > 0) {
          clipMigratedCount++;
        }

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
    }

    db.exec('COMMIT');
    logger.info('[Migration] SQLite へのデータ移行が正常にコミットされました！');

    // 2. 移行結果の構造化ログ migration_log.json をバックアップフォルダに保存
    const migrationLog = {
      timestamp: new Date().toISOString(),
      formatted_timestamp: timestamp,
      sources_created: sourcesCreated,
      screenshots_updated_count: ssCount,
      videos_migrated_count: videoMigratedCount,
      clips_migrated_count: clipMigratedCount,
      status: 'success'
    };

    try {
      fs.writeFileSync(
        path.join(backupDir, 'migration_log.json'),
        JSON.stringify(migrationLog, null, 2),
        'utf-8'
      );
      logger.info('[Migration] migration_log.json を世代バックアップに保存しました');
    } catch (err) {
      logger.error(`[Migration Warning] migration_log.json の出力に失敗しました: ${err.message}`);
    }

    // 3. 元の JSON ファイルを退避（既存の .bak は上書きせず、必要なら日時付きで退避）
    if (fs.existsSync(videosPath)) {
      const videosBakPath = `${videosPath}.bak`;
      if (fs.existsSync(videosBakPath)) {
        const uniqueBakPath = `${videosPath}.${timestamp}.bak`;
        fs.renameSync(videosPath, uniqueBakPath);
        logger.info(`[Migration] 既存の videos.json.bak が存在するため、videos.json を ${path.basename(uniqueBakPath)} に退避しました`);
      } else {
        fs.renameSync(videosPath, videosBakPath);
        logger.info('[Migration] videos.json を videos.json.bak に退避しました');
      }
    }

    if (fs.existsSync(clipsPath)) {
      const clipsBakPath = `${clipsPath}.bak`;
      if (fs.existsSync(clipsBakPath)) {
        const uniqueBakPath = `${clipsPath}.${timestamp}.bak`;
        fs.renameSync(clipsPath, uniqueBakPath);
        logger.info(`[Migration] 既存の clips.json.bak が存在するため、clips.json を ${path.basename(uniqueBakPath)} に退避しました`);
      } else {
        fs.renameSync(clipsPath, clipsBakPath);
        logger.info('[Migration] clips.json を clips.json.bak に退避しました');
      }
    }

  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`[Migration] 移行中にエラーが発生したためロールバックしました: ${err.message}`);
    
    // 移行失敗時のログをバックアップフォルダに書き込む
    try {
      const errorLog = {
        timestamp: new Date().toISOString(),
        formatted_timestamp: timestamp,
        status: 'failed',
        error: err.message
      };
      fs.writeFileSync(
        path.join(backupDir, 'migration_log.json'),
        JSON.stringify(errorLog, null, 2),
        'utf-8'
      );
    } catch (writeErr) {
      // ログ書き込み自体が失敗した場合は無視
    }
    throw err;
  }
}

module.exports = { runMigration };
