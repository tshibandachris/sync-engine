const $ = (id) => document.getElementById(id);
const state = { products: [], query: '', status: null, cart: new Map(), posQuery: '', posStaff: [], cashSessions: [], activeCashSessionId: '' };
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

  const label = status.syncState === 'blocked_revoked' ? 'Terminal révoqué · local uniquement'
    : status.syncState === 'blocked_rejected' ? 'Terminal rejeté · local uniquement'
    : status.syncState === 'blocked_deactivated' ? 'Terminal désactivé · local uniquement'
    : status.syncState === 'blocked_proof_unavailable' ? 'Approbation confirmée · preuve ES256 requise'
    : status.syncState === 'blocked_unapproved' ? 'Approbation requise · local uniquement'
    : status.syncState === 'blocked_unregistered' ? 'Terminal non enregistré · local uniquement'
    : status.state === 'syncing' ? 'Synchronisation…'
    : status.state === 'synced' ? 'Synchronisé'
    : status.state === 'pending' ? 'En attente / hors ligne' : 'Initialisation…';
  $('sync-label').textContent = label;
  const enrollmentPanel = $('device-enrollment-panel');
  if (enrollmentPanel) {
    enrollmentPanel.hidden = Boolean(status.deviceId) || status.agentAuthState !== 'authenticated';
    const enrollmentFeedback = $('device-enrollment-feedback');
    if (status.enrollmentAttemptError) {
      enrollmentFeedback.textContent = 'Une tentative d’enrôlement chiffrée ne peut pas être lue. Le stockage sécurisé doit être réparé avant toute nouvelle activation.';
      enrollmentFeedback.className = 'feedback error';
      $('register-device-button').disabled = true;
    } else if (status.pendingEnrollment && !enrollmentFeedback.textContent) {
      enrollmentFeedback.textContent = 'Une tentative précédente est conservée de manière chiffrée. Réutilisez le même code d’activation pour reprendre exactement la même preuve.';
      enrollmentFeedback.className = 'feedback';
    }
  }
  $('sync-pill')?.setAttribute('title', status.message || label);
  $('sync-button').disabled = status.state === 'syncing' || status.canRunSync === false;
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
    if ($('pos-products')) renderPosProducts();
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

function renderPosProducts() {
  const list = $('pos-products');
  const term = state.posQuery.trim().toLocaleLowerCase('fr');
  const products = state.products.filter((p) => !term || [p.name, p.sku, p.barcode].some((v) => String(v || '').toLocaleLowerCase('fr').includes(term)));
  $('pos-product-count').textContent = `${products.length} article(s)`;
  list.replaceChildren();
  if (!products.length) { const empty=document.createElement('div'); empty.className='empty'; empty.textContent='Aucun produit correspondant.'; list.append(empty); return; }
  for (const product of products) {
    const button=document.createElement('button'); button.type='button'; button.className='pos-product';
    const name=document.createElement('strong'); name.textContent=product.name;
    const detail=document.createElement('span'); detail.textContent=product.sku || product.category || 'Article';
    const price=document.createElement('b'); price.textContent=money(product.price);
    button.append(name,detail,price);
    button.addEventListener('click',()=>{const item=state.cart.get(product.id)||{product,quantity:0};item.quantity+=1;state.cart.set(product.id,item);renderCart();});
    list.append(button);
  }
}
function renderCart() {
  const lines = $('cart-lines'); lines.replaceChildren(); let total = 0; let count = 0;
  if (!state.cart.size) { const empty = document.createElement('div'); empty.className = 'empty'; const strong = document.createElement('strong'); strong.textContent = 'Votre panier est vide'; const hint = document.createElement('span'); hint.textContent = 'Sélectionnez un produit pour commencer.'; empty.append(strong, hint); lines.append(empty); }
  for (const [id, item] of state.cart) {
    const subtotal = item.product.price * item.quantity; total += subtotal; count += item.quantity;
    const row = document.createElement('div'); row.className = 'cart-line'; const detail = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = item.product.name; const price = document.createElement('small'); price.textContent = item.quantity + ' × ' + money(item.product.price) + ' · ' + money(subtotal); detail.append(name, price);
    const actions = document.createElement('div'); actions.className = 'cart-line-actions';
    for (const [label, delta] of [['−', -1], ['+', 1]]) { const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = label; btn.setAttribute('aria-label', (delta > 0 ? 'Ajouter' : 'Retirer') + ' une unité de ' + item.product.name); btn.addEventListener('click', () => { item.quantity += delta; if (item.quantity <= 0) state.cart.delete(id); renderCart(); }); actions.append(btn); }
    row.append(detail, actions); lines.append(row);
  }
  $('cart-count').textContent = count + ' article(s)'; $('cart-subtotal').textContent = money(total); $('cart-total').textContent = money(total);
  const method = $('payment-method').value; $('payment-split').hidden = method !== 'mixed';
  if (method === 'cash') { $('cash-amount').value = String(total); $('mobile-amount').value = '0'; }
  if (method === 'mobile_money') { $('cash-amount').value = '0'; $('mobile-amount').value = String(total); }
  const activeSession = state.cashSessions.find((session) => session.id === state.activeCashSessionId);
  const checkout = $('checkout-button'); checkout.disabled = !activeSession || activeSession.closeRequested || state.cart.size === 0;
  checkout.textContent = checkout.disabled ? 'Ouvrir une session pour encaisser' : 'Encaisser la vente';
}

async function loadPosState() {
  try {
    const snapshot = await window.eden.getPosState(); state.posStaff = snapshot.staff || []; state.cashSessions = snapshot.cashSessions || [];
    if (!state.cashSessions.some((session) => session.id === state.activeCashSessionId)) state.activeCashSessionId = state.cashSessions[0]?.id || '';
    const staffSelect = $('pos-staff-select'); const previousStaff = staffSelect.value; staffSelect.replaceChildren();
    for (const staff of state.posStaff) { const option = document.createElement('option'); option.value = staff.id; option.textContent = staff.displayName; option.disabled = state.cashSessions.some((session) => session.staffId === staff.id); staffSelect.append(option); }
    if (state.posStaff.some((staff) => staff.id === previousStaff && !state.cashSessions.some((session) => session.staffId === staff.id))) staffSelect.value = previousStaff;
    const sessionSelect = $('pos-session-select'); sessionSelect.replaceChildren();
    if (!state.cashSessions.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Aucune session ouverte'; sessionSelect.append(option); }
    for (const session of state.cashSessions) { const option = document.createElement('option'); option.value = session.id; option.textContent = session.staffName + ' · fond ' + money(session.openingAmount); sessionSelect.append(option); }
    sessionSelect.value = state.activeCashSessionId;
    const selected = state.cashSessions.find((session) => session.id === state.activeCashSessionId);
    const recent = snapshot.recentClosedSession;
    $('pos-session-summary').textContent = selected
      ? (selected.closeRequested ? 'Clôture demandée · aucune nouvelle vente · espèces déclarées : ' + money(selected.closeClosingAmount ?? selected.expectedCash) + (selected.closeSyncError ? ' · erreur de synchronisation : ' + selected.closeSyncError : '') : 'Session de ' + selected.staffName + ' · espèces attendues : ' + money(selected.expectedCash))
      : recent ? 'Dernière session clôturée · ' + recent.staffName + ' · attendu ' + money(recent.expectedAmount) + ' · compté ' + money(recent.closingAmount) + ' · écart ' + money(recent.difference) : 'Aucune session ouverte sur ce terminal.';
    $('close-session-button').disabled = !selected || selected.closeRequested;
    if (selected && document.activeElement !== $('closing-amount')) $('closing-amount').value = String(selected.expectedCash);
    const selectedStaff = state.posStaff.find((staff) => staff.id === staffSelect.value);
    $('open-session-button').disabled = !selectedStaff || state.cashSessions.some((session) => session.staffId === selectedStaff.id);
    $('open-session-help').textContent = state.posStaff.length ? 'Choisissez un caissier sans session ouverte et indiquez le fond de caisse.' : 'Aucun membre du personnel actif n’est disponible. Synchronisez les données ou vérifiez le personnel.';
    renderCart();
  } catch (error) { $('pos-session-summary').textContent = error.message || 'Impossible de charger les sessions.'; }
}

async function openPosCashSession() {
  const button = $('open-session-button'); button.disabled = true;
  try {
    const session = await window.eden.openCashSession({ staffId: $('pos-staff-select').value, openingAmount: Number($('opening-amount').value), terminalLabel: 'Eden Gestion Desktop' });
    state.activeCashSessionId = session.id; $('pos-feedback').textContent = 'Session ouverte localement. Elle sera synchronisée dès que le terminal sera approuvé et connecté.'; $('pos-feedback').className = 'feedback success';
    await loadPosState();
  } catch (error) { $('pos-feedback').textContent = error.message || 'Ouverture de session impossible.'; $('pos-feedback').className = 'feedback error'; }
  finally { button.disabled = false; void loadPosState(); }
}

async function closePosCashSession() {
  const selected = state.cashSessions.find((session) => session.id === state.activeCashSessionId);
  if (!selected || selected.closeRequested) return;
  const button = $('close-session-button'); button.disabled = true;
  try {
    await window.eden.requestCashSessionClose({ cashSessionId: selected.id, closingAmount: Number($('closing-amount').value), notes: '' });
    $('pos-feedback').textContent = 'Demande de clôture enregistrée localement. La session reste bloquée jusqu’à la confirmation du serveur après synchronisation des ventes.';
    $('pos-feedback').className = 'feedback success'; await loadPosState();
  } catch (error) { $('pos-feedback').textContent = error.message || 'Demande de clôture impossible.'; $('pos-feedback').className = 'feedback error'; }
  finally { button.disabled = false; void loadPosState(); }
}

async function checkoutPosSale() {
  if (!state.activeCashSessionId || !state.cart.size) return;
  const button = $('checkout-button'); button.disabled = true; button.textContent = 'Enregistrement local…';
  try {
    let total = 0; for (const item of state.cart.values()) total += item.product.price * item.quantity;
    const method = $('payment-method').value;
    const cashAmount = method === 'cash' ? total : method === 'mobile_money' ? 0 : Number($('cash-amount').value);
    const mobileAmount = method === 'mobile_money' ? total : method === 'cash' ? 0 : Number($('mobile-amount').value);
    const sale = await window.eden.createSale({ cashSessionId: state.activeCashSessionId, lines: [...state.cart.values()].map((item) => ({ productId: item.product.id, quantity: item.quantity })), paymentMethod: method, cashAmount, mobileAmount });
    state.cart.clear(); $('cash-amount').value = '0'; $('mobile-amount').value = '0';
    $('pos-feedback').textContent = 'Vente ' + sale.saleNumber + ' enregistrée localement : ' + money(sale.total) + '. Synchronisation en attente si le réseau ou l’approbation manque.'; $('pos-feedback').className = 'feedback success';
    renderCart(); await Promise.all([loadPosState(), refreshDashboard(), loadProducts()]);
  } catch (error) { $('pos-feedback').textContent = error.message || 'Encaissement impossible.'; $('pos-feedback').className = 'feedback error'; }
  finally { button.disabled = !state.activeCashSessionId || state.cart.size === 0; button.textContent = button.disabled ? 'Ouvrir une session pour encaisser' : 'Encaisser la vente'; }
}
function switchPage(page) {
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelectorAll('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
  $('page-title').textContent = page === 'products' ? 'Produits & stock' : page === 'sales' ? 'Caisse' : 'Vue d’ensemble';
  if (page === 'products' || page === 'sales') loadProducts();
  if (page === 'sales') void loadPosState();
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
  const localAccess = status?.canOperateLocally === true || authState === 'ready';
  $('app-shell').hidden = !localAccess;
  $('enrollment-screen').hidden = authState !== 'enrollment-required';
  $('storage-error-screen').hidden = authState === 'storage-error' && !localAccess;
  if (localAccess) initializeDashboard();
}

function handleStatus(status) {
  renderAuthState(status);
  if (status?.authState === 'ready' || status?.canOperateLocally === true) renderStatus(status);
  if (dashboardInitialized) void loadPosState();
}

function initializeDashboard() {
  if (dashboardInitialized) return;
  dashboardInitialized = true;
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => switchPage(button.dataset.page)));
  $('new-product').addEventListener('click', () => openProductDialog());
  $('pos-search').addEventListener('input', (event) => { state.posQuery=event.target.value; renderPosProducts(); });
  $('open-session-button').addEventListener('click', openPosCashSession);
  $('close-session-button').addEventListener('click', closePosCashSession);
  $('pos-staff-select').addEventListener('change', () => { void loadPosState(); });
  $('pos-session-select').addEventListener('change', (event) => { state.activeCashSessionId = event.target.value; void loadPosState(); });
  $('checkout-button').addEventListener('click', checkoutPosSale);
  $('cart-clear').addEventListener('click', () => { state.cart.clear(); renderCart(); });
  $('payment-method').addEventListener('change', renderCart);
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

  $('device-enrollment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('register-device-button');
    const feedback = $('device-enrollment-feedback');
    button.disabled = true;
    button.textContent = 'Enrôlement sécurisé…';
    feedback.className = 'feedback';
    feedback.textContent = 'Génération de la clé P-256 et vérification du code auprès du serveur…';
    try {
      const result = await window.eden.registerDevice({
        activationCode: $('activation-code').value,
        deviceName: $('device-name').value,
      });
      if (!result?.success) throw new Error(result?.error || 'Enrôlement cryptographique impossible.');
      $('activation-code').value = '';
      feedback.className = 'feedback success';
      feedback.textContent = `Terminal enregistré : ${result.deviceId}. Statut initial renvoyé par le serveur : ${result.approvalStatus}. Vérification du statut serveur en cours.`;
      handleStatus(await window.eden.getStatus());
    } catch (error) {
      feedback.className = 'feedback error';
      feedback.textContent = error.message || 'Enrôlement cryptographique impossible.';
    } finally {
      button.disabled = false;
      button.textContent = 'Enregistrer et sécuriser ce terminal';
    }
  });

  $('device-status-button').addEventListener('click', async () => {
    const button = $('device-status-button');
    button.disabled = true;
    button.textContent = 'Vérification…';
    try {
      const result = await window.eden.checkDeviceStatus();
      if (!result?.success) {
        setFeedback(result?.error || 'Statut du terminal indisponible. Les opérations locales sont conservées.', 'error');
      } else {
        handleStatus(await window.eden.getStatus());
        setFeedback(`Statut serveur : ${result.approvalStatus}.`, 'success');
      }
    } catch (error) {
      setFeedback(error.message || 'Impossible de vérifier le terminal.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Vérifier le terminal';
    }
  });
  $('sync-button').addEventListener('click', async () => {
    try { renderStatus(await window.eden.refresh()); }
    catch (error) { setFeedback(error.message || 'Synchronisation impossible.', 'error'); }
    await Promise.all([refreshDashboard(), loadProducts()]);
  });
  void refreshDashboard();
  void loadProducts();
  void loadPosState();
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
      feedback.textContent = 'Session agent chiffrée et vérifiée. La caisse locale est disponible ; la synchronisation attendra l’approbation du terminal.';
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
