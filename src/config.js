const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.LOCAL_MEDIA_DATA_DIR
  ? path.resolve(APP_DIR, process.env.LOCAL_MEDIA_DATA_DIR)
  : path.join(APP_DIR, 'data');

module.exports = {
  SOURCE_DIR: '',
  APP_DIR,
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'screenshots.db'),
  THUMBNAIL_DIR: path.join(DATA_DIR, 'thumbnails'),
  LOG_DIR: path.join(DATA_DIR, 'logs'),
  EDITED_DIR: path.join(DATA_DIR, 'edited'),
  SETTINGS_PATH: path.join(DATA_DIR, 'settings.json'),
  // 将来: true にするとサブフォルダも対象
  SCAN_RECURSIVE: false,
  THUMBNAIL_MAX_SIZE: 480,
  THUMBNAIL_QUALITY: 75,
  THUMBNAIL_CONCURRENCY: 2,
  SCAN_EXTENSIONS: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'],
  PORT: 3000,
  PAGE_SIZE: 150,
};
