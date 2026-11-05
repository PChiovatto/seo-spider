// View / Crawl Analysis / MCP / Help menu actions (reference menu bar), with their dialogs.
(() => {
  const win = (id, title, body, foot = '', cls = 'wide') => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.id = id;
    m.hidden = true;
    m.innerHTML = `<div class="window ${cls}"><div class="wtitle">${title} <button class="wclose" data-close>✕</button></div>
      <div class="wbody">${body}</div><div class="wfoot">${foot}<button class="tbtn primary" data-close>OK</button></div></div>`;
    m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) m.hidden = true; });
    document.body.appendChild(m);
    return m;
  };
  const fmtN = (n) => Number(n || 0).toLocaleString(LANG === 'en' ? 'en-GB' : LANG === 'es' ? 'es-ES' : 'pt-BR');
  const fmtDur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}min` : m ? `${m}min ${s % 60}s` : `${s}s`; };

  // ---------- View ----------
  ACTIONS['reset-columns'] = () => {
    S.hidden = {};
    store.set('seo-spider-cols', {});
    try { localStorage.removeItem('seo-spider-link-cols'); } catch {}
    location.reload();   // column widths and order are rebuilt from scratch
  };
  ACTIONS['reset-tabs'] = () => {
    Object.assign(S, { rtab: 'overview', detail: 'details' });
    setView('internal');
  };
  ACTIONS['focus-mode'] = (el) => {
    const L = store.get('seo-spider-layout', {});
    const on = !L.focus;
    if (on) updateLayout({ focus: { noright: !!L.noright, nobottom: !!L.nobottom }, noright: true, nobottom: true });
    else updateLayout({ noright: L.focus?.noright || false, nobottom: L.focus?.nobottom || false, focus: null });
    el?.classList.toggle('on', on);
  };

  // ---------- Crawl Analysis ----------
  ACTIONS['analyze-stop'] = async () => {
    await fetch('/api/analyze/stop', { method: 'POST' });
    poll();
  };

  // ---------- MCP (menu + File > Settings > MCP Server) ----------
  const ICO = {
    play: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 1.5l8 4.5-8 4.5z" fill="#fff"/></svg>',
    stop: '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="2" y="2" width="8" height="8" fill="#fff"/></svg>',
    reset: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.2 6.3a5 5 0 1 1 .6 4.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.2 2.6v3.9h3.9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    tools: '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M10.5 1.6a3.4 3.4 0 0 0-3.2 4.5L1.8 11.6a1.5 1.5 0 0 0 2.1 2.1l5.5-5.5a3.4 3.4 0 0 0 4.5-3.2l-2 2-2-.6-.6-2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    ok: '<svg viewBox="0 0 20 20" width="22" height="22"><circle cx="10" cy="10" r="9" fill="#6cb33f"/><path d="M5.5 10.3l3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2"/></svg>',
    bad: '<svg viewBox="0 0 20 20" width="22" height="22"><circle cx="10" cy="10" r="9" fill="#c62828"/><path d="M10 5v6M10 14v.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  };
  // Settings page (injected into the Settings window)
  $('#setNav').insertAdjacentHTML('beforeend', `<div class="tn" data-set-page="mcp"><span class="arr"></span><span class="lb">${t('Servidor MCP')}</span></div>`);
  $('#setModal .cfgpages').insertAdjacentHTML('beforeend', `<section class="cfgsec" id="set-mcp">
    <p class="cfgdesc">${t('Configure o servidor MCP definindo a porta e a pasta permitida para acesso a arquivos.')}</p>
    <p class="cfgdesc"><b>${t('Importante')}</b><br>${t('Ao configurar um servidor MCP, garanta que o app não seja acessado nem usado por outras pessoas além de você.')}</p>
    <p class="cfgdesc"><b>${t('Nota de privacidade')}</b><br>${t('Você é responsável pela privacidade de todos os dados enviados ou acessados pelo servidor MCP.')}</p>
    <hr class="cfghr">
    <div class="mcpbar"><button type="button" class="tbtn mcpgo" id="mcpToggle"></button><span id="mcpState" class="muted"></span></div>
    <div class="mcpbox"><label class="check"><input type="checkbox" id="mcpAuto"> ${t('Iniciar o servidor MCP automaticamente ao abrir o app')}</label></div>
    <div class="mcpnum"><span>${t('Porta')}</span><input type="number" id="mcpPort" min="1024" max="65535"><span class="sp"></span><button type="button" class="tbtn mcpreset" data-mcp-reset="port">${ICO.reset} ${t('Restaurar')}</button></div>
    <div class="mcpnum"><span>${t('Tamanho máx. da resposta (bytes)')}</span><input type="number" id="mcpMax" min="1000" max="100000000" step="1000"><span class="sp"></span><button type="button" class="tbtn mcpreset" data-mcp-reset="max_bytes">${ICO.reset} ${t('Restaurar')}</button></div>
    <div class="mcpbox"><p class="muted">${t('Define onde o servidor MCP guarda e acessa os arquivos de que as ferramentas precisam, como dados de entrada, arquivos temporários ou resultados.')}</p>
      <div class="mcpdir"><span>${t('Pasta')}</span><input id="mcpDir"><span id="mcpDirOk"></span><button type="button" class="tbtn mcpreset" data-mcp-reset="directory">${ICO.reset} ${t('Restaurar')}</button></div>
      <div id="mcpDirErr" class="s4"></div></div>
    <div class="mcpurl"><span>${t('Disponível em')}</span>: <code id="mcpUrl"></code></div>
    <div><button type="button" class="tbtn" id="mcpViewTools">${ICO.tools} ${t('Ver ferramentas')}</button></div>
  </section>`);
  const toolsWin = win('mcpToolsModal', t('Ferramentas do servidor MCP'), `<div id="mcpTools"></div><h4 class="sec">${t('Configuração do cliente (exemplo)')}</h4><pre class="src" id="mcpJson"></pre>`,
    `<a class="tbtn" href="/api/mcp/tools.md" download>${t('Baixar Markdown')}</a>`);
  let MCP = null;
  async function mcpRefresh(patch) {
    const r = await (await fetch('/api/mcp', patch ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) } : {})).json();
    if (!r || r.detail) { alert(typeof r?.detail === 'string' ? t(r.detail) : t('Valor inválido')); return MCP; }
    MCP = r;
    $('#mcpToggle').innerHTML = `${r.running ? ICO.stop : ICO.play} ${t(r.running ? 'Parar servidor MCP' : 'Iniciar servidor MCP')}`;
    $('#mcpToggle').classList.toggle('on', r.running);
    $('#mcpState').innerHTML = r.error ? `<span class="s4">${esc(t(r.error))}</span>` : r.running ? `<span class="s2">● ${t('Ativo')}</span> · ${tf('{{0}} chamadas', r.calls)}` : `● ${t('Parado')}`;
    $('#mcpAuto').checked = r.autostart;
    if (document.activeElement !== $('#mcpPort')) $('#mcpPort').value = r.port;
    if (document.activeElement !== $('#mcpMax')) $('#mcpMax').value = r.max_bytes;
    if (document.activeElement !== $('#mcpDir')) $('#mcpDir').value = r.directory;
    dirState(r.directory_error);
    $('#mcpUrl').textContent = r.url;
    $('#mcpJson').textContent = JSON.stringify({ mcpServers: { 'seo-spider': { type: 'http', url: r.url } } }, null, 2);
    $('#mcpTools').innerHTML = `<table class="kv"><thead><tr><th>${t('Ferramenta')}</th><th>${t('Descrição')}</th></tr></thead><tbody>${r.tools.map((x) => `<tr><td><code>${esc(x.name)}</code></td><td>${esc(x.description)}</td></tr>`).join('')}</tbody></table>`;
    $$('[data-act="mcp-start"]').forEach((a) => a.classList.toggle('disabled', r.running));
    $$('[data-act="mcp-stop"]').forEach((a) => a.classList.toggle('disabled', !r.running));
    document.body.classList.toggle('mcp-on', r.running);
    return r;
  }
  function dirState(err) {
    $('#mcpDirOk').innerHTML = err ? ICO.bad : ICO.ok;
    $('#mcpDirOk').title = err ? t(err) : t('Pasta válida');
    $('#mcpDirErr').textContent = err ? t(err) : '';
  }
  window.renderMcpSettings = () => mcpRefresh();
  $('#mcpToggle').addEventListener('click', () => mcpRefresh({ running: !MCP?.running }));
  $('#mcpAuto').addEventListener('change', (e) => mcpRefresh({ autostart: e.target.checked }));
  $('#mcpPort').addEventListener('change', (e) => mcpRefresh({ port: +e.target.value }));
  $('#mcpMax').addEventListener('change', (e) => mcpRefresh({ max_bytes: +e.target.value }));
  let dirTimer;
  $('#mcpDir').addEventListener('input', (e) => {
    clearTimeout(dirTimer);
    dirTimer = setTimeout(async () => {
      const r = await (await fetch('/api/mcp/check-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: e.target.value }) })).json();
      dirState(r.error);
    }, 400);
  });
  $('#mcpDir').addEventListener('change', (e) => mcpRefresh({ directory: e.target.value }));
  $('#set-mcp').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mcp-reset]');
    if (b && MCP) mcpRefresh({ [b.dataset.mcpReset]: MCP.defaults[b.dataset.mcpReset] });
  });
  $('#mcpViewTools').addEventListener('click', async () => { await mcpRefresh(); toolsWin.hidden = false; });
  ACTIONS['mcp-start'] = () => mcpRefresh({ running: true });
  ACTIONS['mcp-stop'] = () => mcpRefresh({ running: false });
  ACTIONS['mcp-config'] = () => ACTIONS.settings({ dataset: { section: 'mcp' } });
  mcpRefresh();

  // ---------- Help > Usage Stats ----------
  const PERIODS = { month: 'Este mês', year: 'Este ano', lastyear: 'Ano passado', all: 'Todo o período' };
  const usageWin = win('usageModal', t('Estatísticas de uso'), `<div class="ctabs" id="usagePeriods">${Object.entries(PERIODS).map(([k, l], i) => `<button type="button" data-period="${k}" class="${i ? '' : 'on'}">${t(l)}</button>`).join('')}</div><div id="usageBody"></div>`);
  async function usageLoad(period) {
    const u = await (await fetch('/api/usage?period=' + period)).json();
    const card = (l, v) => `<div class="ucard"><div class="uval">${v}</div><div class="ulbl">${esc(t(l))}</div></div>`;
    const list = (title, rows, map = (x) => x) => `<div class="ulist"><h4 class="sec">${esc(t(title))}</h4>${rows.length ? `<table class="kv"><tbody>${rows.map(([n, v]) => `<tr><td>${esc(map(n))}</td><td class="num">${fmtN(v)}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${t('Sem dados ainda.')}</p>`}</div>`;
    const avg = u.crawls ? Math.round(u.urls / u.crawls) : 0;
    const speed = u.seconds ? (u.urls / u.seconds).toFixed(1) : '0';
    $('#usageBody').innerHTML = `<h4 class="sec">${t('Suas estatísticas de crawl')}</h4><div class="ucards">
      ${card('Crawls iniciados', fmtN(u.crawls))}${card('URLs rastreadas', fmtN(u.urls))}${card('Tempo total de crawl', fmtDur(u.seconds))}
      ${card('Maior crawl', fmtN(u.largest) + ' URLs')}${card('Tamanho médio do site', fmtN(avg) + ' URLs')}${card('Velocidade média', speed + ' URL/s')}
      ${card('Erros', fmtN(u.errors))}${card('Avisos', fmtN(u.warnings))}${card('Oportunidades', fmtN(u.opportunities))}
      ${card('Maior imagem', u.largest_image ? (u.largest_image / 1e6).toFixed(2) + ' MB' : '—')}</div>
      <div class="ulists">${list('Problemas mais encontrados', u.issues, (n) => t(n))}${list('Exportações', u.exports, (n) => n.replace(/^bulk:/, t('Exportação em massa') + ': ').replace(/^report:/, t('Relatório') + ': '))}${list('Abas mais vistas', u.tabs, (n) => t(TABS[n]?.label || n))}</div>`;
  }
  $('#usagePeriods').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    $$('#usagePeriods button').forEach((x) => x.classList.toggle('on', x === b));
    usageLoad(b.dataset.period);
  });
  ACTIONS['usage'] = () => { $$('#usagePeriods button').forEach((x, i) => x.classList.toggle('on', !i)); usageLoad('month'); usageWin.hidden = false; };
  // tab views (debounced, best effort)
  let lastTab = '';
  setInterval(() => {
    if (S.tab && S.tab !== lastTab && DATA.pages?.length) { lastTab = S.tab; fetch(`/api/usage/tabs?name=${encodeURIComponent(S.tab)}`, { method: 'POST' }).catch(() => {}); }
  }, 4000);

  // ---------- Help > Debug ----------
  const debugWin = win('debugModal', t('Depuração'), `<div id="debugBody"></div>`, `<button type="button" class="tbtn" id="debugCopy">${t('Copiar informações')}</button>`);
  async function debugInfo() {
    const [sys, st] = await Promise.all([fetch('/api/system').then((r) => r.json()), fetch('/api/status').then((r) => r.json())]);
    const m = sys.memory || {};
    const gb = (b) => (b ? (b / 1e9).toFixed(2) + ' GB' : '—');
    return [
      ['Aplicativo', 'SEO Spider'], ['Pasta do app', sys.app_dir], ['Python', sys.python], ['Navegador', navigator.userAgent],
      ['Idioma', LANG], ['Fuso horário', Intl.DateTimeFormat().resolvedOptions().timeZone],
      ['Memória do processo', gb(m.process)], ['Memória total / livre', `${gb(m.total)} / ${gb(m.free)}`],
      ['Chromium (renderização)', sys.chromium ? sys.chromium_path : t('não instalado')], ['Pasta dos crawls', sys.storage_dir],
      ['Crawls salvos', `${sys.saved_crawls} (${gb(sys.storage_size)})`], ['Certificados confiáveis', sys.certs],
      ['Crawl atual', st.status === 'empty' ? '—' : `${st.start_url} · ${st.status} · ${st.crawled} URLs`],
      ['Servidor MCP', document.body.classList.contains('mcp-on') ? t('Ativo') : t('Parado')],
    ];
  }
  ACTIONS['debug'] = async () => {
    const rows = await debugInfo();
    $('#debugBody').innerHTML = `<table class="kv"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(t(k))}</td><td>${esc(v ?? '')}</td></tr>`).join('')}</tbody></table>`;
    debugWin.dataset.text = rows.map(([k, v]) => `${k}: ${v ?? ''}`).join('\n');
    debugWin.hidden = false;
  };
  $('#debugCopy').addEventListener('click', () => navigator.clipboard?.writeText(debugWin.dataset.text || ''));
})();

// ---------- Settings window: reference order + icons in the side list ----------
(() => {
  const ICONS = {
    licence: '<path d="M6 7.5a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM1 14c0-2.8 2.2-4.6 5-4.6 1 0 1.9.2 2.6.6V14zM10 9h5v5h-5zM11 9V7.6a1.5 1.5 0 0 1 3 0V9" fill="currentColor"/>',
    ui: '<path d="M1 2h14v9H1zM2.4 3.4v6.2h11.2V3.4zM5 13h6v1.5H5z" fill="currentColor" fill-rule="evenodd"/>',
    language: '<path d="M0 3h7v9H0zM9 3h7v9H9z" fill="currentColor"/><path d="M1.8 10.5L3.5 4.8 5.2 10.5M2.4 8.6h2.2M10.5 6h4M12.5 5v1M14 6c-.4 2-1.8 3.6-3.6 4.4M11.3 7.4c.5 1.2 1.6 2.4 3 3" fill="none" stroke="#fff" stroke-width="1"/>',
    proxy: '<path d="M5.5 7a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM0 14c0-3 2.4-5 5.5-5 1.2 0 2.3.3 3.2.8L8 14z" fill="currentColor"/><circle cx="12" cy="11.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 9.8v3.4M10.3 11.5h3.4" stroke="currentColor" stroke-width="1"/>',
    storage: '<path d="M2 6.5L4 3h8l2 3.5zM1 7.5h14V12H1z" fill="currentColor"/><circle cx="12.5" cy="9.8" r=".9" fill="#fff"/>',
    memory: '<path d="M0 4h16v6H0z" fill="currentColor"/><path d="M2 5.5h2v3H2zM5.3 5.5h2v3h-2zM8.7 5.5h2v3h-2zM12 5.5h2v3h-2z" fill="#fff"/><path d="M1.5 10v2.5M4 10v2.5M6.5 10v2.5M9 10v2.5M11.5 10v2.5M14 10v2.5" stroke="currentColor" stroke-width="1.2"/>',
    retention: '<path d="M7 2.5l6.5 6.5-4 4H5.5L1.5 9zM4.2 9.8l2.8 2.7" fill="currentColor"/><path d="M8 14h7" stroke="currentColor" stroke-width="1.4"/>',
    browser: '<path d="M4 1.5h11v9H4z" fill="currentColor"/><path d="M1 4.5h11v10H1z" fill="currentColor" stroke="#fff" stroke-width="1"/><path d="M2.5 7h8" stroke="#fff" stroke-width="1"/>',
    certs: '<path d="M8 .8l1.6 1.5 2.2-.4.6 2.1 2.1.7-.4 2.2L15.6 8l-1.5 1.6.4 2.2-2.1.6-.7 2.1-2.2-.4L8 15.6l-1.6-1.5-2.2.4-.6-2.1-2.1-.7.4-2.2L.4 8l1.5-1.6-.4-2.2 2.1-.6.7-2.1 2.2.4z" fill="currentColor"/>',
    notify: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4v5M8 11v1" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
    mcp: '<path d="M1 2h14v3.4H1zM1 6.4h14v3.4H1zM1 10.8h14v3.4H1z" fill="currentColor"/><path d="M3 3.7h1.5M3 8.1h1.5M3 12.5h1.5" stroke="#fff" stroke-width="1.2"/>',
  };
  const ORDER = ['licence', 'ui', 'language', 'proxy', 'storage', 'memory', 'retention', 'browser', 'certs', 'notify', 'mcp'];
  const nav = $('#setNav');
  for (const k of ORDER) {
    const n = nav.querySelector(`[data-set-page="${k}"]`);
    if (!n) continue;
    if (!n.querySelector('.setico') && ICONS[k]) n.querySelector('.lb').insertAdjacentHTML('beforebegin', `<svg class="setico" viewBox="0 0 16 16" width="18" height="18">${ICONS[k]}</svg>`);
    nav.appendChild(n);   // re-append in the reference order
  }
})();
