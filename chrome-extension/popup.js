// Simplified popup: settings + 2 nav buttons. No product form.
// Saves happen via 💾 CV buttons injected on affiliate.shopee.vn pages.

const $ = (id) => document.getElementById(id);

async function getStored() {
  try {
    const sync = await chrome.storage.sync.get(['workerUrl', 'adminToken']);
    if (sync.workerUrl && sync.adminToken) return sync;
  } catch {}
  return await chrome.storage.local.get(['workerUrl', 'adminToken']);
}

async function setStored(data) {
  try { await chrome.storage.sync.set(data); } catch {}
  await chrome.storage.local.set(data);
}

function showSettings(canCancel = false) {
  $('settings').hidden = false;
  $('main').hidden = true;
  $('cancelSettings').hidden = !canCancel;
}

function showMain() {
  $('settings').hidden = true;
  $('main').hidden = false;
}

function settingsMsg(text, kind) {
  const el = $('settingsMsg');
  el.textContent = text;
  el.className = 'msg ' + (kind || 'ok');
  el.hidden = false;
}

async function init() {
  const cfg = await getStored();
  if (!cfg.workerUrl || !cfg.adminToken) {
    showSettings(false);
    return;
  }
  showMain();
}

$('saveSettings').addEventListener('click', async () => {
  const workerUrl = $('workerUrl').value.trim().replace(/\/+$/, '');
  const adminToken = $('adminToken').value.trim();
  if (!workerUrl || !adminToken) {
    settingsMsg('Both fields required', 'err');
    return;
  }
  await setStored({ workerUrl, adminToken });
  settingsMsg('✓ Saved', 'ok');
  setTimeout(() => showMain(), 400);
});

$('openSettings').addEventListener('click', async () => {
  const cfg = await getStored();
  $('workerUrl').value = cfg.workerUrl ?? '';
  $('adminToken').value = cfg.adminToken ?? '';
  $('settingsMsg').hidden = true;
  showSettings(true);
});

$('cancelSettings').addEventListener('click', () => {
  showMain();
});

async function openPoolPage(path) {
  const cfg = await getStored();
  if (!cfg.workerUrl || !cfg.adminToken) {
    showSettings(false);
    return;
  }
  const url = cfg.workerUrl.replace(/\/+$/, '') + path + '?key=' + encodeURIComponent(cfg.adminToken);
  chrome.tabs.create({ url });
}

$('viewAffiliate').addEventListener('click', () => openPoolPage('/admin/affiliate'));
$('viewPhotos').addEventListener('click', () => openPoolPage('/admin/curate'));

init();
