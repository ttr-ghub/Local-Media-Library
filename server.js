const express = require('express');
const path = require('path');
const fs = require('fs');
const { initDb } = require('./src/db');
const routes = require('./src/routes');
const videoRoutes = require('./src/videoRoutes');
const sourceRoutes = require('./src/sourceRoutes');
const logger = require('./src/logger');
const config = require('./src/config');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/thumbnails', express.static(config.THUMBNAIL_DIR));
// 動画ファイルの静的配信（CORS等は必要に応じ後で設定。一旦は安全のため /api 経由ではなく別ルートとするか、API経由で返すかだが、videoSourceDirから直接配信する場合はexpress.staticが必要。第1段階ではローカル動画のパスを取得するので file:/// へのアクセスができない場合は、ストリーミング用のエンドポイントが必要になる）
app.use('/api', routes);
app.use('/api/video', videoRoutes);
app.use('/api/sources', sourceRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`未処理エラー: ${err.stack ?? err.message}`);
  res.status(500).json({ error: 'internal server error' });
});

initDb();
if (!fs.existsSync(config.EDITED_DIR)) {
  fs.mkdirSync(config.EDITED_DIR, { recursive: true });
}
logger.info(`Local Media Library 起動: ${new Date().toISOString()}`);

app.listen(config.PORT, () => {
  logger.info(`サーバー起動: http://localhost:${config.PORT}`);
});
