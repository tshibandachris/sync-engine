const count = document.getElementById('product-count');
const status = document.getElementById('sync-status');
const refresh = document.getElementById('refresh');

function render(value) {
  count.textContent = String(value.productCount ?? 0);
  const queue = Number(value.outboxPending ?? 0);
  const failed = Number(value.outboxFailed ?? 0);
  status.textContent = `${value.message || value.state || 'État inconnu'} · file locale : ${queue} en attente, ${failed} avec erreur`;
  refresh.disabled = value.state === 'syncing';
  refresh.textContent = value.state === 'syncing' ? 'Synchronisation…' : 'Synchroniser maintenant';
}

window.addEventListener('DOMContentLoaded', async () => {
  render(await window.eden.getStatus());
  refresh.addEventListener('click', async () => render(await window.eden.refresh()));
});

