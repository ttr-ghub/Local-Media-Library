// Node.js v22.5.0+ 組み込みの node:sqlite を使用（ネイティブビルド不要）
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');
const migration = require('./services/migration');

let db;

function getDb() {
  if (!db) throw new Error('DB が初期化されていません');
  return db;
}

function initDb() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });
  fs.mkdirSync(config.LOG_DIR, { recursive: true });

  db = new DatabaseSync(config.DB_PATH);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // 一意制約のマイグレーション（UNIQUE(path) -> UNIQUE(path, type)）が必要かチェック
  try {
    const tableSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='media_sources'").get()?.sql || '';
    if (tableSchema.includes('UNIQUE(path)') || tableSchema.includes('UNIQUE (path)') || tableSchema.includes('path        TEXT NOT NULL UNIQUE') || tableSchema.includes('path TEXT NOT NULL UNIQUE')) {
      logger.info('[Migration] media_sources 一意制約の UNIQUE(path, type) への移行を開始します');

      // 移行前の検証用データを取得
      let beforeSources = [];
      let beforeSsCount = 0;
      let beforeFavCount = 0;
      let beforeMemoCount = 0;
      let beforeCatCount = 0;
      let beforeTagCount = 0;
      try {
        beforeSources = db.prepare('SELECT id, name, type, path FROM media_sources').all();
        beforeSsCount = db.prepare('SELECT COUNT(*) AS c FROM screenshots').get()?.c || 0;
        beforeFavCount = db.prepare('SELECT COUNT(*) AS c FROM screenshots WHERE favorite = 1').get()?.c || 0;
        beforeMemoCount = db.prepare("SELECT COUNT(*) AS c FROM screenshots WHERE memo != ''").get()?.c || 0;
        
        // category/tagの紐付け数
        const hasCategoriesTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='screenshot_categories'").get();
        if (hasCategoriesTable) {
          beforeCatCount = db.prepare('SELECT COUNT(*) AS c FROM screenshot_categories').get()?.c || 0;
        }
        const hasTagsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='screenshot_tags'").get();
        if (hasTagsTable) {
          beforeTagCount = db.prepare('SELECT COUNT(*) AS c FROM screenshot_tags').get()?.c || 0;
        }
      } catch (e) {
        logger.warn(`[Migration Pre-check] 統計データの事前取得中に警告が発生しました (新規作成の場合は正常): ${e.message}`);
      }

      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS media_sources_new (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL,
            path        TEXT NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            archived    INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(path, type)
          );
        `);
        db.exec('INSERT INTO media_sources_new SELECT id, name, type, path, enabled, archived, created_at, updated_at FROM media_sources');
        db.exec('DROP TABLE media_sources');
        db.exec('ALTER TABLE media_sources_new RENAME TO media_sources');
        db.exec('COMMIT');
        logger.info('[Migration] media_sources 一意制約の UNIQUE(path, type) への移行が正常に完了しました');
      } catch (err) {
        db.exec('ROLLBACK');
        logger.error(`[Migration Error] 一意制約の移行に失敗しました: ${err.message}`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }

      // 整合性チェック
      try {
        // 1. PRAGMA foreign_key_check
        const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
        if (fkCheck.length > 0) {
          logger.error('[Migration Integrity Alert] 参照整合性エラーを検出しました (PRAGMA foreign_key_check: NG):', fkCheck);
        } else {
          logger.info('[Migration Integrity Check] データベース参照整合性チェックに合格しました (PRAGMA foreign_key_check: OK)');
        }

        // 2. media_sources の id が維持されていることの確認
        const afterSources = db.prepare('SELECT id, name, type, path FROM media_sources').all();
        const beforeIds = beforeSources.map(s => s.id).sort();
        const afterIds = afterSources.map(s => s.id).sort();
        const idsMatch = JSON.stringify(beforeIds) === JSON.stringify(afterIds);
        if (idsMatch) {
          logger.info('[Migration Integrity Check] media_sources の ID 整合性チェックに合格しました (すべてのソースIDが維持されています)');
        } else {
          logger.error('[Migration Integrity Alert] media_sources の ID が一致しません！');
        }

        // 3. media_sources に重複した path + type が作られていないことの確認
        const dupCheck = db.prepare('SELECT path, type, COUNT(*) as cnt FROM media_sources GROUP BY path, type HAVING cnt > 1').all();
        if (dupCheck.length === 0) {
          logger.info('[Migration Integrity Check] 重複 path + type の非存在チェックに合格しました');
        } else {
          logger.error('[Migration Integrity Alert] 重複した path + type を検出しました！:', dupCheck);
        }

        // 4. screenshots.source_id / videos.source_id の参照壊れ確認およびメタデータ件数チェック
        const afterSsCount = db.prepare('SELECT COUNT(*) AS c FROM screenshots').get()?.c || 0;
        const afterFavCount = db.prepare('SELECT COUNT(*) AS c FROM screenshots WHERE favorite = 1').get()?.c || 0;
        const afterMemoCount = db.prepare("SELECT COUNT(*) AS c FROM screenshots WHERE memo != ''").get()?.c || 0;
        
        let afterCatCount = 0;
        const hasCategoriesTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='screenshot_categories'").get();
        if (hasCategoriesTable) {
          afterCatCount = db.prepare('SELECT COUNT(*) AS c FROM screenshot_categories').get()?.c || 0;
        }
        
        let afterTagCount = 0;
        const hasTagsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='screenshot_tags'").get();
        if (hasTagsTable) {
          afterTagCount = db.prepare('SELECT COUNT(*) AS c FROM screenshot_tags').get()?.c || 0;
        }

        if (beforeSsCount === afterSsCount) {
          logger.info(`[Migration Integrity Check] 画像レコード数チェックに合格しました (総件数: ${afterSsCount}件)`);
        } else {
          logger.error(`[Migration Integrity Alert] 画像レコード数が一致しません！ 前: ${beforeSsCount}, 後: ${afterSsCount}`);
        }

        if (beforeFavCount === afterFavCount && beforeMemoCount === afterMemoCount) {
          logger.info('[Migration Integrity Check] お気に入り/メモの整合性チェックに合格しました');
        } else {
          logger.error(`[Migration Integrity Alert] お気に入り/メモ件数が一致しません！ お気に入り(前/後): ${beforeFavCount}/${afterFavCount}, メモ(前/後): ${beforeMemoCount}/${afterMemoCount}`);
        }

        if (beforeCatCount === afterCatCount && beforeTagCount === afterTagCount) {
          logger.info('[Migration Integrity Check] カテゴリ/タグ紐付け件数チェックに合格しました');
        } else {
          logger.error(`[Migration Integrity Alert] カテゴリ/タグ紐付け件数が一致しません！ カテゴリ(前/後): ${beforeCatCount}/${afterCatCount}, タグ(前/後): ${beforeTagCount}/${afterTagCount}`);
        }
      } catch (err) {
        logger.error(`[Migration Integrity Check Error] 整合性チェック中にエラーが発生しました: ${err.message}`);
      }
    }
  } catch (err) {
    logger.warn(`[Migration Check Skip] 既存の media_sources テーブルが存在しないか確認をスキップしました: ${err.message}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS media_sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL, -- 'screenshot' | 'video'
      path        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      archived    INTEGER NOT NULL DEFAULT 0, -- 1:アーカイブ済み（登録解除） / 0:通常
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(path, type)
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path           TEXT    NOT NULL UNIQUE,
      file_name           TEXT    NOT NULL,
      taken_at            TEXT,
      taken_at_parsed     INTEGER NOT NULL DEFAULT 1,
      file_size           INTEGER,
      modified_at         TEXT,
      thumbnail_path      TEXT,
      thumbnail_generated INTEGER NOT NULL DEFAULT 0,
      missing             INTEGER NOT NULL DEFAULT 0,
      favorite            INTEGER NOT NULL DEFAULT 0,
      memo                TEXT    NOT NULL DEFAULT '',
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      source_id           INTEGER REFERENCES media_sources(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ss_taken_at    ON screenshots(taken_at);
    CREATE INDEX IF NOT EXISTS idx_ss_favorite    ON screenshots(favorite);
    CREATE INDEX IF NOT EXISTS idx_ss_file_name   ON screenshots(file_name);
    CREATE INDEX IF NOT EXISTS idx_ss_modified_at ON screenshots(modified_at);
    CREATE INDEX IF NOT EXISTS idx_ss_missing     ON screenshots(missing);

    CREATE TABLE IF NOT EXISTS categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cat_name ON categories(name);

    CREATE TABLE IF NOT EXISTS screenshot_categories (
      screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
      category_id   INTEGER NOT NULL REFERENCES categories(id)  ON DELETE CASCADE,
      PRIMARY KEY (screenshot_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tag_name ON tags(name);

    CREATE TABLE IF NOT EXISTS screenshot_tags (
      screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
      tag_id        INTEGER NOT NULL REFERENCES tags(id)        ON DELETE CASCADE,
      PRIMARY KEY (screenshot_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS videos (
      id                  TEXT PRIMARY KEY,
      source_id           INTEGER REFERENCES media_sources(id) ON DELETE SET NULL,
      file_path           TEXT NOT NULL UNIQUE,
      file_name           TEXT NOT NULL,
      file_size           INTEGER NOT NULL,
      duration            REAL,
      thumbnail_path      TEXT,
      status              TEXT NOT NULL DEFAULT '未確認',
      memo                TEXT NOT NULL DEFAULT '',
      is_keep_original    INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vid_source_id ON videos(source_id);

    CREATE TABLE IF NOT EXISTS video_tags (
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES tags(id)        ON DELETE CASCADE,
      PRIMARY KEY (video_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS clips (
      id                TEXT PRIMARY KEY,
      source_video_id   TEXT REFERENCES videos(id) ON DELETE SET NULL,
      source_video_path TEXT NOT NULL,
      clip_path         TEXT NOT NULL UNIQUE,
      file_name         TEXT NOT NULL,
      start_time        REAL NOT NULL,
      end_time          REAL NOT NULL,
      duration          REAL NOT NULL,
      file_size         INTEGER NOT NULL,
      memo              TEXT NOT NULL DEFAULT '',
      favorite          INTEGER NOT NULL DEFAULT 0,
      trim_mode         TEXT NOT NULL DEFAULT 'fast',
      created_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_clip_source_video_id ON clips(source_video_id);

    CREATE TABLE IF NOT EXISTS clip_tags (
      clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES tags(id)        ON DELETE CASCADE,
      PRIMARY KEY (clip_id, tag_id)
    );
  `);

  // カラム・インデックスの後付け対応（既存DBへの安全な追加）
  try { db.exec("ALTER TABLE screenshots ADD COLUMN source_id INTEGER REFERENCES media_sources(id) ON DELETE SET NULL"); } catch { /* 既存なら無視 */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ss_source_id ON screenshots(source_id)"); } catch { /* 既存なら無視 */ }
  try { db.exec("ALTER TABLE categories ADD COLUMN color TEXT NOT NULL DEFAULT '#7aa2f7'"); } catch { /* 既存なら無視 */ }
  try { db.exec("ALTER TABLE tags       ADD COLUMN color TEXT NOT NULL DEFAULT '#9ece6a'"); } catch { /* 既存なら無視 */ }

  // 既存JSONデータからSQLite DBへの自動マイグレーション実行
  try {
    migration.runMigration(db);
  } catch (err) {
    logger.error(`[Migration Alert] マイグレーション実行中に致命的なエラーが発生しました: ${err.message}`);
  }

  // thumbnail_generated = -1 のレコードをリセット
  // 旧バージョンで config.SOURCE_DIR が空のためパスチェックに失敗したレコードを修復する
  try {
    const resetCount = db.prepare(
      "UPDATE screenshots SET thumbnail_generated = 0, thumbnail_path = NULL WHERE thumbnail_generated = -1"
    ).run().changes;
    if (resetCount > 0) {
      logger.info(`[Thumbnail Reset] thumbnail_generated = -1 のレコードを ${resetCount} 件リセットしました（次回アクセス時に再生成されます）`);
    }
  } catch (err) {
    logger.warn(`[Thumbnail Reset] リセット処理中にエラーが発生しました: ${err.message}`);
  }

  logger.info('DB 初期化完了');
  return db;
}

module.exports = { initDb, getDb };
