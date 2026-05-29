const express = require('express');
const fs = require('fs');
const { spawn } = require('child_process');
const logger = require('./logger');
const config = require('./config');
const videoData = require('./services/videoData');
const videoScanner = require('./services/videoScanner');
const videoClip = require('./services/videoClip');
const { isSafePath } = require('./utils/security');

const router = express.Router();
let isClipping = false;
let isThumbnailGenerating = false;


// 設定取得
router.get('/settings', (req, res) => {
  res.json(videoData.getSettings());
});

// 設定保存
router.post('/settings', (req, res) => {
  const newSettings = req.body;
  const success = videoData.saveSettings(newSettings);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// 動画スキャン実行
router.post('/scan', (req, res) => {
  const { sourceId } = req.body;
  const result = videoScanner.scanVideos(sourceId);
  if (result.error) {
    res.status(500).json(result);
  } else {
    res.json(result);
  }
});

// 動画一覧取得
router.get('/list', (req, res) => {
  const path = require('path');
  const { getDb } = require('./db');
  const { source_id } = req.query;
  const DELETE_PREFIX = '__DELETE_CANDIDATE__';
  const videos = videoData.getVideos();

  // 有効なソースID一覧を取得（指定がない、または 'all' の場合はアーカイブされていないソース）
  const db = getDb();
  let allowedSourceIds = [];
  
  if (source_id && source_id !== 'all') {
    allowedSourceIds = [parseInt(source_id)];
  } else {
    const activeSources = db.prepare('SELECT id FROM media_sources WHERE archived = 0').all();
    allowedSourceIds = activeSources.map(s => s.id);
  }

  const activeVideos = videos.filter(v => {
    // ソースIDチェック
    if (!allowedSourceIds.includes(v.sourceId)) {
      return false;
    }

    const isCandidate =
      v.status === '手動削除待ち' ||
      v.fileName?.startsWith(DELETE_PREFIX) ||
      path.basename(v.filePath || '').startsWith(DELETE_PREFIX);
    return !isCandidate;
  });

  const enrichedVideos = activeVideos.map(v => ({
    ...v,
    fileExists: fs.existsSync(v.filePath)
  }));

  res.json(enrichedVideos);
});

// 手動削除待ち一覧取得
router.get('/trash/list', (req, res) => {
  const path = require('path');
  const { getDb } = require('./db');
  const { source_id } = req.query;
  const DELETE_PREFIX = '__DELETE_CANDIDATE__';
  const videos = videoData.getVideos();

  const db = getDb();
  let allowedSourceIds = [];
  
  if (source_id && source_id !== 'all') {
    allowedSourceIds = [parseInt(source_id)];
  } else {
    const activeSources = db.prepare('SELECT id FROM media_sources WHERE archived = 0').all();
    allowedSourceIds = activeSources.map(s => s.id);
  }

  const trashVideos = [];

  videos.forEach(v => {
    // ソースIDチェック
    if (!allowedSourceIds.includes(v.sourceId)) {
      return;
    }

    const isCandidate =
      v.status === '手動削除待ち' ||
      v.fileName?.startsWith(DELETE_PREFIX) ||
      path.basename(v.filePath || '').startsWith(DELETE_PREFIX);

    if (isCandidate) {
      trashVideos.push({
        ...v,
        fileExists: fs.existsSync(v.filePath)
      });
    }
  });

  res.json(trashVideos);
});

// 手動でのメタデータ個別削除 API
router.delete('/trash/metadata/:id', (req, res) => {
  const videoId = req.params.id;
  let videos = videoData.getVideos();
  const videoIndex = videos.findIndex(v => v.id === videoId);

  if (videoIndex === -1) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const video = videos[videoIndex];
  const path = require('path');
  const DELETE_PREFIX = '__DELETE_CANDIDATE__';
  const isCandidate =
    video.status === '手動削除待ち' ||
    video.fileName?.startsWith(DELETE_PREFIX) ||
    path.basename(video.filePath || '').startsWith(DELETE_PREFIX);

  if (!isCandidate) {
    return res.status(400).json({ error: 'This video is not in manual delete status' });
  }

  // 安全ガード: 実ファイルが存在する場合はこのAPIからは削除させない
  if (fs.existsSync(video.filePath)) {
    return res.status(400).json({ error: 'Real file still exists. Delete it manually first.' });
  }

  // データベースから削除
  videos.splice(videoIndex, 1);
  videoData.saveVideos(videos);

  // サムネイルキャッシュ削除
  const thumbPath = path.join(config.THUMBNAIL_DIR, `${videoId}.jpg`);
  if (fs.existsSync(thumbPath)) {
    try {
      fs.unlinkSync(thumbPath);
      console.log(`[Metadata Cleanup] サムネイルキャッシュを削除しました: ${videoId}.jpg`);
    } catch (e) {
      console.error(`[Metadata Cleanup] サムネイル削除失敗: ${e.message}`);
    }
  }

  res.json({ success: true });
});

// 動画ステータス更新
router.put('/:id/status', (req, res) => {
  const videoId = req.params.id;
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'Status is required' });
  }
  
  const success = videoData.updateVideoStatus(videoId, status);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Video not found' });
  }
});

// 動画ファイルのストリーミング配信
router.get('/stream/:id', (req, res) => {
  const videoId = req.params.id;
  const videos = videoData.getVideos();
  const video = videos.find(v => v.id === videoId);
  
  if (!video || !fs.existsSync(video.filePath)) {
    return res.status(404).send('Video not found');
  }

  if (!isSafePath(video.filePath)) {
    logger.error(`[Video Stream Security] 不正パスアクセス検出: ${video.filePath}`);
    return res.status(403).send('Forbidden');
  }

  streamVideo(req, res, video.filePath);
});

// --- クリップ一覧取得 API ---
router.get('/clips', (req, res) => {
  const clips = videoData.getClips();
  // 実ファイルの存在確認を付与
  const enrichedClips = clips.map(clip => ({
    ...clip,
    fileExists: fs.existsSync(clip.clipPath)
  }));
  res.json(enrichedClips);
});

// --- クリップストリーミング API ---
router.get('/clips/stream/:id', (req, res) => {
  const clips = videoData.getClips();
  const clip = clips.find(c => c.id === req.params.id);
  if (!clip || !fs.existsSync(clip.clipPath)) {
    return res.status(404).send('Clip not found');
  }

  if (!isSafePath(clip.clipPath)) {
    logger.error(`[Clip Stream Security] 不正パスアクセス検出: ${clip.clipPath}`);
    return res.status(403).send('Forbidden');
  }

  streamVideo(req, res, clip.clipPath);
});

// --- クリップ作成 API ---
router.post('/clips', async (req, res) => {
  if (isClipping) {
    return res.status(429).json({ error: '現在他のクリップ処理が進行中です。しばらくお待ちください。' });
  }

  const { videoId, startTime, endTime } = req.body;
  if (!videoId || startTime === undefined || endTime === undefined) {
    return res.status(400).json({ error: '不正なリクエストパラメータです。' });
  }

  isClipping = true;
  try {
    const newClip = await videoClip.createClip(videoId, Number(startTime), Number(endTime));
    res.json(newClip);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    isClipping = false;
  }
});

// --- クリップ情報更新 API ---
router.put('/clips/:id', (req, res) => {
  const clipId = req.params.id;
  const updates = req.body;
  
  // tagsが送られてきた場合、パースする（カンマ区切り文字列を配列化、重複排除等）
  if (updates.tags !== undefined) {
    if (typeof updates.tags === 'string') {
      const tagArray = updates.tags
        .split(',')
        .map(t => t.trim())
        .filter(t => t !== '');
      updates.tags = [...new Set(tagArray)];
    }
  }

  const success = videoData.updateClipInfo(clipId, updates);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Clip not found' });
  }
});

// --- フォルダを開く API ---
router.post('/open-folder', (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath) {
    return res.status(400).json({ error: 'Path is required' });
  }
  
  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    // Windowsエクスプローラーで対象ファイルを選択状態で開く
    spawn('explorer', ['/select,', targetPath], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to open folder:', err);
    res.status(500).json({ error: 'Failed to open folder' });
  }
});

// --- サムネイル生成 API ---
router.post('/:id/thumbnail', (req, res) => {
  const videoId = req.params.id;
  console.log(`[Thumbnail API] requested: ${videoId}`);
  const videos = videoData.getVideos();
  const video = videos.find(v => v.id === videoId);
  
  if (!video) {
    return res.status(404).json({
      error: 'VIDEO_NOT_FOUND',
      message: '対象動画が videos.json に存在しません。',
      videoId: req.params.id
    });
  }

  if (!video.filePath || !fs.existsSync(video.filePath)) {
    console.warn(`[Thumbnail API] 元ファイルが見つかりません: ${video.fileName} => ${video.filePath}`);
    return res.status(404).json({
      success: false,
      reason: 'file_not_found',
      message: `元動画ファイルが見つかりません: ${video.fileName}`
    });
  }

  const settings = videoData.getSettings();
  if (!settings.ffmpegPath || !fs.existsSync(settings.ffmpegPath)) {
    return res.status(400).json({ error: 'ffmpegが設定されていません' });
  }

  const path = require('path');
  const thumbDir = config.THUMBNAIL_DIR;
  const thumbFileName = `${videoId}.jpg`;
  const thumbPath = path.join(thumbDir, thumbFileName);
  const publicThumbPath = `/thumbnails/${thumbFileName}`;

  // 既に存在する場合はキャッシュを返す
  if (fs.existsSync(thumbPath)) {
    console.log(`[Thumbnail API] スキップ(生成済み): ${video.fileName}`);
    if (video.thumbnailPath !== publicThumbPath) {
      video.thumbnailPath = publicThumbPath;
      videoData.saveVideos(videos);
    }
    return res.json({ success: true, thumbnailPath: publicThumbPath });
  }

  // 同時実行ガード
  if (isThumbnailGenerating) {
    console.log(`[Thumbnail API] スキップ(他動画生成中): ${video.fileName} (ID: ${videoId})`);
    return res.status(409).json({
      success: false,
      reason: 'generating',
      message: '現在、他の動画のサムネイルを生成中です。'
    });
  }

  // seek位置の計算
  // - 10秒以上: 5秒地点
  // - 10秒未満: duration/2
  // - 最低0.5秒、最大 duration-0.5秒 に丸める
  // - durationが不明な場合は1秒（短い動画でも安全な位置）
  let thumbTime = '00:00:01.000';
  const duration = video.duration || 0;
  if (duration > 0) {
    let t = duration >= 10 ? 5 : duration / 2;
    t = Math.max(0.5, Math.min(t, duration - 0.5));
    thumbTime = new Date(t * 1000).toISOString().substring(11, 23);
  }

  isThumbnailGenerating = true;
  try {
    console.log(`[Thumbnail API] 生成開始: ${video.fileName} (seek: ${thumbTime}) (ID: ${videoId})`);
    console.log(`[Thumbnail API] 出力先: ${thumbPath}`);
    const ffmpeg = spawn(settings.ffmpegPath, [
      '-ss', thumbTime,
      '-i', video.filePath,
      '-vframes', '1',
      '-q:v', '2',
      '-vf', 'scale=96:-1',
      '-y',
      thumbPath
    ]);

    let stderrData = '';
    ffmpeg.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    ffmpeg.on('close', (code) => {
      isThumbnailGenerating = false;
      if (code === 0) {
        console.log(`[Thumbnail API] 生成完了: ${video.fileName} (ID: ${videoId})`);
        video.thumbnailPath = publicThumbPath;
        videoData.saveVideos(videos);
        res.json({ success: true, thumbnailPath: publicThumbPath });
      } else {
        console.error(`[Thumbnail API] ffmpeg 終了コード ${code}: ${video.fileName} (ID: ${videoId})`);
        if (stderrData) console.error(`[Thumbnail API] ffmpeg stderr:\n${stderrData.slice(-1000)}`);
        res.status(500).json({
          success: false,
          reason: 'ffmpeg_failed',
          message: `ffmpegの実行に失敗しました (code: ${code})`
        });
      }
    });

    ffmpeg.on('error', (err) => {
      isThumbnailGenerating = false;
      console.error(`[Thumbnail API] ffmpeg プロセス起動エラー: ${video.fileName} (ID: ${videoId})`, err.message);
      res.status(500).json({
        success: false,
        reason: 'unknown_error',
        message: 'ffmpegプロセスの起動に失敗しました'
      });
    });
  } catch (err) {
    isThumbnailGenerating = false;
    console.error(`[Thumbnail API] サーバー内部エラー: ${video.fileName} (ID: ${videoId})`, err.message);
    res.status(500).json({
      success: false,
      reason: 'unknown_error',
      message: 'Internal Server Error'
    });
  }
});


// --- クリップディレクトリ内ファイル一覧取得 API ---
router.get('/clips/directory', (req, res) => {
  const settings = videoData.getSettings();
  const dirPath = settings.clipOutputDir;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.json([]);
  }

  try {
    const files = fs.readdirSync(dirPath);
    const validExts = ['.mp4', '.mov', '.mkv', '.webm'];
    const videoFiles = files.filter(f => {
      const ext = f.substring(f.lastIndexOf('.')).toLowerCase();
      return validExts.includes(ext);
    }).map(f => {
      const fullPath = require('path').join(dirPath, f);
      const stat = fs.statSync(fullPath);
      return {
        fileName: f,
        filePath: fullPath,
        size: stat.size,
        updatedAt: stat.mtime
      };
    });
    res.json(videoFiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// --- クリップディレクトリ内ストリーミング API ---
router.get('/clips/directory/stream', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  if (!isSafePath(filePath)) {
    logger.error(`[Clip Directory Stream Security] 不正パスアクセス検出: ${filePath}`);
    return res.status(403).send('Forbidden');
  }

  streamVideo(req, res, filePath);
});

function streamVideo(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
}

module.exports = router;
