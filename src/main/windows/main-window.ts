import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Creates the hardened main desktop BrowserWindow for Lossless Player:
 * - nodeIntegration: false
 * - contextIsolation: true
 * - sandbox: true
 * - Blocks popup windows and external navigation
 */
export function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, '../preload/index.cjs');

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'DoReMi',
    backgroundColor: '#09090b',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Strictly block opening new browser windows or external popups
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Prevent renderer from navigating away to remote/arbitrary URLs
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && targetUrl.startsWith(devUrl)) {
      return;
    }
    event.preventDefault();
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (!mainWindow.isDestroyed()) {
    if (rendererUrl) {
      void mainWindow.loadURL(rendererUrl);
    } else {
      const indexHtmlPath = path.join(__dirname, '../renderer/index.html');
      void mainWindow.loadFile(indexHtmlPath);
    }
  }

  return mainWindow;
}
