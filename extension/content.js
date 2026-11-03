// Injected by the service worker ONLY into the recorded tab (all frames) while a recording runs.
// Tracks user actions, dialogs and UI stabilisation. Safe to inject repeatedly.
(() => {
  'use strict';
  if (window.__sprRecorder) { window.__sprRecorder.hello(); return; }

  const R = (window.__sprRecorder = {});
  const isTop = window === window.top;
  let cfg = null;
  let active = false;
  let installed = false;
  let maskSel = '';
  let maskRe = null;
  let lastActivity = Date.now();
  let waiting = false;
  let beforeToken = null;
  let helloP = Promise.resolve();
  const pending = new Set();
  const openDialogs = new Map();
  const seenToasts = new WeakSet();

  const send = (m) => {
    try { return chrome.runtime.sendMessage(m).catch(() => null); } catch { return Promise.resolve(null); }
  };
  const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n = 100) => { s = txt(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const visible = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };

  // ---- element description ----------------------------------------------------------------
  const INTERACTIVE = [
    'button', 'a[href]', 'a[role]', 'summary', 'input', 'select', 'textarea', 'label',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="menuitemcheckbox"]',
    '[role="tab"]', '[role="option"]', '[role="treeitem"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]',
    '[role="combobox"]', '[role="gridcell"]', '[role="row"]',
    '.sapMBtn', '.sapMLnk', '.sapMLIB', '.sapMSLI', '.sapMGT', '.sapUshellTile', '.sapUiTableRow', '.sapMObjLItem',
  ].join(',');
  const NON_TEXT_INPUT = /^(button|submit|reset|image|checkbox|radio|file|range|color)$/i;

  const byIds = (ids) => txt(ids.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' '));

  function labelFor(el) {
    let s = txt(el.getAttribute('aria-label'));
    if (s) return cut(s);
    const lb = el.getAttribute('aria-labelledby');
    if (lb && (s = byIds(lb))) return cut(s);
    if (el.labels?.length && (s = txt(el.labels[0].textContent))) return cut(s);
    const wrap = el.closest('.sapMInputBase,.sapMSlt,.sapMComboBox,.sapMCb,.sapMRb,.sapMSwt');
    if (wrap && wrap !== el) {
      if ((s = txt(wrap.getAttribute('aria-label')))) return cut(s);
      const wl = wrap.getAttribute('aria-labelledby');
      if (wl && (s = byIds(wl))) return cut(s);
    }
    if ((s = txt(el.getAttribute('title')))) return cut(s);
    if ((s = txt(el.getAttribute('placeholder')))) return cut(s);
    const tag = el.tagName;
    if (tag === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) return cut(el.value);
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && (s = txt(el.innerText || el.textContent))) return cut(s);
    const inner = el.querySelector('[aria-label],[title],img[alt]');
    if (inner && (s = txt(inner.getAttribute('aria-label') || inner.getAttribute('title') || inner.getAttribute('alt')))) return cut(s);
    return el.name || el.id || '';
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i++) {
      let p = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(`${p}#${CSS.escape(n.id)}`); break; }
      const c = [...n.classList].filter((x) => !/^\d/.test(x)).slice(0, 2);
      if (c.length) p += '.' + c.map((x) => CSS.escape(x)).join('.');
      parts.unshift(p);
    }
    return parts.join(' > ');
  }

  function dialogTitleOf(el) {
    const d = el.closest('[role="dialog"],[role="alertdialog"],dialog[open]');
    return d ? dialogTitle(d) : null;
  }

  function dialogTitle(d) {
    let s = txt(d.getAttribute('aria-label'));
    const lb = d.getAttribute('aria-labelledby');
    if (!s && lb) s = byIds(lb);
    if (!s) s = txt(d.querySelector('.sapMDialogTitle,.sapMTitle,h1,h2,h3,[role="heading"]')?.textContent);
    return cut(s || d.innerText, 80);
  }

  // Element box in the top-level viewport's CSS pixels (same coordinate space as the screenshot).
  // Iframe offsets are added for same-origin frames; for cross-origin frames `exact` is false.
  function geometry(el) {
    const r = el.getBoundingClientRect();
    let ox = 0, oy = 0, exact = true;
    try {
      for (let w = window; w !== w.top; w = w.parent) {
        const fe = w.frameElement;
        if (!fe) { exact = false; break; }
        const fr = fe.getBoundingClientRect();
        ox += fr.left + fe.clientLeft;
        oy += fr.top + fe.clientTop;
      }
    } catch { exact = false; }
    const rd = (n) => Math.round(n * 10) / 10;
    return { ox, oy, rect: { x: rd(r.left + ox), y: rd(r.top + oy), w: rd(r.width), h: rd(r.height), exact } };
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.type || 'text') + ' field' : tag);
    const ui5 = el.closest('[data-sap-ui]');
    return {
      tag, role,
      label: labelFor(el),
      id: el.id || null,
      ui5Id: ui5 ? ui5.id || ui5.getAttribute('data-sap-ui') : null,
      name: el.getAttribute('name') || null,
      selector: cssPath(el),
      dialog: dialogTitleOf(el),
      rect: geometry(el).rect,
    };
  }

  // ---- privacy -----------------------------------------------------------------------------
  function sensitive(el, label) {
    const type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    if (/password|cc-/.test(el.getAttribute('autocomplete') || '')) return true;
    if (maskSel) { try { if (el.matches(maskSel) || el.closest(maskSel)) return true; } catch { /* bad selector */ } }
    if (maskRe) {
      const hay = [label, el.name, el.id, el.getAttribute('placeholder')].filter(Boolean).join(' ');
      if (maskRe.test(hay)) return true;
    }
    return false;
  }

  function buildMasking() {
    maskSel = String(cfg.maskSelectors || '').split('\n').map((s) => s.trim()).filter((s) => {
      if (!s) return false;
      try { document.querySelector(s); return true; } catch { return false; }
    }).join(', ');
    try { maskRe = cfg.maskPatterns ? new RegExp(cfg.maskPatterns, 'i') : null; } catch { maskRe = null; }
  }

  function setMask(on) {
    document.getElementById('__spr-mask')?.remove();
    document.querySelectorAll('[data-spr-mask]').forEach((e) => e.removeAttribute('data-spr-mask'));
    if (!on || !cfg?.redactScreenshots) return;
    document.querySelectorAll('input,textarea,select').forEach((el) => { if (sensitive(el, labelFor(el))) el.setAttribute('data-spr-mask', '1'); });
    if (maskSel) { try { document.querySelectorAll(maskSel).forEach((el) => el.setAttribute('data-spr-mask', '1')); } catch { /* ignore */ } }
    const st = document.createElement('style');
    st.id = '__spr-mask';
    st.textContent = '[data-spr-mask]{filter:blur(8px) !important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- stabilisation -----------------------------------------------------------------------
  const BUSY = ['.sapUiBlockLayer:not(.sapUiBlockLayerHidden)', '.sapMBusyIndicator', '.sapUiLocalBusyIndicator', '[aria-busy="true"]'];
  const busy = () => BUSY.some((s) => visible(document.querySelector(s)));

  function whenStable() {
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const now = Date.now();
        if (now - start >= cfg.maxWaitMs) return resolve('timeout');
        if (now - lastActivity >= cfg.quietMs && !busy()) return resolve('stable');
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  async function settle() {
    if (waiting) return;
    waiting = true;
    await whenStable();
    waiting = false;
    const seqs = [...pending];
    pending.clear();
    if (seqs.length) send({ type: 'stable', seqs });
  }

  // ---- event emission ----------------------------------------------------------------------
  async function emit(ev, { shot = true, token = null } = {}) {
    if (!active) return;
    ev.t = Date.now();
    ev.url = location.href;
    if (!isTop) ev.frame = true;
    lastActivity = ev.t;
    const r = await send({ type: 'ev', ev, beforeToken: token });
    if (r?.seq && shot && cfg.shotMode !== 'manual') { pending.add(r.seq); settle(); }
  }

  const realTarget = (e) => {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    return t instanceof Element ? t : t?.parentElement || null;
  };
  const isTextField = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NON_TEXT_INPUT.test(el.type || 'text'));
  const clickable = (el) => {
    if (el.tagName === 'SELECT' || isTextField(el)) return false; // focusing a field is not an action
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) return false; // reported via "change"
    if (el.tagName === 'LABEL' && el.control) return false;
    return true;
  };

  function install() {
    if (installed) return;
    installed = true;

    document.addEventListener('pointerdown', (e) => {
      if (!active || !e.isTrusted || e.button !== 0 || cfg.shotMode !== 'beforeAfter') return;
      const t = realTarget(e)?.closest(INTERACTIVE);
      if (!t || !clickable(t)) return;
      beforeToken = { token: Math.random().toString(36).slice(2), el: t, at: Date.now() };
      send({ type: 'before', token: beforeToken.token });
    }, true);

    document.addEventListener('click', (e) => {
      if (!active || !e.isTrusted) return;
      const t = realTarget(e)?.closest(INTERACTIVE);
      if (!t || !clickable(t)) return;
      const bt = beforeToken && beforeToken.el === t && Date.now() - beforeToken.at < 3000 ? beforeToken.token : null;
      beforeToken = null;
      const g = geometry(t);
      const point = { x: Math.round(e.clientX + g.ox), y: Math.round(e.clientY + g.oy) };
      emit({ type: 'click', ...describe(t), point }, { token: bt });
    }, true);

    document.addEventListener('change', (e) => {
      if (!active || !e.isTrusted) return;
      const el = realTarget(e);
      if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      const d = describe(el);
      const masked = sensitive(el, d.label);
      const allow = cfg.captureValues && !masked;
      if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) {
        emit({ type: 'toggle', ...d, checked: el.checked });
      } else if (el.tagName === 'SELECT') {
        const opt = el.selectedOptions?.[0];
        emit({ type: 'select', ...d, masked, value: allow && opt ? cut(opt.textContent, 200) : null });
      } else {
        emit({ type: 'input', ...d, masked, value: allow ? cut(el.value, 200) : null });
      }
    }, true);

    new MutationObserver(() => { lastActivity = Date.now(); }).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'aria-busy', 'hidden', 'open'],
    });
    try {
      new PerformanceObserver(() => { lastActivity = Date.now(); }).observe({ type: 'resource' });
    } catch { /* unsupported */ }

    let seeded = false;
    setInterval(() => {
      if (!active) return;
      const cur = new Set();
      document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]').forEach((d) => {
        const popoverOnly = d.classList.contains('sapMPopover') && !d.classList.contains('sapMDialog');
        if (!popoverOnly && visible(d) && !d.closest('[aria-hidden="true"]')) cur.add(d);
      });
      for (const d of cur) {
        if (openDialogs.has(d)) continue;
        const title = dialogTitle(d);
        openDialogs.set(d, title);
        if (seeded) emit({ type: 'dialog_open', title, text: cut(d.innerText, 200) });
      }
      for (const [d, title] of openDialogs) {
        if (cur.has(d)) continue;
        openDialogs.delete(d);
        emit({ type: 'dialog_close', title }, { shot: false });
      }
      document.querySelectorAll('.sapMMessageToast,[role="alert"]').forEach((t) => {
        if (seenToasts.has(t) || !visible(t)) return;
        seenToasts.add(t);
        const text = cut(t.innerText, 200);
        if (seeded && text) emit({ type: 'toast', text }, { shot: false });
      });
      seeded = true;
    }, 500);
  }

  // ---- lifecycle ---------------------------------------------------------------------------
  R.hello = () => {
    helloP = (async () => {
      const r = await send({ type: 'hello', top: isTop });
      if (!r?.active) { active = false; setMask(false); return; }
      cfg = r.cfg;
      buildMasking();
      active = true;
      install();
    })();
    return helloP;
  };

  try {
    chrome.runtime.onMessage.addListener((m, _s, reply) => {
      if (m?.target !== 'content') return false;
      if (m.type === 'waitStable') {
        helloP.then(() => (active ? whenStable() : null)).then((r) => reply({ ok: !!r, result: r }));
        return true;
      }
      if (m.type === 'mask') { setMask(m.on); reply({ ok: true }); return false; }
      if (m.type === 'deactivate') { active = false; setMask(false); reply({ ok: true }); return false; }
      return false;
    });
  } catch { /* extension context invalidated */ }

  R.hello();
})();
