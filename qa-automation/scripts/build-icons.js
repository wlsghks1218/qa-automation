// 앱 아이콘 생성: app/public/icon.png(창/파비콘), app/icon.ico(Windows), build/icon.png(macOS, 1024px)
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const ICON_SVG = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="56" fill="#3b5bdb"/>
  <path d="M78 132 l30 30 l70 -74" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="128" y="214" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial" font-weight="700" font-size="40" fill="#dbe4ff">KC</text>
</svg>`;

async function render(page, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${ICON_SVG(size)}</body>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** PNG 를 그대로 담은 ICO (Windows Vista 이후 지원) */
function pngToIco(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  header.writeUInt8(0, 6); // width 256
  header.writeUInt8(0, 7); // height 256
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bpp
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // offset
  return Buffer.concat([header, png]);
}

async function buildIcons() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const png256 = await render(page, 256);
  const png1024 = await render(page, 1024);
  await browser.close();

  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'app', 'public', 'icon.png'), png256);
  fs.writeFileSync(path.join(ROOT, 'app', 'icon.ico'), pngToIco(png256));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png1024);
}

module.exports = { buildIcons };

if (require.main === module) buildIcons().then(() => console.log('아이콘 생성 완료'));
