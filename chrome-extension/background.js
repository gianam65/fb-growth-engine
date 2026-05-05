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

async function fetchShopeeMediaViaApi(parsed) {
  const apiUrl = `https://shopee.vn/api/v4/item/get?itemid=${parsed.itemid}&shopid=${parsed.shopid}`;
  const res = await fetch(apiUrl, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      Referer: `https://shopee.vn/product/${parsed.shopid}/${parsed.itemid}`,
      'X-API-SOURCE': 'pc',
    },
  });
  if (!res.ok) throw new Error('api ' + res.status);
  const json = await res.json();
  if (json.error || !json.data) throw new Error('shopee error ' + (json.error_msg || json.error || 'no data'));
  const data = json.data;
  const image_urls = (data.images || []).map((hash) => IMG_BASE + hash);
  let video_url = null;
  const v = data.video_info_list && data.video_info_list[0];
  if (v) {
    const list = v.video_url_list || [];
    const sorted = [...list].sort((a, b) => (b.default_format?.height || 0) - (a.default_format?.height || 0));
    video_url = (sorted[0] && sorted[0].url) || (v.default_format && v.default_format.url) || null;
  }
  return { title: data.name || '', image_urls, video_url };
}

async function fetchShopeeMediaViaHtml(productUrl) {
  // Fallback: scrape product page HTML for og:image + og:video + JSON-LD images.
  const res = await fetch(productUrl, { credentials: 'include', redirect: 'follow' });
  if (!res.ok) throw new Error('html ' + res.status);
  const html = await res.text();

  const images = new Set();
  const ogImg = (html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) || [])[1];
  if (ogImg) images.add(ogImg);

  const ogVid = (html.match(/<meta\s+property=["']og:video(?::secure_url)?["']\s+content=["']([^"']+)["']/i) || [])[1];
  let video_url = ogVid || null;

  // Try JSON-LD structured data
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  let title = '';
  while ((ldMatch = ldRe.exec(html))) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      if (Array.isArray(ld.image)) ld.image.forEach((u) => images.add(u));
      else if (typeof ld.image === 'string') images.add(ld.image);
      if (ld.video?.contentUrl) video_url = video_url || ld.video.contentUrl;
      if (ld.name && !title) title = ld.name;
    } catch {}
  }

  // Try Shopee's window.__INITIAL_STATE__ if present
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const candidates = [state?.product?.data, state?.item?.data, state?.item, state?.product];
      for (const d of candidates) {
        if (!d) continue;
        if (Array.isArray(d.images)) d.images.forEach((h) => images.add(IMG_BASE + h));
        if (d.video_info_list?.[0]) {
          const v = d.video_info_list[0];
          video_url = video_url || v.default_format?.url || v.video_url_list?.[0]?.url || null;
        }
        if (d.name && !title) title = d.name;
        break;
      }
    } catch {}
  }

  return { title, image_urls: [...images], video_url };
}

// Open the product URL in a background tab, wait for SPA to render, scrape
// images + video from DOM, close tab. Bypasses anti-bot because this runs
// as a real page in user's browser.
async function fetchShopeeMediaViaTab(productUrl) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: productUrl, active: false });
  } catch (e) {
    throw new Error('tabs.create: ' + e.message);
  }

  const waitForComplete = () =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('tab load timeout (15s)'));
      }, 15000);
      const listener = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

  try {
    await waitForComplete();
    // Wait for SPA to render images + video. Shopee finishes ~5-7s.
    await new Promise((r) => setTimeout(r, 6000));

    const [exec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // ----- images -----
        const imgs = new Set();
        for (const img of document.images) {
          const src = img.src || img.getAttribute('data-src') || '';
          if (!/susercontent\.com|shopee\.vn/i.test(src)) continue;
          if ((img.naturalWidth || 0) < 200) continue;
          imgs.add(src);
        }

        // ----- videos: try multiple sources -----
        const videos = new Set();
        // 1) <video src> + <source src>
        for (const v of document.querySelectorAll('video, video source')) {
          const src = v.src || v.getAttribute('src') || v.currentSrc || '';
          if (src && /^https?:/i.test(src) && !src.startsWith('blob:')) videos.add(src);
        }
        // 2) Search HTML source for known Shopee video CDN patterns (mp4, m3u8)
        const html = document.documentElement.innerHTML;
        const cdnPatterns = [
          /https?:\/\/[a-z0-9\-.]*(?:susercontent|shopeevn|shopee\.cf|cvf\.shopee)\.(?:com|vn|cf)\/file\/[a-zA-Z0-9_-]+\.mp4(?:\?[^"'\s)]*)?/gi,
          /https?:\/\/[^"'\s)<>]+\.(?:mp4|m3u8)(?:\?[^"'\s)]*)?/gi,
        ];
        for (const re of cdnPatterns) {
          const matches = html.match(re) || [];
          for (const m of matches) {
            // Filter blob/data
            if (m.startsWith('blob:') || m.startsWith('data:')) continue;
            videos.add(m);
          }
        }
        // 3) Search data attributes (some video components store URL in data-*)
        for (const el of document.querySelectorAll('[data-video-url], [data-src*=".mp4"], [data-href*=".mp4"]')) {
          const src = el.getAttribute('data-video-url') || el.getAttribute('data-src') || el.getAttribute('data-href') || '';
          if (src && /^https?:/i.test(src)) videos.add(src);
        }

        const titleEl = document.querySelector('h1, [class*="product-title" i]');
        const title = (titleEl?.innerText || document.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);

        // Prefer .mp4 over .m3u8 (FB Reels needs mp4)
        const sortedVideos = [...videos].sort((a, b) => {
          const ax = /\.mp4/i.test(a) ? 0 : 1;
          const bx = /\.mp4/i.test(b) ? 0 : 1;
          return ax - bx;
        });

        return {
          images: [...imgs],
          videos: sortedVideos,
          title,
          html_size: html.length,
        };
      },
    });

    const r = exec?.result || { images: [], videos: [], title: '' };
    return { ...r };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function fetchShopeeMedia(productUrl) {
  const parsed = parseProductUrl(productUrl);
  if (!parsed) return { error: 'cannot parse productUrl' };
  const canonical = `https://shopee.vn/product/${parsed.shopid}/${parsed.itemid}`;

  // Try API (richest data, but Shopee usually 403s extension)
  let errs = [];
  try {
    const m = await fetchShopeeMediaViaApi(parsed);
    if (m.image_urls.length > 0) {
      return { product_url: canonical, shopid: parsed.shopid, itemid: parsed.itemid, ...m, source: 'api' };
    }
  } catch (e) { errs.push('api: ' + String(e).slice(0, 60)); }

  // Try HTML scrape (often empty for SPA)
  try {
    const m = await fetchShopeeMediaViaHtml(productUrl);
    if (m.image_urls.length > 0) {
      return { product_url: canonical, shopid: parsed.shopid, itemid: parsed.itemid, ...m, source: 'html' };
    }
  } catch (e) { errs.push('html: ' + String(e).slice(0, 60)); }

  // Last resort: open hidden tab, scrape rendered DOM
  try {
    const m = await fetchShopeeMediaViaTab(canonical);
    if (m.images.length > 0 || m.videos.length > 0) {
      return {
        product_url: canonical,
        shopid: parsed.shopid,
        itemid: parsed.itemid,
        title: m.title || '',
        image_urls: m.images,
        video_url: m.videos[0] || null,
        source: 'hidden-tab',
      };
    }
    errs.push('tab: 0 media');
  } catch (e) { errs.push('tab: ' + String(e).slice(0, 60)); }

  return { error: errs.join(' | '), parsed };
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
      const trace = { resolve: null, media: null };

      // Step A: resolve s.shopee.vn → product URL (using user's session)
      let productUrl = data.product_url || null;
      if (!productUrl && /s\.shopee\.vn|shope\.ee/i.test(data.affiliate_url)) {
        try {
          productUrl = await resolveShortLink(data.affiliate_url);
          trace.resolve = { ok: !!productUrl, url: productUrl };
        } catch (err) {
          trace.resolve = { ok: false, error: String(err).slice(0, 200) };
        }
        console.log('[CV-bg] resolved:', productUrl);
      } else {
        trace.resolve = { ok: !!productUrl, url: productUrl, skipped: true };
      }
      if (productUrl) data.product_url = productUrl;

      // Step B: fetch Shopee item API for full media (still using session)
      if (productUrl) {
        try {
          const media = await fetchShopeeMedia(productUrl);
          trace.media = media.error
            ? { ok: false, error: media.error }
            : { ok: true, images: media.image_urls?.length, has_video: !!media.video_url };
          console.log('[CV-bg] media result:', trace.media);
          if (!media.error) {
            data.media_urls = media.image_urls;
            data.video_url = media.video_url;
            if (!data.title || data.title.length < 5) data.title = media.title;
            data.shopee_shopid = media.shopid;
            data.shopee_itemid = media.itemid;
          } else {
            data.media_fetch_error = media.error;
          }
        } catch (err) {
          trace.media = { ok: false, error: String(err).slice(0, 200) };
          data.media_fetch_error = String(err).slice(0, 200);
        }
      } else {
        trace.media = { ok: false, error: 'no productUrl to fetch from' };
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
          sendResponse({ ok: false, error: result.error || res.status, trace });
          return;
        }
        sendResponse({ ok: true, ...result, trace });
      } catch (err) {
        console.error('[CV-bg] fetch error:', err);
        sendResponse({ ok: false, error: String(err).slice(0, 200), trace });
      }
    })();
    return true;
  }
});
