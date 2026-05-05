// One-click affiliate save on affiliate.shopee.vn:
// User clicks 💾 CV on a product card → script auto-clicks Shopee's
// "Get Link" button, observes DOM for the s.shopee.vn URL when it appears,
// extracts it + scrapes title/image of THAT card → sends to Worker.
// Also: floating "💾 Save all on this page" batch button.

(() => {
  if (window.__cvInjected) return;
  window.__cvInjected = true;

  const CARD_SELECTORS = [
    'div[class*="product-card"]',
    'div[class*="ProductCard"]',
    'div[class*="offer-card"]',
    'div[class*="OfferCard"]',
    'a[class*="product-item"]',
    'div[class*="item-card"]',
    'div[class*="ItemCard"]',
  ];

  const GET_LINK_KEYWORDS = [
    'tạo link',
    'get link',
    'lấy link',
    'sao chép link',
    'copy link',
    'nhận link',
    'tạo đường dẫn',
    'sao chép',
    'copy',
    'generate',
    'link',
    'tạo',
  ];

  const SHOPEE_LINK_RE = /https?:\/\/(s\.shopee\.vn|shope\.ee)\/[A-Za-z0-9_-]+/i;

  // ---------- helpers ----------

  function visibleText(el, max = 200) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function findTitle(card) {
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
    imgs.sort((a, b) => {
      const aArea = (a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0);
      const bArea = (b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0);
      return bArea - aArea;
    });
    for (const img of imgs) {
      const src = img.src || img.getAttribute('data-src') || '';
      if (!src || src.startsWith('data:')) continue;
      const w = img.naturalWidth || img.width || 0;
      if (w > 0 && w < 80) continue;
      return src;
    }
    return '';
  }

  function findPrice(card) {
    const el = card.querySelector('[class*="price" i], [class*="Price" i]');
    return visibleText(el, 40);
  }

  function isLikelyCard(el) {
    const hasImg = el.querySelector('img');
    if (!hasImg) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return false;
    if (rect.width > window.innerWidth * 0.95 && rect.height > window.innerHeight * 0.9) return false;
    return true;
  }

  function findGetLinkButton(card) {
    // Prefer buttons inside the card; fall back to anything with the right text
    const candidates = card.querySelectorAll('button, a[role="button"], div[role="button"], a, [class*="btn"], [class*="Button"]');
    for (const btn of candidates) {
      const text = visibleText(btn, 50).toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      const haystack = `${text} ${aria} ${title}`;
      if (!haystack.trim()) continue;
      if (GET_LINK_KEYWORDS.some((k) => haystack.includes(k))) {
        return btn;
      }
    }
    return null;
  }

  function scanDomForShopeeUrl() {
    // Look in <a href>, <input value>, [data-clipboard-text], any text node
    const anchors = document.querySelectorAll('a[href*="s.shopee.vn"], a[href*="shope.ee"]');
    for (const a of anchors) {
      const m = a.href.match(SHOPEE_LINK_RE);
      if (m) return m[0];
    }
    const inputs = document.querySelectorAll('input[value*="s.shopee.vn"], input[value*="shope.ee"]');
    for (const i of inputs) {
      const m = (i.value || '').match(SHOPEE_LINK_RE);
      if (m) return m[0];
    }
    const dataAttrs = document.querySelectorAll('[data-clipboard-text]');
    for (const el of dataAttrs) {
      const v = el.getAttribute('data-clipboard-text') || '';
      const m = v.match(SHOPEE_LINK_RE);
      if (m) return m[0];
    }
    // Walk visible text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      const m = text.match(SHOPEE_LINK_RE);
      if (m) return m[0];
    }
    return null;
  }

  function waitForShopeeUrl(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const found = scanDomForShopeeUrl();
      if (found) return resolve(found);

      const obs = new MutationObserver(() => {
        const url = scanDomForShopeeUrl();
        if (url) {
          obs.disconnect();
          resolve(url);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value', 'data-clipboard-text', 'href'] });

      setTimeout(() => {
        obs.disconnect();
        reject(new Error('Timeout — Shopee link did not appear'));
      }, timeoutMs);
    });
  }

  const COPY_KEYWORDS = [
    'sao chép link',
    'sao chép đường dẫn',
    'sao chép',
    'copy link',
    'copy url',
    'copy',
    'sao',
  ];

  function tryClickInModal(textKeywords = COPY_KEYWORDS) {
    // Find any visible button matching keywords (Copy/Sao chép inside Shopee's modal)
    const allBtns = document.querySelectorAll('button, a[role="button"], div[role="button"], [class*="btn"], [class*="Button"]');
    for (const btn of allBtns) {
      if (btn.offsetParent === null) continue; // hidden
      const text = visibleText(btn, 30).toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const haystack = `${text} ${aria}`;
      if (!haystack.trim()) continue;
      if (textKeywords.some((k) => haystack.includes(k))) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function tryCloseModal() {
    // ESC + close-button heuristics
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    const closes = document.querySelectorAll('[aria-label*="close" i], [class*="close-button" i], button[class*="close" i]');
    for (const c of closes) {
      if (c.offsetParent !== null) c.click();
    }
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
      if (SHOPEE_LINK_RE.test(txt.trim())) return txt.trim();
    } catch {}
    return null;
  }

  // ---------- core save ----------

  async function autoSaveCard(card, btn, opts = {}) {
    const { armedTimeoutMs = 30_000 } = opts;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '…';
    }
    let affUrl = null;
    let savedTitle = '';
    try {
      const data = {
        title: findTitle(card),
        image_url: findImage(card),
        price: findPrice(card),
        source_url: window.location.href,
      };
      savedTitle = data.title;

      // Step 1: clipboard (user may have already copied link manually)
      affUrl = await readClipboardShopeeUrl();

      // Step 2: scan current DOM (modal might already be open with the link)
      if (!affUrl) affUrl = scanDomForShopeeUrl();

      // Step 3: try to programmatically click Shopee's Get Link button on the card
      if (!affUrl) {
        const getLinkBtn = findGetLinkButton(card);
        if (getLinkBtn) {
          getLinkBtn.click();
          // Brief pause for modal to render, then auto-click Sao chép button
          await new Promise((r) => setTimeout(r, 400));
          const copied = tryClickInModal();
          if (copied) {
            // Sao chép should put URL on clipboard. Brief wait then read.
            await new Promise((r) => setTimeout(r, 250));
            affUrl = (await readClipboardShopeeUrl()) || scanDomForShopeeUrl();
          }
          // If still no URL, wait longer in case of network delay
          if (!affUrl) {
            try {
              affUrl = await waitForShopeeUrl(5000);
            } catch {
              affUrl = (await readClipboardShopeeUrl()) || null;
            }
          }
          tryCloseModal();
        }
      }

      // Step 4: hybrid "armed" mode — if auto-click couldn't find/click button,
      // tell user to click "Tạo link" themselves. Watch DOM for up to N seconds.
      if (!affUrl) {
        if (btn) btn.textContent = '⏳ click Tạo link…';
        showToast(
          'Click "Tạo link" / "Get Link" on Shopee — I\'ll catch the URL automatically (' + Math.round(armedTimeoutMs / 1000) + 's)',
          'ok',
          armedTimeoutMs,
        );
        try {
          affUrl = await waitForShopeeUrl(armedTimeoutMs);
        } catch {
          // timeout
        }
        tryCloseModal();
      }

      // Step 5: still nothing → bail
      if (!affUrl) {
        if (btn) { btn.disabled = false; btn.textContent = '💾 CV'; }
        return { ok: false, skipped: true, error: 'No affiliate URL detected — try clicking Tạo link first then 💾 CV again' };
      }
      data.affiliate_url = affUrl.trim();

      // Step 4: send to background → Worker
      const res = await chrome.runtime.sendMessage({ type: 'save_affiliate', data });
      if (res?.ok) {
        if (btn) {
          btn.textContent = res.duplicate ? '✓ dup' : '✓ saved';
          btn.classList.add('cv-saved');
        }
        return { ok: true, duplicate: !!res.duplicate, id: res.id, title: savedTitle };
      } else {
        if (btn) {
          btn.textContent = '✗ err';
          btn.disabled = false;
        }
        return { ok: false, error: res?.error || 'unknown' };
      }
    } catch (err) {
      if (btn) {
        btn.textContent = '✗';
        btn.disabled = false;
      }
      return { ok: false, error: String(err).slice(0, 200) };
    }
  }

  function injectButton(card) {
    if (card.dataset.cvBtn) return;
    if (!isLikelyCard(card)) return;
    card.dataset.cvBtn = '1';

    const btn = document.createElement('button');
    btn.className = 'cv-save-btn';
    btn.textContent = '💾 CV';
    btn.title = 'Save to Cozy Vibe pool (auto-clicks Get Link)';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const res = await autoSaveCard(card, btn);
      if (res.ok) {
        showToast((res.duplicate ? 'Already in pool: ' : 'Saved: ') + (res.title || '').slice(0, 60), 'ok');
      } else if (!res.skipped) {
        showToast('Save failed: ' + (res.error || 'unknown'), 'err', 5000);
      }
    });

    const cs = getComputedStyle(card);
    if (cs.position === 'static') card.style.position = 'relative';
    card.appendChild(btn);
  }

  function getAllCards() {
    const seen = new Set();
    for (const sel of CARD_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach((el) => seen.add(el));
      } catch {}
    }
    return [...seen].filter(isLikelyCard);
  }

  function scan() {
    getAllCards().forEach(injectButton);
  }

  // ---------- batch ----------

  async function batchSaveAll() {
    const cards = getAllCards();
    if (cards.length === 0) {
      showToast('No product cards detected on this page.', 'err');
      return;
    }
    const total = cards.length;
    let ok = 0, dup = 0, fail = 0;
    showToast(`Batch starting: ${total} cards. This will take ~${Math.ceil((total * 6) / 60)} min.`, 'ok', 4500);

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      // Reset button state if it was already used
      const btn = card.querySelector('.cv-save-btn');
      if (btn && btn.classList.contains('cv-saved')) {
        // Skip already-saved
        ok++;
        continue;
      }
      try {
        const res = await autoSaveCard(card, btn);
        if (res.ok) {
          if (res.duplicate) dup++; else ok++;
        } else if (!res.skipped) {
          fail++;
        }
      } catch (err) {
        fail++;
      }
      // Update batch progress button
      if (window.__cvBatchBtn) {
        window.__cvBatchBtn.textContent = `💾 Saving ${i + 1}/${total}…`;
      }
      // Small delay to let modals close + avoid overwhelming Shopee
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (window.__cvBatchBtn) window.__cvBatchBtn.textContent = '💾 Save all on page';
    showToast(`Batch done: ${ok} saved, ${dup} dup, ${fail} failed`, fail > 0 ? 'err' : 'ok', 5000);
  }

  // ---------- floating buttons ----------

  function injectFloatingControls() {
    if (window.__cvFloatingInjected) return;
    window.__cvFloatingInjected = true;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed!important;bottom:20px!important;right:20px!important;z-index:99999!important;display:flex!important;flex-direction:column!important;gap:8px!important;align-items:flex-end!important';

    const batch = document.createElement('button');
    batch.className = 'cv-save-btn';
    batch.style.cssText += ';position:static!important;padding:10px 14px!important;font-size:13px!important';
    batch.textContent = '💾 Save all on page';
    batch.title = 'Auto-save every product card visible on this page';
    batch.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Save ALL product cards on this page? This will take a while.')) return;
      batch.disabled = true;
      try { await batchSaveAll(); } finally { batch.disabled = false; }
    });
    window.__cvBatchBtn = batch;

    wrap.appendChild(batch);
    document.body.appendChild(wrap);
  }

  // ---------- init ----------

  scan();
  injectFloatingControls();

  const obs = new MutationObserver(() => {
    if (window.__cvScanQueued) return;
    window.__cvScanQueued = true;
    requestAnimationFrame(() => {
      window.__cvScanQueued = false;
      scan();
    });
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
