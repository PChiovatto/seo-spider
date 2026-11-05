// File menu (recent lists, close / rename / delete / import / export / exit) and File > Settings.
/* global $, $$, t, tf, esc, store, ACTIONS, DATA, clearCrawl, afterCrawlLoaded, download, setLang, LANG, openModal, CFGW */
(() => {
  // ---------- app settings (this browser) ----------
  const DEF = { theme: 'light', accent: '', proxy_on: false, proxy_host: '', proxy_port: '', proxy_user: '', storage: 'db',
    retention: 'all', retention_days: 90, retention_keep: 50, notify_crawl: true, notify_analysis: true, notify_sound: false };
  const SET = { ...DEF, ...store.get('seo-spider-settings', {}) };
  const save = () => store.set('seo-spider-settings', SET);
  let PROXY_PASS = '';

  function applyLook() {
    document.documentElement.dataset.theme = SET.theme === 'dark' ? 'dark' : 'light';
    const root = document.documentElement.style;
    if (SET.accent) { root.setProperty('--accent', SET.accent); root.setProperty('--sel', SET.accent); }
    else { root.removeProperty('--accent'); root.removeProperty('--sel'); }
  }
  applyLook();

  // crawl requests get the proxy and the storage mode from the settings
  const basePost = window.cfgPost;
  window.cfgPost = (cfg) => {
    basePost?.(cfg);
    if (SET.proxy_on && SET.proxy_host) {
      const auth = SET.proxy_user ? `${encodeURIComponent(SET.proxy_user)}:${encodeURIComponent(PROXY_PASS)}@` : '';
      cfg.proxy = `http://${auth}${SET.proxy_host}${SET.proxy_port ? ':' + SET.proxy_port : ''}`;
    } else cfg.proxy = '';
    cfg.autosave = SET.storage !== 'memory';
    return cfg;
  };

  // ---------- recent lists ----------
  const recent = (key) => store.get(key, []);
  const remember = (key, item, idKey = 'id') => store.set(key, [item, ...recent(key).filter((x) => x[idKey] !== item[idKey])].slice(0, 10));
  let lastImport = false;
  function renderRecent() {
    const none = `<a class="muted">${t('Nenhum item recente')}</a>`;
    const list = (key) => recent(key).map((c) => `<a data-act="openrecent" data-id="${esc(c.id)}">${esc(c.name)}</a>`).join('') || none;
    $('#recentOpen').innerHTML = list('seo-spider-recent-open');
    $('#recentImport').innerHTML = list('seo-spider-recent-import');
    $('#recentCrawl').innerHTML = store.get('seo-spider-hist', []).map((u) => `<a data-act="crawlrecent" data-url="${esc(u)}">${esc(u)}</a>`).join('') || none;
  }
  window.onCrawlLoaded = () => {
    const c = DATA.crawl;
    if (c && c.id) {
      remember('seo-spider-recent-open', { id: c.id, name: c.name });
      if (lastImport) remember('seo-spider-recent-import', { id: c.id, name: c.name });
    }
    lastImport = false;
    renderRecent();
  };
  renderRecent();

  // ---------- File menu actions ----------
  const curId = () => DATA.crawl?.id;
  async function openCrawl(id) {
    const r = await fetch(`/api/crawls/${id}/open`, { method: 'POST' });
    if (!r.ok) {
      alert(t((await r.json().catch(() => ({}))).detail || 'Erro'));
      store.set('seo-spider-recent-open', recent('seo-spider-recent-open').filter((x) => x.id !== id));
      store.set('seo-spider-recent-import', recent('seo-spider-recent-import').filter((x) => x.id !== id));
      renderRecent();
      return;
    }
    await afterCrawlLoaded();
  }
  Object.assign(ACTIONS, {
    openrecent: (el) => openCrawl(el.dataset.id),
    crawlrecent: (el) => { $('#url').value = el.dataset.url; $('#url').focus(); },
    closecrawl: () => { if (DATA.pages.length) clearCrawl(); },
    renamecrawl: async () => {
      if (!curId()) { alert(t('Nenhum crawl aberto.')); return; }
      const v = window.prompt(t('Novo nome do crawl:'), DATA.crawl.name || '');
      if (v === null || !v.trim()) return;
      const r = await fetch(`/api/crawls/${curId()}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: v.trim() }) });
      if (!r.ok) { alert(t('Salve o crawl antes de renomear (Arquivo > Salvar).')); return; }
      DATA.crawl.name = v.trim();
      remember('seo-spider-recent-open', { id: curId(), name: v.trim() });
      renderRecent();
    },
    deletecrawl: async () => {
      if (!curId()) { alert(t('Nenhum crawl aberto.')); return; }
      if (!confirm(tf('Excluir o crawl “{{0}}”? Esta ação não pode ser desfeita.', DATA.crawl.name))) return;
      await fetch(`/api/crawls/${curId()}`, { method: 'DELETE' });
      store.set('seo-spider-recent-open', recent('seo-spider-recent-open').filter((x) => x.id !== curId()));
      await clearCrawl();
      renderRecent();
    },
    importcrawl: () => $('#fileImport').click(),
    exportcrawl: () => { if (!DATA.pages.length) { alert(t('Nenhum crawl aberto.')); return; } download('/api/export-current'); },
    settings: (el) => openSettings(el?.dataset?.section),
    exitapp: async () => {
      if (!confirm(t('Sair do SEO Spider? O servidor local será encerrado e a janela do run.bat fechará.'))) return;
      await fetch('/api/shutdown', { method: 'POST' }).catch(() => {});
      document.body.innerHTML = `<div class="byebye"><h2>${t('SEO Spider encerrado')}</h2><p>${t('Para abrir de novo, execute o run.bat.')}</p></div>`;
    },
  });
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const r = await fetch('/api/crawls/import', { method: 'POST', body: f });
    if (!r.ok) { alert(t((await r.json().catch(() => ({}))).detail || 'Erro')); return; }
    lastImport = true;
    await afterCrawlLoaded();
  });
  $('#crImport').addEventListener('change', () => { lastImport = true; }, true);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const act = { n: 'new', o: 'crawls', w: 'closecrawl', ',': 'settings' }[k];
    if (!act || (k !== ',' && e.target.closest('input, textarea, select'))) return;
    e.preventDefault();
    ACTIONS[act]();
  });

  // ---------- File > Settings window ----------
  const PAGES = { licence: 'Licença', ui: 'Interface', language: 'Idioma', proxy: 'Proxy', storage: 'Modo de armazenamento', retention: 'Retenção de crawls',
    memory: 'Alocação de memória', browser: 'Navegador embutido', certs: 'Certificados confiáveis', notify: 'Notificações', mcp: 'Servidor MCP' };
  const ACCENTS = ['#6cb33f', '#2e7d32', '#1976d2', '#00897b', '#7b1fa2', '#c2185b', '#e65100', '#455a64'];
  const fmtBytes = (n) => (n == null ? '—' : n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB');
  const kv = (rows) => rows.map(([k, v]) => `<span>${esc(t(k))}</span><b>${v}</b>`).join('');
  let SYS = null;
  async function loadSys() { SYS = await fetch('/api/system').then((r) => r.json()).catch(() => null); return SYS; }

  function openSettings(sec) {
    openModal('#setModal');
    fillForm();
    showSet(sec || store.get('seo-spider-setsec', 'licence'));
  }
  function showSet(sec) {
    if (!PAGES[sec]) sec = 'licence';
    $$('#setModal .cfgsec').forEach((s) => s.classList.toggle('on', s.id === 'set-' + sec));
    $$('#setNav .tn').forEach((n) => n.classList.toggle('on', n.dataset.setPage === sec));
    $('#setCrumb').textContent = `${t('Configurações')}  ›  ${t(PAGES[sec])}`;
    store.set('seo-spider-setsec', sec);
    ({ licence: renderAbout, storage: renderStorage, memory: renderMemory, browser: renderBrowser, certs: loadCerts, mcp: () => window.renderMcpSettings?.() })[sec]?.();
  }
  $('#setNav').addEventListener('click', (e) => { const n = e.target.closest('[data-set-page]'); if (n) showSet(n.dataset.setPage); });
  $('#setSearch').addEventListener('input', () => {
    const q = $('#setSearch').value.trim().toLowerCase();
    $$('#setNav .tn').forEach((n) => { n.hidden = !!q && !t(PAGES[n.dataset.setPage]).toLowerCase().includes(q) && !($('#set-' + n.dataset.setPage).textContent.toLowerCase().includes(q)); });
  });
  $('#setModal [data-max]').addEventListener('click', () => $('#setModal .cfgwin').classList.toggle('max'));

  function fillForm() {
    $$('#setModal [data-set]').forEach((el) => { if (el.type === 'checkbox') el.checked = !!SET[el.dataset.set]; else el.value = SET[el.dataset.set] ?? ''; });
    $$('#setModal input[name=set_theme]').forEach((r) => { r.checked = r.value === SET.theme; });
    $$('#setModal input[name=set_storage]').forEach((r) => { r.checked = r.value === SET.storage; });
    $$('#setModal input[name=set_retention]').forEach((r) => { r.checked = r.value === SET.retention; });
    $('#setLang').value = LANG;
    $('#setAccent').value = SET.accent || '#6cb33f';
    $('#setProxyPass').value = PROXY_PASS;
    $('#setAccents').innerHTML = ACCENTS.map((c) => `<button type="button" class="swatch ${c === (SET.accent || '#6cb33f') ? 'on' : ''}" data-accent="${c}" style="background:${c}" title="${c}"></button>`).join('');
  }
  $('#setModal').addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.set) { SET[el.dataset.set] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; save(); }
    if (el.name === 'set_theme') { SET.theme = el.value; save(); applyLook(); }
    if (el.name === 'set_storage') { SET.storage = el.value; save(); }
    if (el.name === 'set_retention') { SET.retention = el.value; save(); }
    if (el.id === 'setAccent') { SET.accent = el.value; save(); applyLook(); fillForm(); }
    if (el.id === 'setProxyPass') PROXY_PASS = el.value;
  });
  $('#setModal').addEventListener('change', (e) => { if (e.target.id === 'setLang') setLang(e.target.value); });
  $('#setAccents').addEventListener('click', (e) => { const b = e.target.closest('[data-accent]'); if (b) { SET.accent = b.dataset.accent === '#6cb33f' ? '' : b.dataset.accent; save(); applyLook(); fillForm(); } });
  $('#setAccentReset').addEventListener('click', () => { SET.accent = ''; save(); applyLook(); fillForm(); });

  async function renderAbout() {
    const s = SYS || await loadSys();
    $('#setAbout').innerHTML = kv([['Versão do Python', esc(s?.python || '')], ['Pasta do app', esc(s?.app_dir || '')], ['Licença', t('Gratuita (uso local)')]]);
  }
  async function renderStorage() {
    const s = await loadSys();
    $('#setStorageInfo').innerHTML = s ? kv([['Pasta dos crawls', esc(s.storage_dir)], ['Crawls salvos', s.saved_crawls], ['Espaço usado', fmtBytes(s.storage_size)]]) : '';
  }
  async function renderMemory() {
    const s = await loadSys();
    if (!s) return;
    const m = s.memory || {};
    const perUrl = s.crawl_urls ? (m.process || 0) / s.crawl_urls : 60000;
    $('#setMemory').innerHTML = kv([['Memória usada pelo SEO Spider', fmtBytes(m.process)], ['Memória total do computador', fmtBytes(m.total)],
      ['Memória livre', fmtBytes(m.free)], ['URLs no crawl aberto', s.crawl_urls],
      ['Capacidade estimada com a memória livre', m.free ? tf('~{{0}} URLs', Math.floor(m.free * 0.6 / Math.max(perUrl, 20000)).toLocaleString()) : '—']]);
  }
  $('#setMemRefresh').addEventListener('click', renderMemory);
  async function renderBrowser() {
    const s = await loadSys();
    if (!s) return;
    const bi = s.browser_install || {};
    $('#setBrowser').innerHTML = kv([['Chromium', s.chromium ? `<span class="s2">${t('Instalado')}</span>` : `<span class="s4">${t('Não instalado')}</span>`],
      ['Local', esc(s.chromium_path || '—')], ['Status da instalação', bi.running ? t('Instalando…') : bi.ok === true ? t('Concluída') : bi.ok === false ? t('Falhou') : '—']]);
    $('#setBrowserLog').hidden = !bi.log;
    $('#setBrowserLog').textContent = bi.log || '';
    if (bi.running) setTimeout(() => { if (!$('#setModal').hidden) renderBrowser(); }, 3000);
  }
  $('#setBrowserInstall').addEventListener('click', async () => {
    const r = await fetch('/api/system/chromium', { method: 'POST' });
    if (!r.ok) alert(t((await r.json().catch(() => ({}))).detail || 'Erro'));
    renderBrowser();
  });
  async function loadCerts() { $('#setCerts').value = (await fetch('/api/certs').then((r) => r.json()).catch(() => ({}))).pem || ''; }
  $('#setCertFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) $('#setCerts').value = ($('#setCerts').value.trim() + '\n' + (await f.text())).trim();
  });
  $('#setCertSave').addEventListener('click', async () => {
    const r = await fetch('/api/certs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pem: $('#setCerts').value }) });
    const j = await r.json().catch(() => ({}));
    $('#setCertMsg').textContent = r.ok ? tf('{{0}} certificado(s) salvo(s). Valem a partir do próximo crawl.', j.count) : t(j.detail || 'Erro');
  });

  // crawl retention
  async function retention(dry) {
    if (SET.retention === 'all') return { crawls: [] };
    const body = { days: SET.retention === 'days' ? SET.retention_days : 0, keep: SET.retention === 'keep' ? SET.retention_keep : 0, dry_run: dry };
    return fetch('/api/crawls/retention', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  }
  $('#setRetApply').addEventListener('click', async () => {
    if (SET.retention === 'all') { $('#setRetMsg').textContent = t('Todos os crawls são mantidos.'); return; }
    const preview = await retention(true);
    if (!preview.crawls.length) { $('#setRetMsg').textContent = t('Nenhum crawl a excluir.'); return; }
    if (!confirm(tf('Excluir {{0}} crawl(s)?', preview.crawls.length) + '\n\n' + preview.crawls.map((c) => '• ' + c.name).join('\n'))) return;
    await retention(false);
    $('#setRetMsg').textContent = tf('{{0}} crawl(s) excluído(s).', preview.crawls.length);
  });
  if (SET.retention !== 'all') retention(false).catch(() => {});

  // notifications
  function beep() {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.6);
    } catch {}
  }
  async function notify(title, body) {
    if (SET.notify_sound) beep();
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return false;
    new Notification(title, { body });
    return true;
  }
  $('#setNotifyTest').addEventListener('click', async () => {
    const ok = await notify('SEO Spider', t('Notificação de teste.'));
    $('#setNotifyMsg').textContent = ok ? t('Notificação enviada.') : t('O navegador bloqueou as notificações. Permita-as nas configurações do site.');
  });
  window.onStatus = (st, prev) => {
    if (!prev) return;
    if (SET.notify_crawl && prev.status === 'running' && st.status !== 'running') {
      notify('SEO Spider', tf('Crawl concluído: {{0}} URLs ({{1}}).', st.crawled, st.start_url || ''));
    }
    if (SET.notify_analysis && prev.analysis?.running && !st.analysis?.running && st.status !== 'running') notify('SEO Spider', t('Análise de crawl concluída.'));
  };
  window.SETTINGS = { open: openSettings };
})();
