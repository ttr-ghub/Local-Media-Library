const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.LOG_DIR, { recursive: true });

const logFilePath = path.join(
  config.LOG_DIR,
  `app-${new Date().toISOString().slice(0, 10)}.log`
);

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(logFilePath, line, 'utf8');
  } catch {
    // ログ書き込み失敗はサイレントに無視
  }
}

module.exports = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
};
