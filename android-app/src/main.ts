import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import './style.css';

const sqlite = new SQLiteConnection(CapacitorSQLite);
const DB_NAME = 'eden_gestion_local';
const DB_VERSION = 1;

type NativeDeviceKey = {
  getOrCreateKey(): Promise<{ publicKeyPem: string; algorithm: 'ES256'; curve: 'P-256'; keyAlias: string }>;
  sign(options: { dataBase64Url: string }): Promise<{ signatureBase64Url: string }>;
};

const DeviceKey = registerDeviceKeyPlugin();

function registerDeviceKeyPlugin(): NativeDeviceKey {
  // The plugin is registered natively by the Android spike bootstrap.
  return (window as unknown as { EdenDeviceKey?: NativeDeviceKey }).EdenDeviceKey ?? {
    async getOrCreateKey() { throw new Error('Le module Android Keystore natif n’est pas encore chargé.'); },
    async sign() { throw new Error('Le module Android Keystore natif n’est pas encore chargé.'); },
  };
}

function render(message: string, status: 'ok' | 'pending' | 'error' = 'pending') {
  const node = document.querySelector<HTMLDivElement>('#app');
  if (!node) return;
  node.innerHTML = `
    <main class="shell">
      <header><div class="brand">EDEN <span>GESTION</span></div><div class="tag">ANDROID · SPIKE 0</div></header>
      <section class="hero">
        <p class="eyebrow">SOCLE MOBILE HORS LIGNE</p>
        <h1>Préparation du terminal</h1>
        <p class="lead">Validation SQLite native et clé ES256 Android Keystore avant tout parcours métier.</p>
      </section>
      <section class="status-card">
        <div class="status-dot ${status}"></div>
        <div><strong>État du test</strong><p id="status-message">${escapeHtml(message)}</p></div>
      </section>
      <section class="checks">
        <button id="sqlite-test" class="action">Tester SQLite native</button>
        <button id="key-test" class="action secondary">Tester la clé ES256</button>
      </section>
      <section class="facts">
        <div><small>Plateforme</small><strong>${Capacitor.getPlatform()}</strong></div>
        <div><small>Stockage métier</small><strong>SQLite natif</strong></div>
        <div><small>Orientation</small><strong>Paysage</strong></div>
      </section>
      <footer>Les ventes et les paiements ne font pas partie de cette tranche.</footer>
    </main>`;
  document.querySelector('#sqlite-test')?.addEventListener('click', () => void testSqlite());
  document.querySelector('#key-test')?.addEventListener('click', () => void testKey());
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function openDatabase() {
  const consistency = await sqlite.checkConnectionsConsistency();
  const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
  if (consistency.result && isConn) return sqlite.retrieveConnection(DB_NAME, false);
  return sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
}

async function testSqlite() {
  try {
    if (!Capacitor.isNativePlatform()) throw new Error('Ce test exige un appareil ou émulateur Android.');
    const db = await openDatabase();
    await db.open();
    await db.execute(`
      CREATE TABLE IF NOT EXISTS spike_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL,
        written_at TEXT NOT NULL
      );
    `);
    await db.run(
      'INSERT INTO spike_probe (id, value, written_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, written_at=excluded.written_at',
      ['eden-sqlite-persisted', new Date().toISOString()],
    );
    const result = await db.query('SELECT value, written_at FROM spike_probe WHERE id = 1');
    const row = result.values?.[0] as { value?: string } | undefined;
    if (row?.value !== 'eden-sqlite-persisted') throw new Error('Lecture SQLite incohérente.');
    render('Écriture et lecture SQLite natives réussies. Redémarrez ensuite la tablette en mode avion et relancez ce test pour confirmer la persistance.', 'ok');
    await db.close();
  } catch (error) {
    render(error instanceof Error ? error.message : 'Échec du test SQLite.', 'error');
  }
}

async function testKey() {
  try {
    if (!Capacitor.isNativePlatform()) throw new Error('Ce test exige un appareil ou émulateur Android.');
    const key = await DeviceKey.getOrCreateKey();
    if (key.algorithm !== 'ES256' || key.curve !== 'P-256' || !key.publicKeyPem.includes('BEGIN PUBLIC KEY')) {
      throw new Error('Le module natif a retourné une clé non conforme.');
    }
    const sample = btoa('eden-android-keystore-spike').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signed = await DeviceKey.sign({ dataBase64Url: sample });
    if (!signed.signatureBase64Url || signed.signatureBase64Url.length < 80) {
      throw new Error('La signature ES256 est absente ou trop courte.');
    }
    render('Clé P-256 générée et signature locale produite. La validation serveur reste bloquée tant que le contrat d’enrôlement signé n’est pas disponible sur main.', 'pending');
  } catch (error) {
    render(error instanceof Error ? error.message : 'Échec du test Android Keystore.', 'error');
  }
}

render('En attente des tests sur appareil Android 13.');
