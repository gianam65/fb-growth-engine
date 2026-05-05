// Service worker: resolves Shopee short link, fetches product media via
// Shopee's item API (using user's session cookies → bypasses anti-bot),
// then forwards all data to the Worker.

const IMG_BASE = 'https://down-vn.img.susercontent.com/file/';

async function getCfg() {
  // Try sync first, fall back to local
  try {
    const sync = await chrome.storage.sync.get(['workerUrl', 'adminToken']);
    if (sync.workerUrl && sync.adminToken) return sync;
  } catch {}
  return await chrome.storage.local.get(['workerUrl', 'adminToken']);
}

function parseProductUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('shopee.vn')) return null;
    const a = u.pathname.match(/-i\.(\d+)\.(\d+)/);
    if (a) return { shopid: a[1], itemid: a[2] };
    const b = u.pathname.match(/^\/[a-z][a-z0-9-]*\/(\d+)\/(\d+)(?:\/|$|\?)/i);
    if (b) return { shopid: b[1], itemid: b[2] };
    return null;
  } catch {
    return null;
  }
}

async function resolveShortLink(shortUrl) {
  // Background fetch with redirect:'follow' should chase Shopee's 301.
  try {
    const res = await fetch(shortUrl, { method: 'GET', redirect: 'follow', credentials: 'include' });
    if (res.url && res.url !== shortUrl && parseProductUrl(res.url)) return res.url;
    const text = await res.text();
    const patterns = [
      /<meta\s+http-equiv=["']refresh["']\s+content=["'][^"']*url=([^"'\s]+)/i,
      /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
      /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
      /(https?:\/\/shopee\.vn\/[^\s"'<>)]+)/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1] && parseProductUrl(m[1])) return m[1];
    }
  } catch (err) {
    console.warn('[CV-bg] resolveShortLink error:', err);
  }
  return null;
}

async function fetchShopeeMedia(productUrl) {
  const parsed = parseProductUrl(productUrl);
  if (!parsed) return { error: 'cannot parse productUrl' };
  const apiUrl = `https://shopee.vn/api/v4/item/get?itemid=${parsed.itemid}&shopid=${parsed.shopid}`;
  try {
    const res = await fetch(apiUrl, {
      credentials: 'include', // include user's Shopee session cookies
      headers: {
        Accept: 'application/json',
        Referer: `https://shopee.vn/product/${parsed.shopid}/${parsed.itemid}`,
        'X-API-SOURCE': 'pc',
      },
    });
    if (!res.ok) return { error: 'item api ' + res.status, parsed };
    const json = await res.json();
    if (json.error || !json.data) return { error: 'shopee error ' + (json.error_msg || json.error || 'no data'), parsed };
    const data = json.data;
    const image_urls = (data.images || []).map((hash) => IMG_BASE + hash);
    let video_url = null;
    const v = data.video_info_list && data.video_info_list[0];
    if (v) {
      const list = v.video_url_list || [];
      const sorted = [...list].sort((a, b) => (b.default_format?.height || 0) - (a.default_format?.height || 0));
      video_url = (sorted[0] && sorted[0].url) || (v.default_format && v.default_format.url) || null;
    }
    return {
      product_url: `https://shopee.vn/product/${parsed.shopid}/${parsed.itemid}`,
      shopid: parsed.shopid,
      itemid: parsed.itemid,
      title: data.name || '',
      image_urls,
      video_url,
    };
  } catch (err) {
    return { error: String(err).slice(0, 200), parsed };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'save_affiliate') {
    (async () => {
      const cfg = await getCfg();
      if (!cfg.workerUrl || !cfg.adminToken) {
        sendResponse({ ok: false, error: 'Setup not complete — open the extension popup first.' });
        return;
      }

      const data = { ...msg.data };

      // Step A: resolve s.shopee.vn → product URL (using user's session)
      let productUrl = data.product_url || null;
      if (!productUrl && /s\.shopee\.vn|shope\.ee/i.test(data.affiliate_url)) {
        productUrl = await resolveShortLink(data.affiliate_url);
        console.log('[CV-bg] resolved:', productUrl);
      }
      if (productUrl) data.product_url = productUrl;

      // Step B: fetch Shopee item API for full media (still using session)
      if (productUrl) {
        const media = await fetchShopeeMedia(productUrl);
        console.log('[CV-bg] media result:', media.error ? { error: media.error } : { images: media.image_urls?.length, has_video: !!media.video_url });
        if (!media.error) {
          data.media_urls = media.image_urls;
          data.video_url = media.video_url;
          if (!data.title || data.title.length < 5) data.title = media.title;
          data.shopee_shopid = media.shopid;
          data.shopee_itemid = media.itemid;
        } else {
          data.media_fetch_error = media.error;
        }
      }

      // Step C: POST to Worker
      try {
        const url = cfg.workerUrl.replace(/\/+$/, '') + '/admin/affiliate/url';
        console.log('[CV-bg] POST', url, data);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + cfg.adminToken,
          },
          body: JSON.stringify(data),
        });
        const text = await res.text();
        let result;
        try { result = JSON.parse(text); } catch { result = { error: text.slice(0, 200) }; }
        console.log('[CV-bg] worker response', res.status, result);
        if (!res.ok) {
          sendResponse({ ok: false, error: result.error || res.status });
          return;
        }
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error('[CV-bg] fetch error:', err);
        sendResponse({ ok: false, error: String(err).slice(0, 200) });
      }
    })();
    return true;
  }
});
