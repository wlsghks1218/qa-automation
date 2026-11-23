// PDF 페이지 → 이미지(PNG). 사내 LLM 처럼 PDF 파일을 직접 받지 못하는 모델에 화면 시안 · 흐름도 · 표를 그림으로 보여 주기 위해 쓴다.
// 앱에 들어 있는 Chromium 에서 pdf.js 로 그리므로 따로 설치할 것이 없다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const PDFJS_DIR = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy', 'build');

/**
 * base64 PDF → [{ page, mimeType, data(base64) }]
 * maxPages: 앞에서부터 몇 쪽까지 (많은 쪽을 모두 보내면 모델 입력이 너무 커진다) · scale: 1 = 72dpi
 */
async function renderPdfPages(base64, { maxPages = 12, scale = 1.5 } = {}) {
  const lib = fs.readFileSync(path.join(PDFJS_DIR, 'pdf.mjs'), 'utf-8');
  const worker = fs.readFileSync(path.join(PDFJS_DIR, 'pdf.worker.mjs'), 'utf-8');
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    // pdf.js 를 모듈로 넣고, 작업 스레드(worker)는 내용을 Blob 주소로 넘긴다 (파일 주소 접근 없이)
    await page.addScriptTag({ type: 'module', content: `${lib}\nwindow.__pdfjs = { getDocument, GlobalWorkerOptions };` });
    await page.waitForFunction(() => !!window.__pdfjs, null, { timeout: 30000 });
    return await page.evaluate(
      async ({ b64, workerSrc, maxPages: max, scale: sc }) => {
        const { getDocument, GlobalWorkerOptions } = window.__pdfjs;
        GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const doc = await getDocument({ data: bytes, isEvalSupported: false }).promise;
        const out = [];
        for (let i = 1; i <= Math.min(doc.numPages, max); i++) {
          const p = await doc.getPage(i);
          const vp = p.getViewport({ scale: sc });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          out.push({ page: i, mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] });
        }
        return { pages: out, total: doc.numPages };
      },
      { b64: base64, workerSrc: worker, maxPages, scale }
    );
  } finally {
    await browser.close();
  }
}

module.exports = { renderPdfPages };
