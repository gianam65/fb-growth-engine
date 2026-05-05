// Injects a "💾 CV" button on each Shopee affiliate product card.
// On click, scrapes title/image/price from THAT card, reads affiliate
// URL from clipboard, sends to background worker → POST /admin/affiliate/url.

(() => {
  if (window.__cvInjected) return;
  window.__cvInjected = true;

  // Heuristics for finding product cards on affiliate.shopee.vn.
  // Shopee SPA classes are obfuscated, so use multiple patterns.
  const CARD_SELECTORS = [
    'div[class*="product-card"]',
    'div[class*="ProductCard"]',
    'div[class*="offer-card"]',
    'div[class*="OfferCard"]',
    'a[class*="product-item"]',
    'div[class*="item-card"]',
    'div[class*="ItemCard"]',
    // Generic fallback: anything that's a child of a list and contains an img + text
    // (avoids matching whole page sections)
  ];

  // ---------- helpers ----------

  function visibleText(el, max = 200) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function findTitle(card) {
    // Try common product-title patterns
    const patterns = [
      '[class*="title" i]',
      '[class*="name" i]',
      '[class*="product-name" i]',
      'h1, h2, h3, h4',
      'a[href*="/product"]',
      'p',
    ];
    for (const sel of patterns) {
      const el = card.querySelector(sel);
      const t = visibleText(el);
      if (t && t.length >= 8 && t.length <= 200) return t;
    }
    return '';
  }

  function findImage(card) {
    const imgs = Array.from(card.querySelectorAll('img'));
    // Prefer larger, non-icon images
    imgs.sort((a, b) => {
      const aArea = (a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0);
      const bArea = (b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0);
      return bArea - aArea;
    });
    for (const img of imgs) {
      const src = img.src || img.getAttribute('data-src') || '';
      if (!src || src.startsWith('data:')) continue;
      // Avoid tiny icons
      const w = img.naturalWidth || img.width || 0;
      if (w > 0 && w < 80) continue;
      return src;
    }
    return '';
  }

  function findPrice(card) {
    const el = card.querySelector('[class*="price" i], [class*="Price" i]');
    const t = visibleText(el, 40);
    return t || '';
  }

  function isLikelyCard(el) {
    // A card should have at least 1 image and some text, and reasonable size
    const hasImg = el.querySelector('img');
    if (!hasImg) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return false;
    if (rect.width > window.innerWidth * 0.95 && rect.height > window.innerHeight * 0.9) return false; // whole page
    return true;
  }

  function showToast(text, kind = 'ok', timeout = 3000) {
    const t = document.createElement('div');
    t.className = 'cv-toast cv-' + kind;
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), timeout);
  }

  async function readClipboardShopeeUrl() {
    try {
      const txt = await navigator.clipboard.readText();
      if (/^https?:\/\/(s\.shopee\.vn|shope\.ee|shopee\.vn|invl\.io)\//i.test(txt.trim())) {
        return txt.trim();
      }
    } catch {}
    return '';
  }

  async function saveCard(card, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const data = {
        title: findTitle(card),
        image_url: findImage(card),
        price: findPrice(card),
        source_url: window.location.href,
      };

      // Get affiliate URL from clipboard
      let aff = await readClipboardShopeeUrl();
      if (!aff) {
        aff = prompt(
          'Paste affiliate link (clipboard had no Shopee link):',
          '',
        );
        if (!aff) {
          btn.disabled = false;
          btn.textContent = '💾 CV';
          return;
        }
      }
      data.affiliate_url = aff.trim();

      const res = await chrome.runtime.sendMessage({ type: 'save_affiliate', data });
      if (res?.ok) {
        btn.textContent = res.duplicate ? '✓ dup' : '✓ saved';
        btn.classList.add('cv-saved');
        showToast(
          (res.duplicate ? 'Already in pool: ' : 'Saved (id=' + res.id + '): ') + (data.title || aff).slice(0, 60),
          'ok',
        );
      } else {
        btn.textContent = '✗ err';
        btn.disabled = false;
        showToast('Save failed: ' + (res?.error || 'unknown'), 'err', 5000);
      }
    } catch (err) {
      btn.textContent = '✗';
      btn.disabled = false;
      showToast('Error: ' + err.message, 'err', 5000);
    }
  }

  function injectButton(card) {
    if (card.dataset.cvBtn) return;
    if (!isLikelyCard(card)) return;
    card.dataset.cvBtn = '1';

    const btn = document.createElement('button');
    btn.className = 'cv-save-btn';
    btn.textContent = '💾 CV';
    btn.title = 'Save to Cozy Vibe pool';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await saveCard(card, btn);
    });

    // Ensure positioning context
    const cs = getComputedStyle(card);
    if (cs.position === 'static') {
      card.style.position = 'relative';
    }
    card.appendChild(btn);
  }

  function scan() {
    const seen = new Set();
    for (const sel of CARD_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach((el) => seen.add(el));
      } catch {}
    }
    seen.forEach(injectButton);
  }

  // Initial scan + observe SPA route changes
  scan();
  const obs = new MutationObserver(() => {
    // Throttle
    if (window.__cvScanQueued) return;
    window.__cvScanQueued = true;
    requestAnimationFrame(() => {
      window.__cvScanQueued = false;
      scan();
    });
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Floating helper button (fallback when no cards detected)
  const helper = document.createElement('button');
  helper.className = 'cv-save-btn';
  helper.style.cssText += ';position:fixed!important;bottom:20px!important;right:20px!important;top:auto!important;padding:10px 14px!important;font-size:13px!important';
  helper.textContent = '💾 CV (page)';
  helper.title = 'Save current page as a product (uses page <h1> + og:image)';
  helper.addEventListener('click', async (e) => {
    e.preventDefault();
    const fakeCard = document.body;
    await saveCard(fakeCard, helper);
    helper.textContent = '💾 CV (page)';
    helper.disabled = false;
  });
  document.body.appendChild(helper);
})();
