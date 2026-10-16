const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { openDatabase, applyPulledProducts } = require('./db/client.cjs');
const { pullChanges } = require('./sync/api-client.cjs');

let db;
let windowRef;
let status = { state: 'starting', message: 'Initialisation…', productCount: 0, lastCursor: 0 };

function readStatus() {
  return { ...status, productCount: db ? Number(db.prepare('SELECT count(*) AS n FROM products WHERE deleted_at IS NULL').get().n) : 0 };
}

async function doPull() {
  if (status.state === 'syncing') return readStatus();
  status = { ...status, state: 'syncing', message: 'Synchronisation en cours…' };
  windowRef?.webContents.send('eden:status', readStatus());
  try {
    // Important: this skeleton persists products only. The backend cursor is global
    // across entity types, so advancing it before every entity is persisted would
    // permanently skip staff/sessions/sales. Keep cursor 0 until full-feed persistence
    // and pagination are implemented; product upserts are idempotent.
    const response = await pullChanges({
      baseUrl: process.env.EDEN_SYNC_URL,
      token: process.env.EDEN_SYNC_TOKEN,
      lastPulledAt: 0,
    });
    const count = applyPulledProducts(db, response.changes.products || {});
    status = {
      ...status, state: 'synced',
      message: `Pull réussi : ${count} produit(s) traités. Curseur global non avancé (squelette).`,
      lastCursor: 0,
    };
    console.log(`[sync] pull OK; produits traités=${count}; has_more=${response.has_more}; cursor retained at 0 until all entity types are persisted`);
  } catch (error) {
    status = { ...status, state: 'pending', message: `Synchronisation en attente : ${error.message}` };
    console.error('[sync] pull failed:', error);
  }
  windowRef?.webContents.send('eden:status', readStatus());
  return readStatus();
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 780,
    height: 520,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  db = openDatabase(app);
  ipcMain.handle('eden:get-status', () => readStatus());
  ipcMain.handle('eden:refresh', () => doPull());
  createWindow();
  await doPull();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (db) db.close(); });
