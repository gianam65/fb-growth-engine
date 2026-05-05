// Popup script: settings (one-time) + add-product form.

const $ = (id) => document.getElementById(id);

// Use sync storage so settings persist across reloads + sync to Chrome account.
// Falls back to local if sync unavailable (e.g., user not signed in).
async function getStored() {
  try {
    const sync = await chrome.storage.sync.get(['workerUrl', 'adminToken']);
    if (sync.workerUrl && sync.adminToken) return sync;
  } catch {}
  return await chrome.storage.local.get(['workerUrl', 'adminToken']);
}

async function setStored(data) {
  // Write to BOTH for redundancy
  try { await chrome.storage.sync.set(data); } catch {}
  await chrome.storage.local.set(data);
}

function showMsg(text, kind) {
  const $msg = $('msg');
  $msg.textContent = text;
  $msg.className = 'msg ' + (kind || 'ok');
  $msg.hidden = false;
}

function hideMsg() {
  $('msg').hidden = true;
}

function showSettings() {
  $('settings').hidden = false;
  $('add').hidden = true;
}

function showAdd() {
  $('settings').hidden = true;
  $('add').hidden = false;
}

async function fetchTabContext() {
  // Use chrome.scripting to grab title, og:image, biggest image, current URL
  // from the active tab. Returns null if can't (e.g., chrome:// pages).
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
    return null;
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const og = (prop) => document.querySelector(`meta[property="${prop}"]`)?.content || '';
        const titleEl = document.querySelector('h1') || document.querySelector('h2');
        // Largest image visible on page
        const imgs = Array.from(document.images).filter((img) => img.naturalWidth >= 200 && img.naturalHeight >= 200);
        imgs.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
        return {
          url: window.location.href,
          title: og('og:title') || titleEl?.innerText?.trim() || document.title,
          image: og('og:image') || (imgs[0]?.src ?? ''),
          // Try common Shopee price selectors
          price: document.querySelector('[class*="price"], [class*="Price"]')?.innerText?.trim().slice(0, 40) || '',
        };
      },
    });
    return res?.result ?? null;
  } catch {
    return null;
  }
}

async function tryClipboard() {
  try {
    const txt = await navigator.clipboard.readText();
    if (/^https?:\/\/(s\.shopee\.vn|shope\.ee|shopee\.vn|invl\.io)\//i.test(txt)) return txt.trim();
  } catch {}
  return '';
}

async function init() {
  const cfg = await getStored();
  if (!cfg.workerUrl || !cfg.adminToken) {
    showSettings();
    if (cfg.workerUrl) $('workerUrl').value = cfg.workerUrl;
    return;
  }
  showAdd();

  // Pre-fill from active tab
  const ctx = await fetchTabContext();
  if (ctx) {
    if (ctx.title) $('title').value = ctx.title;
    if (ctx.image) {
      $('imageUrl').value = ctx.image;
      $('previewImg').src = ctx.image;
      $('previewWrap').hidden = false;
    }
    if (ctx.price) $('price').value = ctx.price;
  }
  // Try clipboard for affiliate URL
  const clip = await tryClipboard();
  if (clip) $('affiliateUrl').value = clip;
  $('affiliateUrl').focus();
}

$('saveSettings').addEventListener('click', async () => {
  const workerUrl = $('workerUrl').value.trim().replace(/\/+$/, '');
  const adminToken = $('adminToken').value.trim();
  if (!workerUrl || !adminToken) {
    alert('Both fields required');
    return;
  }
  await setStored({ workerUrl, adminToken });
  await init();
});

$('openSettings').addEventListener('click', async () => {
  const cfg = await getStored();
  $('workerUrl').value = cfg.workerUrl ?? '';
  $('adminToken').value = cfg.adminToken ?? '';
  showSettings();
});

async function openPoolPage(path) {
  const cfg = await getStored();
  if (!cfg.workerUrl || !cfg.adminToken) return;
  const url = cfg.workerUrl.replace(/\/+$/, '') + path + '?key=' + encodeURIComponent(cfg.adminToken);
  chrome.tabs.create({ url });
}
$('viewAffiliate').addEventListener('click', () => openPoolPage('/admin/affiliate'));
$('viewPhotos').addEventListener('click', () => openPoolPage('/admin/curate'));

$('save').addEventListener('click', async () => {
  hideMsg();
  const cfg = await getStored();
  if (!cfg.workerUrl || !cfg.adminToken) {
    showSettings();
    return;
  }
  const aff = $('affiliateUrl').value.trim();
  if (!aff || !/^https?:\/\//i.test(aff)) {
    showMsg('Affiliate link required (must start with https://)', 'err');
    return;
  }
  const body = {
    affiliate_url: aff,
    title: $('title').value.trim() || null,
    image_url: $('imageUrl').value.trim() || null,
    price: $('price').value.trim() || null,
    source_url: (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url ?? null,
  };

  $('save').disabled = true;
  try {
    const res = await fetch(cfg.workerUrl + '/admin/affiliate/url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.adminToken,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    if (data.duplicate) {
      showMsg('✓ Already in pool (id=' + data.id + ')', 'ok');
    } else {
      showMsg('✓ Saved to pool (id=' + data.id + ')', 'ok');
      // Clear affiliate URL so user knows it succeeded
      $('affiliateUrl').value = '';
    }
  } catch (err) {
    showMsg('✗ ' + err.message, 'err');
  } finally {
    $('save').disabled = false;
  }
});

init();
