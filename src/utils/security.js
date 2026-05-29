const path = require('path');
const config = require('../config');
const { getDb } = require('../db');

/**
 * 対象のファイルパスが、現在登録され有効化されている（アーカイブされていない）
 * メディアソースのいずれかのディレクトリ配下にあるかを動的に検証します（パストラバーサル防御）。
 * 
 * @param {string} filePath 検証対象のファイル絶対パス
 * @returns {boolean} 安全なパスであれば true、それ以外は false
 */
function isSafePath(filePath) {
  if (!filePath) return false;
  
  try {
    const db = getDb();
    // 有効かつアーカイブされていないメディアソースのパス一覧を取得
    const sources = db.prepare('SELECT path FROM media_sources WHERE enabled = 1 AND archived = 0').all();
    const allowedPaths = sources.map(src => src.path);

    // settings.json に設定されているクリップ保存先と圧縮動画保存先も許可対象に加える
    const fs = require('fs');
    const settingsPath = config.SETTINGS_PATH;
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.clipOutputDir) allowedPaths.push(settings.clipOutputDir);
        if (settings.compressedOutputDir) allowedPaths.push(settings.compressedOutputDir);
      } catch (e) {
        // 設定読み込みエラーは無視
      }
    }
    
    const normalized = path.resolve(filePath).toLowerCase();
    
    for (const allowedPath of allowedPaths) {
      const srcResolved = path.resolve(allowedPath).toLowerCase();
      // 配下にあるか、あるいは完全に一致するかチェック
      if (normalized.startsWith(srcResolved + path.sep) || normalized === srcResolved) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error(`[Security Helper] パス検証中にエラーが発生しました: ${err.message}`);
    return false;
  }
}

module.exports = { isSafePath };
