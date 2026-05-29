const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');
const config = require('../config');
const videoData = require('./videoData');

const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.webm'];

function generateId(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

function scanVideos(sourceId) {
  const { getDb } = require('../db');
  const db = getDb();

  // スキャン対象のメディアソースを取得
  let sourceRow;
  if (sourceId) {
    sourceRow = db.prepare('SELECT * FROM media_sources WHERE id = ?').get(parseInt(sourceId));
  } else {
    // デフォルトは最初の有効な動画ソース
    sourceRow = db.prepare("SELECT * FROM media_sources WHERE type = 'video' AND archived = 0 ORDER BY id ASC LIMIT 1").get();
  }

  if (!sourceRow) {
    logger.warn('Video source directory not configured or does not exist');
    return { added: 0, total: 0 };
  }

  const sourceDir = sourceRow.path;
  const targetSourceId = sourceRow.id;

  if (!fs.existsSync(sourceDir)) {
    logger.warn(`Video source directory does not exist: ${sourceDir}`);
    return { added: 0, total: 0 };
  }

  let videos = videoData.getVideos();
  const initialCount = videos.length;
  const DELETE_PREFIX = '__DELETE_CANDIDATE__';

  // 手動削除待ち相当（ステータス、またはファイル名のプレフィックス）のクリーンアップ＆自己修復
  videos = videos.filter(v => {
    // スキャン対象外のメディアソースの動画ならスルー（そのまま保持）
    if (v.sourceId !== targetSourceId) {
      return true;
    }

    const exists = fs.existsSync(v.filePath);
    
    const isDeleteCandidateFile =
      v.status === '手動削除待ち' ||
      v.fileName?.startsWith(DELETE_PREFIX) ||
      path.basename(v.filePath || '').startsWith(DELETE_PREFIX);

    if (!exists) {
      if (isDeleteCandidateFile) {
        logger.info(`[Scanner Cleanup] 手動削除待ち（相当）動画の実ファイル消失を確認したため、DBから完全にクリーンアップします: ${v.filePath}`);
        
        // サムネイルキャッシュのクリーンアップ
        const thumbPath = path.join(config.THUMBNAIL_DIR, `${v.id}.jpg`);
        if (fs.existsSync(thumbPath)) {
          try {
            fs.unlinkSync(thumbPath);
            logger.info(`[Scanner Cleanup] サムネイルキャッシュを削除しました: ${v.id}.jpg`);
          } catch (e) {
            logger.error(`[Scanner Cleanup] サムネイル削除失敗: ${e.message}`);
          }
        }
        return false;
      } else {
        logger.warn(`[Scanner Warning] 通常ステータス動画の実ファイルが一時的に見つかりません（外付けドライブ未接続の可能性があります）: ${v.filePath}`);
      }
    } else {
      // 実ファイルが存在し、かつ削除候補プレフィックス付きだがDBステータスが不整合の場合は自己修復
      if (isDeleteCandidateFile && v.status !== '手動削除待ち') {
        logger.info(`[Scanner Repair] 削除候補プレフィックスファイルを検知したため、DBステータスを「手動削除待ち」に同期します: ${v.filePath}`);
        v.status = '手動削除待ち';
        v.updatedAt = new Date().toISOString();
      }
    }
    return true;
  });

  const cleanedCount = initialCount - videos.length;
  if (cleanedCount > 0) {
    videoData.saveVideos(videos);
  }

  const existingMap = new Map(videos.map(v => [v.filePath, v]));
  
  let addedCount = 0;
  
  try {
    const files = fs.readdirSync(sourceDir);
    
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) continue;
      
      const filePath = path.join(sourceDir, file);
      
      if (existingMap.has(filePath)) {
        continue;
      }
      
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;

        const isDeleteCandidate = file.startsWith(DELETE_PREFIX);
        
        const newVideo = {
          id: generateId(filePath),
          sourceId: targetSourceId, // sourceId を紐付け
          filePath: filePath,
          fileName: file,
          size: stats.size,
          duration: null,
          createdAt: stats.birthtime.toISOString(),
          updatedAt: stats.mtime.toISOString(),
          thumbnailPath: null,
          status: isDeleteCandidate ? '手動削除待ち' : '未確認',
          tags: [],
          memo: '',
          clipIds: [],
          isKeepOriginal: false
        };
        
        videos.push(newVideo);
        addedCount++;
      } catch (err) {
        logger.error(`Error stat file ${filePath}: ${err.message}`);
      }
    }
    
    if (addedCount > 0) {
      videoData.saveVideos(videos);
      logger.info(`Scanned and added ${addedCount} new videos.`);
    }
    
    return { added: addedCount, total: videos.length };
    
  } catch (err) {
    logger.error(`Error scanning video directory: ${err.message}`);
    return { added: 0, total: videos.length, error: err.message };
  }
}

module.exports = {
  scanVideos
};
