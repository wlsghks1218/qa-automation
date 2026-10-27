// QA_Automation_KC 데스크톱 앱 진입점 (Electron)
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_DIR = __dirname;
const CODE_ROOT = path.join(APP_DIR, '..');

// ─────────────────────────────────────────────────────────────
// 데이터 위치: 설치된 앱은 앱 폴더에 쓸 수 없으므로 사용자 폴더 사용
// ─────────────────────────────────────────────────────────────
if (app.isPackaged) {
  const userDir = app.getPath('userData');
  process.env.QA_USER_DIR = userDir; // .env(API Key), settings.json
  process.env.QA_WORKSPACE = path.join(userDir, 'workspace'); // 생성된 테스트
  process.env.QA_DEFAULT_RESULTS = path.join(app.getPath('documents'), 'QA_Automation_KC');
  // 앱에 포함된 테스트용 Chromium, 생성된 spec 이 import 하는 @playwright/test
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'pw-browsers');
  process.env.NODE_PATH = path.join(CODE_ROOT, 'node_modules');
  fs.mkdirSync(process.env.QA_WORKSPACE, { recursive: true });
}

const server = require('./server');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    const url = await server.start({
      port: 0,
      hooks: {
        pickFolder: async (initial) => {
          const r = await dialog.showOpenDialog(win, {
            title: '테스트 결과를 저장할 폴더를 선택하세요',
            defaultPath: initial,
            properties: ['openDirectory', 'createDirectory'],
          });
          return r.canceled ? null : r.filePaths[0];
        },
        openPath: (dir) => shell.openPath(dir),
      },
    });

    win = new BrowserWindow({
      width: 1180,
      height: 900,
      minWidth: 760,
      minHeight: 600,
      title: `${server.APP_NAME} v${server.VERSION}`,
      icon: path.join(APP_DIR, process.platform === 'win32' ? 'icon.ico' : 'public/icon.png'),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true },
    });

    // 상세 리포트는 앱 안의 새 창, 외부 링크는 기본 브라우저로
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 1280, height: 900, autoHideMenuBar: true } };
      }
      shell.openExternal(target);
      return { action: 'deny' };
    });

    console.log(`${server.APP_NAME} v${server.VERSION} 실행 중: ${url}`);
    win.loadURL(url);
  });

  app.on('window-all-closed', () => app.quit());
}
