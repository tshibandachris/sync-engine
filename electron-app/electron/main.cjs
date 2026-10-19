const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { openDatabase, applyPulledPage, getCursor } = require('./db/client.cjs');
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
    let cursor = getCursor(db);
    let pages = 0;
    let productsProcessed = 0;

    while (true) {
      if (++pages > 1000) {
        throw new Error('Pull stopped after 1000 pages; check API pagination.');
      }

      const response = await pullChanges({
        baseUrl: process.env.EDEN_SYNC_URL,
        token: process.env.EDEN_SYNC_TOKEN,
        lastPulledAt: cursor,
      });

      // Persist every entity type and the global cursor atomically per page.
      productsProcessed += applyPulledPage(db, response);

      if (!response.has_more) break;
      if (response.timestamp <= cursor) {
        throw new Error('Pull cursor did not advance while has_more=true.');
      }
      cursor = response.timestamp;
    }

    cursor = getCursor(db);
    status = {
      ...status,
      state: 'synced',
      message: `Pull réussi : ${productsProcessed} changement(s) produit traité(s). Curseur enregistré : ${cursor}.`,
      lastCursor: cursor,
    };
    console.log(`[sync] pull OK pages=${pages}; product changes processed=${productsProcessed}; cursor=${cursor}`);
  } catch (error) {
    status = {
      ...status,
      state: 'pending',
      message: `Synchronisation en attente : ${error.message}`,
    };
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
