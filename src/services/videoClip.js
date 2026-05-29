const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const logger = require('../logger');
const videoData = require('./videoData');

function generateId(filePath) {
  return crypto.createHash('md5').update(filePath + Date.now()).digest('hex');
}

function padZero(num, len = 2) {
  return String(num).padStart(len, '0');
}

function formatTimeForFilename(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${padZero(h)}${padZero(m)}${padZero(s)}`;
  return `${padZero(m)}${padZero(s)}`;
}

function createUniqueFilePath(dir, baseName, ext) {
  let filePath = path.join(dir, `${baseName}${ext}`);
  let counter = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, `${baseName}_${counter}${ext}`);
    counter++;
  }
  return filePath;
}

function createClip(videoId, startTime, endTime) {
  return new Promise((resolve, reject) => {
    try {
      const settings = videoData.getSettings();
      const ffmpegPath = settings.ffmpegPath;
      const clipOutputDir = settings.clipOutputDir;

      if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        return reject(new Error('ffmpegが見つかりません。設定画面から正しいパスを設定してください。'));
      }
      
      if (!clipOutputDir) {
        return reject(new Error('クリップ保存先ディレクトリが設定されていません。設定画面から設定してください。'));
      }
      
      // ディレクトリが存在しない場合は自動作成を試みる
      if (!fs.existsSync(clipOutputDir)) {
        try {
          fs.mkdirSync(clipOutputDir, { recursive: true });
        } catch (err) {
          return reject(new Error(`クリップ保存先ディレクトリの作成に失敗しました: ${err.message}`));
        }
      }
      if (startTime >= endTime) {
        return reject(new Error('終了位置は開始位置より後に設定してください。'));
      }

      const videos = videoData.getVideos();
      const sourceVideo = videos.find(v => v.id === videoId);
      if (!sourceVideo || !fs.existsSync(sourceVideo.filePath)) {
        return reject(new Error('元動画が見つかりません。'));
      }

      const ext = path.extname(sourceVideo.fileName);
      const nameWithoutExt = path.basename(sourceVideo.fileName, ext);
      
      const startStr = formatTimeForFilename(startTime);
      const endStr = formatTimeForFilename(endTime);
      
      const baseName = `${nameWithoutExt}_clip_${startStr}-${endStr}`;
      const outputPath = createUniqueFilePath(clipOutputDir, baseName, ext);
      
      const args = [
        '-y',
        '-ss', String(startTime),
        '-to', String(endTime),
        '-i', sourceVideo.filePath,
        '-c', 'copy',
        outputPath
      ];

      logger.info(`Running ffmpeg: ${ffmpegPath} ${args.join(' ')}`);

      execFile(ffmpegPath, args, (error, stdout, stderr) => {
        if (error) {
          logger.error(`ffmpeg error: ${error.message}\n${stderr}`);
          let errorMsg = `ffmpeg の実行に失敗しました: ${error.message}`;
          if (error.code === 'ENOENT') {
             errorMsg = 'ffmpegコマンドが見つかりません。パス指定が正しいか確認してください。';
          }
          return reject(new Error(errorMsg));
        }
        
        if (!fs.existsSync(outputPath)) {
          return reject(new Error('ffmpegは終了しましたが、出力ファイルが作成されませんでした。'));
        }
        
        try {
          const stats = fs.statSync(outputPath);
          const duration = endTime - startTime;
          
          const newClip = {
            id: generateId(outputPath),
            sourceVideoId: videoId,
            sourceVideoPath: sourceVideo.filePath,
            clipPath: outputPath,
            fileName: path.basename(outputPath),
            startTime: startTime,
            endTime: endTime,
            duration: duration,
            size: stats.size,
            createdAt: new Date().toISOString(),
            tags: [],
            memo: '',
            favorite: false,
            trimMode: 'fast'
          };
          
          const clips = videoData.getClips();
          clips.push(newClip);
          videoData.saveClips(clips);
          
          // 親動画のステータスを更新（ユーザーの手動設定を上書きする前提だが、手動で戻せる）
          videoData.updateVideoStatus(videoId, 'クリップ作成済み');
          
          logger.info(`Clip created successfully: ${outputPath}`);
          resolve(newClip);
        } catch (err) {
          logger.error(`Failed to process created clip metadata: ${err.message}`);
          reject(new Error(`クリップ作成後の処理に失敗しました: ${err.message}`));
        }
      });
    } catch (err) {
      logger.error(`Error in createClip: ${err.message}`);
      reject(err);
    }
  });
}

module.exports = {
  createClip
};
