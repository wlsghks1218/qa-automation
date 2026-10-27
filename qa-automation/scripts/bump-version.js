// 앱 버전 0.001 올리기: node scripts/bump-version.js
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'app', 'version.json');
const info = JSON.parse(fs.readFileSync(file, 'utf-8'));
const prev = info.version;
info.version = ((Math.round(Number(prev) * 1000) + 1) / 1000).toFixed(3);
fs.writeFileSync(file, JSON.stringify(info, null, 2) + '\n', 'utf-8');
console.log(`버전 ${prev} → ${info.version}`);
