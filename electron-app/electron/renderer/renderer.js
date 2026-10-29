const $ = (id) => document.getElementById(id);
const state = { products: [], query: '', status: null };
let dashboardInitialized = false;

const money = (amount) => new Intl.NumberFormat('fr-CD', {
  style: 'currency', currency: 'CDF', maximumFractionDigits: 0,
}).format(Number(amount || 0));

function setFeedback(message, kind = '') {
  const target = $('product-feedback');
  target.textContent = message || '';
  target.className = `feedback ${kind}`.trim();
}

function renderStatus(value) {
  state.status = value || {};
  const status = state.status;
  const dot = $('sync-dot');
  dot.className = 'dot';
  if (status.state === 'synced') dot.classList.add('synced');
  else if (status.state === 'syncing') dot.classList.add('syncing');
  else if (status.state === 'pending') dot.classList.add('pending');

  const label = status.state === 'syncing' ? 'Synchronisation…'
    : status.state === 'synced' ? 'Synchronisé'
    : status.state === 'pending' ? 'En attente / hors ligne' : 'Initialisation…';
  $('sync-label').textContent = label;
  $('sync-pill')?.setAttribute('title', status.message || label);
  $('sync-button').disabled = status.state === 'syncing';
  $('sync-button').textContent = status.state === 'syncing' ? 'Synchronisation…' : '↻ Synchroniser';
  $('metric-pending').textContent = String(status.outboxPending ?? 0);
  $('queue-detail').textContent = `${status.outboxPending ?? 0} opération(s) en attente ; ${status.outboxFailed ?? 0} en erreur.`;
}

function renderDashboard(summary) {
  $('metric-products').textContent = String(summary.products ?? 0);
  $('metric-low-stock').textContent = String(summary.lowStock ?? 0);
  $('metric-sales').textContent = String(summary.salesToday ?? 0);
  $('metric-sales-total').textContent = `Montant total : ${money(summary.salesTotalToday)}`;
  $('metric-sessions').textContent = `${summary.openSessions ?? 0} session(s) ouverte(s) détectée(s) sur ce poste.`;
  $('last-refresh').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function addCell(row, content, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  if (content instanceof Node) cell.append(content);
  else cell.textContent = String(content ?? '');
  row.append(cell);
  return cell;
}

function renderProducts(products) {
  const body = $('products-body');
  body.replaceChildren();
  $('product-count-label').textContent = `${products.length} produit(s)`;
  $('products-empty').hidden = products.length > 0;

  for (const product of products) {
    const row = document.createElement('tr');
    const nameWrap = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'product-name';
    name.textContent = product.name;
    nameWrap.append(name);
    const details = document.createElement('span');
    details.className = 'subtext';
    details.textContent = product.barcode ? `Code-barres : ${product.barcode}` : 'Article du catalogue';
    nameWrap.append(details);
    addCell(row, nameWrap);

    addCell(row, product.sku || '—');
    addCell(row, product.category || 'Sans catégorie');
    addCell(row, money(product.price), 'price');

    const stock = document.createElement('span');
    const known = product.stockQuantity != null;
    const isLow = known && product.stockAlert != null && product.stockQuantity <= product.stockAlert;
    stock.className = `stock-badge${isLow ? ' low' : ''}`;
    stock.textContent = !known ? 'Non renseigné' : `${product.stockQuantity} unité(s)`;
    addCell(row, stock);

    const actionCell = document.createElement('td');
    const edit = document.createElement('button');
    edit.className = 'btn small';
    edit.type = 'button';
    edit.textContent = 'Modifier';
    edit.dataset.editProduct = product.id;
    actionCell.append(edit);
    row.append(actionCell);
    body.append(row);
  }
}

async function loadProducts() {
  try {
    state.products = await window.eden.listProducts(state.query);
    renderProducts(state.products);
  } catch (error) {
    setFeedback(error.message || 'Impossible de charger le catalogue.', 'error');
  }
}

async function refreshDashboard() {
  try {
    renderDashboard(await window.eden.getDashboard());
  } catch (error) {
    $('last-refresh').textContent = 'Résumé indisponible';
    console.error('Dashboard read failed:', error);
  }
}

function switchPage(page) {
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelectorAll('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
  $('page-title').textContent = page === 'products' ? 'Produits & stock' : 'Vue d’ensemble';
  if (page === 'products') loadProducts();
}

function openProductDialog(product = null) {
  $('product-form').reset();
  $('product-id').value = product?.id || '';
  $('product-dialog-title').textContent = product ? 'Modifier le produit' : 'Nouveau produit';
  $('product-name').value = product?.name || '';
  $('product-price').value = product?.price ?? '';
  $('product-cost').value = product?.cost ?? '';
  $('product-sku').value = product?.sku || '';
  $('product-barcode').value = product?.barcode || '';
  $('product-category').value = product?.category || '';
  $('product-alert').value = product?.stockAlert ?? 5;
  $('form-feedback').textContent = '';
  $('form-feedback').className = 'feedback';
  $('product-dialog').showModal();
  $('product-name').focus();
}

function closeProductDialog() {
  $('product-dialog').close();
}

async function saveProduct(event) {
  event.preventDefault();
  const button = $('save-product');
  const formFeedback = $('form-feedback');
  button.disabled = true;
  formFeedback.textContent = 'Enregistrement local…';
  formFeedback.className = 'feedback';
  const input = {
    id: $('product-id').value || undefined,
    name: $('product-name').value,
    price: $('product-price').value,
    cost: $('product-cost').value,
    sku: $('product-sku').value,
    barcode: $('product-barcode').value,
    category: $('product-category').value,
    stockAlert: $('product-alert').value,
  };
  try {
    await window.eden.saveProduct(input);
    closeProductDialog();
    setFeedback('Produit enregistré sur cet ordinateur. Il sera synchronisé lorsque la connexion sera configurée et disponible.', 'success');
    await Promise.all([loadProducts(), refreshDashboard()]);
  } catch (error) {
    formFeedback.textContent = error.message || 'Enregistrement impossible.';
    formFeedback.className = 'feedback error';
  } finally {
    button.disabled = false;
  }
}

function renderAuthState(status) {
  const authState = status?.authState || 'storage-error';
  $('app-shell').hidden = authState !== 'ready';
  $('enrollment-screen').hidden = authState !== 'enrollment-required';
  $('storage-error-screen').hidden = authState !== 'storage-error';
  if (authState === 'ready') initializeDashboard();
}

function handleStatus(status) {
  renderAuthState(status);
  if (status?.authState === 'ready') renderStatus(status);
}

function initializeDashboard() {
  if (dashboardInitialized) return;
  dashboardInitialized = true;
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchPage(button.dataset.page)));
  $('new-product').addEventListener('click', () => openProductDialog());
  $('close-dialog').addEventListener('click', closeProductDialog);
  $('cancel-product').addEventListener('click', closeProductDialog);
  $('product-form').addEventListener('submit', saveProduct);
  $('products-body').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-product]');
    if (!button) return;
    const product = state.products.find((item) => item.id === button.dataset.editProduct);
    if (product) openProductDialog(product);
  });
  $('product-search').addEventListener('input', async (event) => {
    state.query = event.target.value;
    await loadProducts();
  });
  $('sync-button').addEventListener('click', async () => {
    try { renderStatus(await window.eden.refresh()); }
    catch (error) { setFeedback(error.message || 'Synchronisation impossible.', 'error'); }
    await Promise.all([refreshDashboard(), loadProducts()]);
  });
  void refreshDashboard();
  void loadProducts();
  window.eden.getStatus().then(renderStatus).catch((error) => renderStatus({ state: 'pending', message: error.message, outboxPending: 0, outboxFailed: 0 }));
}

window.addEventListener('DOMContentLoaded', async () => {
  $('enrollment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('enroll-button');
    const feedback = $('enrollment-feedback');
    const token = $('device-token').value.trim();
    button.disabled = true;
    feedback.className = 'feedback';
    feedback.textContent = 'Validation et chiffrement du jeton…';
    try {
      const result = await window.eden.enrollDevice({ token });
      if (!result?.success) throw new Error(result?.error || 'Enrôlement impossible.');
      $('device-token').value = '';
      feedback.className = 'feedback success';
      feedback.textContent = 'Jeton chiffré et vérifié. Ouverture du tableau de bord…';
      handleStatus(await window.eden.getStatus());
    } catch (error) {
      feedback.className = 'feedback error';
      feedback.textContent = error.message || 'Enrôlement impossible.';
    } finally {
      button.disabled = false;
    }
  });
  window.eden.onStatus(handleStatus);
  try { handleStatus(await window.eden.getStatus()); }
  catch (error) { renderAuthState({ authState: 'storage-error' }); console.error('Authentication status unavailable:', error.message); }
});
