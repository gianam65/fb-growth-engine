// Service worker: relays POST from content script (cross-origin) to Worker.
// content.js → chrome.runtime.sendMessage → background.js → fetch → response.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'save_affiliate') {
    (async () => {
      const cfg = await chrome.storage.local.get(['workerUrl', 'adminToken']);
      if (!cfg.workerUrl || !cfg.adminToken) {
        sendResponse({ ok: false, error: 'Setup not complete — open the extension popup first.' });
        return;
      }
      try {
        const res = await fetch(cfg.workerUrl.replace(/\/+$/, '') + '/admin/affiliate/url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + cfg.adminToken,
          },
          body: JSON.stringify(msg.data),
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
        if (!res.ok) {
          sendResponse({ ok: false, error: data.error || res.status });
          return;
        }
        sendResponse({ ok: true, ...data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err).slice(0, 200) });
      }
    })();
    return true; // async response
  }
});
