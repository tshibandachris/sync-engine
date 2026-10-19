const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { openDatabase, applyPulledPage, getCursor } = require('./db/client.cjs');
const { pullChanges, pushChanges } = require('./sync/api-client.cjs');
const { preparePushBatch, applyPushResponse, getOutboxStatus } = require('./sync/outbox.cjs');

let db;
let windowRef;
let status = { state: 'starting', message: 'Initialisation…', productCount: 0, lastCursor: 0, outboxPending: 0, outboxFailed: 0 };

function readStatus() {
  const outbox = db ? getOutboxStatus(db) : { pending: status.outboxPending, failed: status.outboxFailed };
  return {
    ...status,
    lastCursor: db ? getCursor(db) : status.lastCursor,
    productCount: db ? Number(db.prepare('SELECT count(*) AS n FROM products WHERE deleted_at IS NULL').get().n) : 0,
    outboxPending: outbox.pending,
    outboxFailed: outbox.failed,
  };
}

async function pullAll() {
  let cursor = getCursor(db);
  let pages = 0;
  let productsProcessed = 0;
  while (true) {
    if (++pages > 1000) throw new Error('Pull stopped after 1000 pages; check API pagination.');
    const response = await pullChanges({
      baseUrl: process.env.EDEN_SYNC_URL,
      token: process.env.EDEN_SYNC_TOKEN,
      lastPulledAt: cursor,
    });
    productsProcessed += applyPulledPage(db, response);
    if (!response.has_more) break;
    if (response.timestamp <= cursor) throw new Error('Pull cursor did not advance while has_more=true.');
    cursor = response.timestamp;
  }
  return { pages, productsProcessed, cursor: getCursor(db) };
}

async function pushPending() {
  const batch = preparePushBatch(db);
  if (!batch) return { sent: false, acknowledged: 0, retained: 0 };
  const response = await pushChanges({
    baseUrl: process.env.EDEN_SYNC_URL,
    token: process.env.EDEN_SYNC_TOKEN,
    idempotencyKey: batch.idempotencyKey,
    payload: batch.payload,
  });
  const result = applyPushResponse(db, batch, response);
  console.log(\`[sync] push batch=\${batch.idempotencyKey}; acknowledged=\${result.acknowledged}; retained=\${result.retained}; replay=\${result.replay}\`);
  return { sent: true, ...result };
}

async function doSync() {
  if (status.state === 'syncing') return readStatus();
  status = { ...status, state: 'syncing', message: 'Synchronisation en cours…' };
  windowRef?.webContents.send('eden:status', readStatus());

  try {
    // Pull reference data first (products, staff, sessions) before pushing queued sales.
    const initialPull = await pullAll();
    const push = await pushPending();
    // Pull once more to receive authoritative versions and server-assigned sync sequences.
    const finalPull = push.sent ? await pullAll() : initialPull;
    const outbox = getOutboxStatus(db);
    status = {
      ...status,
      state: outbox.pending > 0 ? 'pending' : 'synced',
      message: \`Sync terminée : pull \${finalPull.productsProcessed} produit(s), curseur \${finalPull.cursor}; outbox \${outbox.pending} en attente (\${outbox.failed} avec erreur).\`,
      lastCursor: finalPull.cursor,
      outboxPending: outbox.pending,
      outboxFailed: outbox.failed,
    };
    console.log(\`[sync] OK pullPages=\${initialPull.pages + (push.sent ? finalPull.pages : 0)}; products=\${initialPull.productsProcessed + (push.sent ? finalPull.productsProcessed : 0)}; cursor=\${finalPull.cursor}; outboxPending=\${outbox.pending}\`);
  } catch (error) {
    const outbox = getOutboxStatus(db);
    status = {
      ...status,
      state: 'pending',
      message: \`Synchronisation en attente : \${error.message}. \${outbox.pending} opération(s) conservée(s) dans l’outbox.\`,
      outboxPending: outbox.pending,
      outboxFailed: outbox.failed,
    };
    console.error('[sync] failed:', error);
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
  ipcMain.handle('eden:refresh', () => doSync());
  createWindow();
  await doSync();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (db) db.close(); });
