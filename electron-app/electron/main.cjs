const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const { openDatabase, applyPulledPage, getCursor, listLocalProducts, saveLocalProduct, getDashboardSummary } = require('./db/client.cjs');
const { pullChanges, pushChanges } = require('./sync/api-client.cjs');
const { preparePushBatch, applyPushResponse, getOutboxStatus } = require('./sync/outbox.cjs');
const { DeviceTokenStore } = require('./auth/device-token-store.cjs');
const { validateDeviceToken } = require('./auth/device-enrollment.cjs');
const {
  assertTrustedIpcSender,
  validateSearchQuery,
  validateEnrollmentCredentials,
  validateProductInput,
} = require('./security/ipc-security.cjs');

let db;
let windowRef;
let tokenStore;
let deviceToken;
let tokenStoreError;
let authState = 'checking';
let authMessage = 'Vérification du stockage sécurisé…';
let status = { state: 'starting', message: 'Initialisation…', productCount: 0, lastCursor: 0, outboxPending: 0, outboxFailed: 0 };

function requireDeviceToken() {
  if (tokenStoreError) throw tokenStoreError;
  if (!deviceToken) {
    throw new Error('Jeton d’appareil absent du stockage sécurisé. Réenrôlez cet appareil avant de synchroniser.');
  }
  return deviceToken;
}

async function initializeDeviceToken() {
  tokenStore = new DeviceTokenStore({ app, safeStorage });
  deviceToken = await tokenStore.load();

  // Environment-based bootstrap is strictly for unpackaged local development.
  // Packaged production builds never read EDEN_SYNC_TOKEN from process.env.
  if (!deviceToken && !app.isPackaged) {
    const developmentToken = process.env.EDEN_SYNC_TOKEN;
    if (developmentToken) {
      const validated = validateDeviceToken(developmentToken);
      await tokenStore.setToken(validated);
      deviceToken = await tokenStore.load();
    }
  }

  if (deviceToken) {
    authState = 'ready';
    authMessage = 'Jeton d’appareil chargé depuis le stockage sécurisé.';
    return;
  }

  authState = 'enrollment-required';
  authMessage = 'Cette caisse doit être enrôlée avant de synchroniser.';
}

function readStatus() {
  const outbox = db ? getOutboxStatus(db) : { pending: status.outboxPending, failed: status.outboxFailed };
  return {
    ...status,
    authState,
    authMessage,
    lastCursor: db ? getCursor(db) : status.lastCursor,
    productCount: db ? Number(db.prepare('SELECT count(*) AS n FROM products WHERE deleted_at IS NULL AND is_active = 1').get().n) : 0,
    outboxPending: outbox.pending,
    outboxFailed: outbox.failed,
  };
}

async function pullAll() {
  const token = requireDeviceToken();
  let cursor = getCursor(db);
  let pages = 0;
  let productsProcessed = 0;
  while (true) {
    if (++pages > 1000) throw new Error('Pull stopped after 1000 pages; check API pagination.');
    const response = await pullChanges({
      baseUrl: process.env.EDEN_SYNC_URL,
      token,
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
    token: requireDeviceToken(),
    idempotencyKey: batch.idempotencyKey,
    payload: batch.payload,
  });
  const result = applyPushResponse(db, batch, response);
  console.log(`[sync] push batch=${batch.idempotencyKey}; acknowledged=${result.acknowledged}; retained=${result.retained}; replay=${result.replay}`);
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
      message: `Sync terminée : pull ${finalPull.productsProcessed} produit(s), curseur ${finalPull.cursor}; outbox ${outbox.pending} en attente (${outbox.failed} avec erreur).`,
      lastCursor: finalPull.cursor,
      outboxPending: outbox.pending,
      outboxFailed: outbox.failed,
    };
    console.log(`[sync] OK pullPages=${initialPull.pages + (push.sent ? finalPull.pages : 0)}; products=${initialPull.productsProcessed + (push.sent ? finalPull.productsProcessed : 0)}; cursor=${finalPull.cursor}; outboxPending=${outbox.pending}`);
  } catch (error) {
    const outbox = getOutboxStatus(db);
    status = {
      ...status,
      state: 'pending',
      message: `Synchronisation en attente : ${error.message}. ${outbox.pending} opération(s) conservée(s) dans l’outbox.`,
      outboxPending: outbox.pending,
      outboxFailed: outbox.failed,
    };
    console.error('[sync] failed:', error.message);
  }

  windowRef?.webContents.send('eden:status', readStatus());
  return readStatus();
}

function registerTrustedHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event, windowRef);
    return handler(...args);
  });
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef.setTitle('Eden Gestion Desktop');
  const rendererUrl = require('node:url').pathToFileURL(
    path.join(__dirname, 'renderer', 'index.html'),
  ).href;
  windowRef.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  db = openDatabase(app);
  try {
    await initializeDeviceToken();
  } catch (error) {
    tokenStoreError = error;
    authState = 'storage-error';
    authMessage = 'Stockage sécurisé indisponible. La caisse reste bloquée pour protéger le jeton.';
    console.error('[auth] secure device token unavailable:', error.message);
  }

  registerTrustedHandler('eden:get-status', () => readStatus());
  registerTrustedHandler('eden:device:enroll', async (credentials) => {
    try {
      credentials = validateEnrollmentCredentials(credentials);
    } catch (error) {
      return { success: false, error: error.message || 'Identifiants d’enrôlement invalides.' };
    }
    if (tokenStoreError || authState === 'storage-error') {
      return { success: false, error: 'Le stockage sécurisé est indisponible. L’enrôlement est bloqué.' };
    }
    if (deviceToken) return { success: false, error: 'Cette caisse est déjà enrôlée.' };

    let token;
    try {
      token = validateDeviceToken(credentials?.token);
    } catch (error) {
      return { success: false, error: error.message || 'JWT invalide.' };
    }

    try {
      await tokenStore.setToken(token);
      const storedToken = await tokenStore.load();
      if (storedToken !== token) throw new Error('La vérification du stockage sécurisé a échoué.');
      deviceToken = storedToken;
      tokenStoreError = null;
      authState = 'ready';
      authMessage = 'Appareil enrôlé et jeton relu depuis le stockage sécurisé.';
      status = { ...status, state: 'pending', message: 'Caisse enrôlée. Synchronisation en attente du serveur.', lastCursor: getCursor(db) };
      windowRef?.webContents.send('eden:status', readStatus());
      // Enrollment succeeds on verified encrypted persistence; network sync is asynchronous.
      void doSync();
      return { success: true };
    } catch (error) {
      tokenStoreError = error;
      authState = 'storage-error';
      authMessage = 'Impossible de confirmer le stockage chiffré. La synchronisation reste bloquée.';
      windowRef?.webContents.send('eden:status', readStatus());
      console.error('[auth] enrollment storage failed:', error.message);
      return { success: false, error: authMessage };
    }
  });
  registerTrustedHandler('eden:refresh', () => doSync());
  registerTrustedHandler('eden:dashboard', () => getDashboardSummary(db));
  registerTrustedHandler('eden:products:list', (search = '') =>
    listLocalProducts(db, { search: validateSearchQuery(search) }));
  registerTrustedHandler('eden:products:save', (input) => {
    const product = saveLocalProduct(db, validateProductInput(input));
    status = { ...status, outboxPending: getOutboxStatus(db).pending };
    windowRef?.webContents.send('eden:status', readStatus());
    return product;
  });
  createWindow();
  await doSync();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (db) db.close(); });
