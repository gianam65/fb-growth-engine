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

// Open the product URL in a hidden tab, wait for SPA to render, scrape
// ONLY video URLs from DOM. Images intentionally NOT scraped — DOM has
// many product/variant/related images mixed together that produce wrong
// thumbnails. The listing-card image_url (captured at click time) is more
// reliable for a single product preview.
async function fetchVideoViaTab(productUrl) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: productUrl, active: false });
  } catch (e) {
    throw new Error('tabs.create: ' + e.message);
  }

  try {
    // Fixed wait — Shopee SPA never reliably fires 'complete'.
    await new Promise((r) => setTimeout(r, 9000));

    const [exec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const videos = new Set();

        // 1) <video src> + <source src>
        for (const v of document.querySelectorAll('video, video source')) {
          const src = v.src || v.getAttribute('src') || v.currentSrc || '';
          if (src && /^https?:/i.test(src) && !src.startsWith('blob:')) videos.add(src);
        }

        // 2) Search HTML source for Shopee video CDN patterns (.mp4)
        const html = document.documentElement.innerHTML;
        const cdnPatterns = [
          /https?:\/\/[a-z0-9\-.]*(?:susercontent|shopeevn|shopee\.cf|cvf\.shopee|vod\.susercontent)\.(?:com|vn|cf|sg)\/[^"'\s)<>]*\.mp4(?:\?[^"'\s)]*)?/gi,
          /https?:\/\/[^"'\s)<>]+\.mp4(?:\?[^"'\s)]*)?/gi,
        ];
        for (const re of cdnPatterns) {
          const matches = html.match(re) || [];
          for (const m of matches) {
            if (m.startsWith('blob:') || m.startsWith('data:')) continue;
            videos.add(m);
          }
        }

        // 3) data attributes
        for (const el of document.querySelectorAll('[data-video-url], [data-src*=".mp4"], [data-href*=".mp4"]')) {
          const src = el.getAttribute('data-video-url') || el.getAttribute('data-src') || el.getAttribute('data-href') || '';
          if (src && /^https?:/i.test(src)) videos.add(src);
        }

        // Prefer .mp4 (FB Reels can't play HLS m3u8)
        const sortedVideos = [...videos].sort((a, b) => {
          const ax = /\.mp4/i.test(a) ? 0 : 1;
          const bx = /\.mp4/i.test(b) ? 0 : 1;
          return ax - bx;
        });

        return { videos: sortedVideos };
      },
    });

    const r = exec?.result || { videos: [] };
    return { videos: r.videos || [] };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function fetchShopeeMedia(productUrl) {
  const parsed = parseProductUrl(productUrl);
  if (!parsed) return { error: 'cannot parse productUrl' };
  const canonical = `https://shopee.vn/product/${parsed.shopid}/${parsed.itemid}`;

  // Only fetch VIDEO via hidden tab. Images stay as the listing thumbnail
  // (data.image_url already captured at click time — accurate for the
  // specific product card the user clicked).
  try {
    const m = await fetchVideoViaTab(canonical);
    return {
      product_url: canonical,
      shopid: parsed.shopid,
      itemid: parsed.itemid,
      image_urls: [],   // intentionally empty — Worker falls back to listing image_url
      video_url: m.videos[0] || null,
      source: 'tab-video-only',
    };
  } catch (e) {
    return { error: 'tab: ' + String(e).slice(0, 100), parsed };
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

      // Step B: fetch VIDEO only via hidden tab (skip image scrape — listing
      // thumbnail in data.image_url is accurate; DOM scrape for images was
      // mixing unrelated/variant images).
      if (productUrl) {
        try {
          const media = await fetchShopeeMedia(productUrl);
          trace.media = media.error
            ? { ok: false, error: media.error }
            : { ok: true, has_video: !!media.video_url };
          console.log('[CV-bg] media result:', trace.media);
          if (!media.error) {
            // Don't set media_urls — Worker uses listing image_url instead.
            data.video_url = media.video_url;
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
