/**
 * 编译前清理 dist 目录。
 *
 * tsc 不会删除已删除源文件对应的旧编译产物，
 * 当模块从单文件重构为目录时（如 stream.ts → stream/），
 * 旧的 stream.js 会遮蔽新的 stream/index.js，导致 Node.js 加载旧代码。
 *
 * 本脚本在 tsc 前运行，确保 dist 目录干净。
 */
const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '..', 'dist');

if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
  console.log('[clean-dist] 已清理 dist 目录');
} else {
  console.log('[clean-dist] dist 目录不存在，跳过清理');
}
