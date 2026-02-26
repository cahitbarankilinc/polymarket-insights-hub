import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { startTrackerServer } from '../server/trackerServer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let backendServer;

const isDev = !app.isPackaged;
const frontendDevUrl = process.env.ELECTRON_RENDERER_URL ?? 'http://127.0.0.1:8080';
const serverPort = Number(process.env.SERVER_PORT ?? 8787);

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.mjs'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev) {
    await mainWindow.loadURL(frontendDevUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
};

app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  const staticDir = isDev ? undefined : path.join(process.resourcesPath, 'app.asar.unpacked', 'dist');

  backendServer = startTrackerServer({
    port: serverPort,
    dataDir: userDataDir,
    staticDir,
  });

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendServer) {
    backendServer.close();
  }
});
