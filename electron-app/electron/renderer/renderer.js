const count = document.getElementById('product-count');
const status = document.getElementById('sync-status');
const refresh = document.getElementById('refresh');

function render(value) {
  count.textContent = String(value.productCount ?? 0);
  status.textContent = value.message || value.state || 'État inconnu';
  refresh.disabled = value.state === 'syncing';
  refresh.textContent = value.state === 'syncing' ? 'Synchronisation…' : 'Synchroniser maintenant';
}

window.addEventListener('DOMContentLoaded', async () => {
  render(await window.eden.getStatus());
  refresh.addEventListener('click', async () => render(await window.eden.refresh()));
});

