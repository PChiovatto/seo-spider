// Crawl Config window (Configuration > Crawl Config): left tree, pages, table editors and testers.
/* global $, $$, t, tf, esc, store, APIS, apiOn, openApiModal, openModal, ACTIONS, readConfig, currentRawConfig, applyRawConfig,
   saveConfig, SNIPPETS, saveSnippets, renderJsLib, DATA, loadData, renderTable, renderRight, syncMode, applySegments, loadApis */
(() => {
  const ICON = {
    gear: '<path d="M8 5.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4zM6.8.5h2.4l.4 2 1.5.7 1.8-1.2 1.7 1.7-1.2 1.8.7 1.5 2 .4v2.4l-2 .4-.7 1.5 1.2 1.8-1.7 1.7-1.8-1.2-1.5.7-.4 2H6.8l-.4-2-1.5-.7-1.8 1.2-1.7-1.7 1.2-1.8-.7-1.5-2-.4V6.8l2-.4.7-1.5-1.2-1.8 1.7-1.7 1.8 1.2 1.5-.7z" fill-rule="evenodd"/>',
    cols: '<path d="M1 2h14v12H1zm1.6 1.6v8.8h4.6V3.6zm6.2 0v8.8h4.6V3.6z" fill-rule="evenodd"/>',
    robot: '<path d="M7.2 1h1.6v2H12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.2zM5.5 6.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm5 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zM5 10.5v1h6v-1zM0 6h1.3v4H0zm14.7 0H16v4h-1.3z"/>',
    edit: '<path d="M1 3h7v1.5H2.5v9h9V9H13v6H1zm11.6-2.4 2.8 2.8-6.8 6.8H5.8V7.4z"/>',
    tree: '<path d="M1 1h5v4H1zm9 0h5v4h-5zM5 11h5v4H5zM3 5h1.5v2.5h7V5H13v4H8.3v2H6.8V9H3z"/>',
    check: '<path d="M8 .5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zm3.4 4.4L7 9.3 4.7 7 3.6 8.1 7 11.5l5.5-5.5z"/>',
    times: '<path d="M8 .5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zM5.6 4.5 4.5 5.6 6.9 8l-2.4 2.4 1.1 1.1L8 9.1l2.4 2.4 1.1-1.1L9.1 8l2.4-2.4-1.1-1.1L8 6.9z"/>',
    gauge: '<path d="M8 2a7.5 7.5 0 0 1 6.5 11.3H1.5A7.5 7.5 0 0 1 8 2zm3.8 3.1L8.6 9.2a1.4 1.4 0 1 1-1-1z"/>',
    user: '<path d="M5 1h6l1 4H4zM3 5.5h10v1H3zm2.2 1.7h5.6a3 3 0 0 1-5.6 0zM2 15c.4-3 2.4-4.6 6-4.6s5.6 1.6 6 4.6z"/>',
    H: '<path d="M2 2h4v1.4H5v3.8h6V3.4h-1V2h4v1.4h-1v9.2h1V14h-4v-1.4h1V8.6H5v4h1V14H2v-1.4h1V3.4H2z"/>',
    tools: '<path d="m2 1 3.5 3.5-1 1L1 2zm9.6 0a3.4 3.4 0 0 1 3.1 4.6L10.2 10l1.8 1.8L10 14 1.3 5.3l2.1-2.1 5.2 5.2 1.2-1.2A3.4 3.4 0 0 1 11.6 1zM1 13.4 5.8 8.6l1.6 1.6L2.6 15z"/>',
    globe: '<path d="M8 .5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zM6.2 2.3A6 6 0 0 0 2.1 7.2h2.8c.1-1.8.5-3.5 1.3-4.9zm3.6 0c.8 1.4 1.2 3.1 1.3 4.9h2.8a6 6 0 0 0-4.1-4.9zM8 2.2c-.9 1.3-1.5 3-1.6 5h3.2c-.1-2-.7-3.7-1.6-5zM2.1 8.8a6 6 0 0 0 4.1 4.9c-.8-1.4-1.2-3.1-1.3-4.9zm4.3 0c.1 2 .7 3.7 1.6 5 .9-1.3 1.5-3 1.6-5zm4.7 0c-.1 1.8-.5 3.5-1.3 4.9a6 6 0 0 0 4.1-4.9z"/>',
    lock: '<path d="M4.5 1.5a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM0 14c0-3 2-4.8 4.5-4.8 1 0 2 .3 2.8.8V14zm10.5-6.5a2.3 2.3 0 0 1 2.3 2.3V11H14v4H7.8v-4H9V9.8a2.3 2.3 0 0 1 1.5-2.3zm0 1.2a1.1 1.1 0 0 0-1.1 1.1V11h2.2V9.8a1.1 1.1 0 0 0-1.1-1.1z"/>',
    pie: '<path d="M7 1.5v7.5h7.5A7.5 7.5 0 1 1 7 1.5zm1.5-1A7 7 0 0 1 15.5 7.5h-7z"/>',
    search: '<path d="M6.5 1a5.5 5.5 0 0 1 4.4 8.8l4 4-1.2 1.2-4-4A5.5 5.5 0 1 1 6.5 1zm0 1.7a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 16 16" class="cfgico">${ICON[k] || ''}</svg>`;
  const TREE = [
    { id: 'spider', label: 'Spider', icon: 'gear', desc: 'Configure como o SEO Spider rastreia o site: o que rastrear e armazenar, os dados extraídos, limites, renderização, opções avançadas e preferências.',
      children: [['spider-crawl', 'Rastreamento'], ['spider-extraction', 'Extração'], ['spider-limits', 'Limites'], ['spider-rendering', 'Renderização'], ['spider-advanced', 'Avançado'], ['spider-preferences', 'Preferências']] },
    { id: 'content', label: 'Conteúdo', icon: 'cols', desc: 'Configure como o SEO Spider analisa o conteúdo de cada página rastreada, incluindo a verificação de páginas duplicadas e de erros de idioma e ortografia.',
      children: [['content-area', 'Área de conteúdo'], ['content-duplicates', 'Duplicados'], ['content-spelling', 'Ortografia e gramática'], ['content-embeddings', 'Embeddings']] },
    { id: 'robots', label: 'robots.txt', icon: 'robot' },
    { id: 'url-rewriting', label: 'Reescrita de URL', icon: 'edit' },
    { id: 'cdns', label: 'CDNs', icon: 'tree' },
    { id: 'include', label: 'Incluir URLs', icon: 'check' },
    { id: 'exclude', label: 'Excluir URLs', icon: 'times' },
    { id: 'speed', label: 'Velocidade', icon: 'gauge' },
    { id: 'user-agent', label: 'User-Agent', icon: 'user' },
    { id: 'http-header', label: 'Cabeçalho HTTP', icon: 'H' },
    { id: 'custom', label: 'Personalizado', icon: 'tools', desc: 'Configure o SEO Spider para encontrar qualquer coisa no HTML ou no texto das páginas, extrair dados ou personalizar a classificação da posição dos links no crawl.',
      children: [['custom-search', 'Pesquisa personalizada'], ['custom-extraction', 'Extração personalizada'], ['custom-linkpos', 'Posições de links personalizadas'], ['custom-js', 'JavaScript personalizado']] },
    { id: 'api', label: 'Acesso à API', icon: 'globe', page: 'api', children: () => APIS.map((p) => ['api:' + p.id, p.name]) },
    { id: 'auth', label: 'Autenticação', icon: 'lock', desc: 'Faça login para acessar e rastrear um site de homologação (ou área logada) usando autenticação baseada em padrões (basic) ou em formulário.',
      children: [['auth-standards', 'Baseada em padrões'], ['auth-forms', 'Baseada em formulário'], ['auth-profiles', 'Perfis']] },
    { id: 'segments', label: 'Segmentos', icon: 'pie' },
    { id: 'crawl-analysis', label: 'Análise de crawl', icon: 'search' },
  ];
  const ALIASES = { limits: 'spider-limits', crawl: 'spider-crawl', filters: 'include', search: 'custom-search', extract: 'custom-extraction',
    content: 'content-spelling', network: 'http-header', auth: 'auth-standards', general: 'user-agent', analysis: 'crawl-analysis' };
  const kids = (n) => (typeof n.children === 'function' ? n.children() : n.children || []);
  const OPEN = new Set(store.get('seo-spider-cfgopen', ['spider']));
  let CUR = null;
  let SNAP = null;

  // ---------- tree ----------
  function renderNav() {
    $('#cfgNav').innerHTML = TREE.map((n) => {
      const ch = kids(n);
      const open = OPEN.has(n.id);
      return `<div class="tn" data-node="${n.id}"><span class="arr">${ch.length ? (open ? '▼' : '▶') : ''}</span>${svg(n.icon)}<span class="lb">${esc(t(n.label))}</span></div>` +
        (ch.length ? `<div class="tch" ${open ? '' : 'hidden'}>${ch.map(([id, l]) => `<div class="tn child" data-node="${id}"><span class="lb">${esc(t(l))}</span></div>`).join('')}</div>` : '');
    }).join('');
    paintNav();
  }
  function paintNav() {
    $$('#cfgNav .tn').forEach((el) => el.classList.toggle('on', el.dataset.node === CUR));
  }
  function findNode(id) {
    for (const n of TREE) {
      if (n.id === id) return { node: n, parent: null };
      const c = kids(n).find(([cid]) => cid === id);
      if (c) return { node: { id: c[0], label: c[1] }, parent: n };
    }
    return null;
  }
  $('#cfgNav').addEventListener('click', (e) => {
    const el = e.target.closest('.tn');
    if (!el) return;
    const id = el.dataset.node;
    const top = TREE.find((n) => n.id === id);
    if (top && kids(top).length && (e.target.closest('.arr') || CUR === id)) {
      OPEN.has(id) ? OPEN.delete(id) : OPEN.add(id);
      store.set('seo-spider-cfgopen', [...OPEN]);
      renderNav();
      if (e.target.closest('.arr')) return;
    }
    show(id);
  });
  $('#cfgSearch').addEventListener('input', () => {
    const q = $('#cfgSearch').value.trim().toLowerCase();
    const sectionText = (id) => ($('#cfg-' + id)?.textContent || '').toLowerCase();
    for (const n of TREE) {
      const head = $(`#cfgNav .tn[data-node="${n.id}"]`);
      const box = head.nextElementSibling?.classList.contains('tch') ? head.nextElementSibling : null;
      let any = false;
      for (const [id, l] of kids(n)) {
        const hit = !q || t(l).toLowerCase().includes(q) || sectionText(id).includes(q);
        const el = $(`#cfgNav .tn[data-node="${id}"]`);
        if (el) el.hidden = !hit;
        any ||= hit && !!q;
      }
      const self = !q || t(n.label).toLowerCase().includes(q) || sectionText(n.page || n.id).includes(q);
      head.hidden = !(self || any);
      if (box) box.hidden = q ? !any && !self : !OPEN.has(n.id);
    }
  });

  // ---------- pages ----------
  function show(sec) {
    sec = ALIASES[sec] || sec || store.get('seo-spider-cfgsec2', 'spider-crawl');
    if (sec.startsWith('@')) sec = sec.slice(1);
    const f = findNode(sec) || findNode('spider-crawl');
    sec = f.node.id;
    if (CUR && CUR.startsWith('api:') && !sec.startsWith('api:')) unmountApi();
    CUR = sec;
    if (f.parent && !OPEN.has(f.parent.id)) { OPEN.add(f.parent.id); renderNav(); }
    let pageId = sec;
    const top = TREE.find((n) => n.id === sec);
    if (sec.startsWith('api:')) { pageId = 'api-detail'; mountApi(sec.slice(4)); }
    else if (top && top.page) pageId = top.page;
    else if (top && kids(top).length) { pageId = 'overview'; renderOverview(top); }
    $$('#cfgModal .cfgsec').forEach((s) => s.classList.toggle('on', s.id === 'cfg-' + pageId));
    const crumb = [t('Configuração do crawl')].concat(f.parent ? [t(f.parent.label)] : []).concat([t(f.node.label)]);
    $('#cfgCrumb').textContent = crumb.join('  ›  ');
    paintNav();
    store.set('seo-spider-cfgsec2', sec);
    ON_SHOW[pageId]?.();
    $('.cfgpane').scrollTop = 0;
  }
  function renderOverview(n) {
    $('#ovBody').innerHTML = `<p class="cfgdesc">${esc(t(n.desc))}</p><hr class="cfghr"><fieldset class="box"><legend>${t('Páginas')}</legend>` +
      kids(n).map(([id, l]) => `<a class="ovlink" data-go="${id}">${esc(t(l))}</a>`).join('') + '</fieldset>';
  }
  $('#cfgModal').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { show(go.dataset.go); return; }
    const clr = e.target.closest('[data-clear]');
    if (clr) { const ta = $(`#cfgModal [name="${clr.dataset.clear}"]`); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    const tab = e.target.closest('.ctabs button');
    if (tab) {
      tab.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === tab));
      tab.closest('.cfgsec').querySelectorAll('.ctab').forEach((c) => c.classList.toggle('on', c.id === tab.dataset.tab));
    }
  });

  // ---------- generic table editor ----------
  const editors = {};
  function TE(id, o) {
    const el = $('#te-' + id);
    const target = el.nextElementSibling;
    const ed = { rows: [], sel: -1, o, el, target };
    ed.load = () => {
      if (o.json) { try { ed.rows = (JSON.parse(target.value || '[]') || []).map(o.fromObj); } catch { ed.rows = []; } }
      else ed.rows = target.value.split('\n').map((l) => l.trim()).filter(Boolean).map(o.parse);
      ed.render();
    };
    ed.save = () => {
      const rows = ed.rows.filter((r) => r.some((v) => String(v ?? '').trim()));
      target.value = o.json ? JSON.stringify(rows.map(o.toObj)) : rows.map(o.format).join('\n');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      o.onchange?.();
    };
    ed.render = () => {
      const cell = (c, v, ci) => {
        if (c.type === 'select') return `<select data-c="${ci}">${c.options.map(([val, lab]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(t(lab))}</option>`).join('')}</select>`;
        return `<input data-c="${ci}" type="${c.type || 'text'}" value="${esc(v ?? '')}" placeholder="${esc(t(c.ph || c.label))}" ${c.list ? `list="${c.list}"` : ''} style="${c.w ? `flex:0 0 ${c.w}` : ''}" translate="no">`;
      };
      el.innerHTML = `<div class="tehead">${o.cols.map((c) => `<span style="${c.w ? `flex:0 0 ${c.w}` : ''}">${esc(t(c.label))}</span>`).join('')}<span class="tedel"></span></div><div class="terows">` +
        (ed.rows.length ? ed.rows.map((r, i) => `<div class="ter ${i === ed.sel ? 'sel' : ''}" data-i="${i}">${o.cols.map((c, ci) => cell(c, r[ci], ci)).join('')}<button type="button" class="tedel" data-del="${i}" title="${t('Excluir')}">🗑</button></div>`).join('')
          : `<div class="teempty">${esc(t(el.dataset.empty || ''))}</div>`) + '</div>' +
        `<div class="tefoot"><button type="button" class="tbtn danger" data-a="clear">🗑 ${t('Excluir todos')}</button>${o.reset ? `<button type="button" class="tbtn" data-a="reset">↺ ${t('Restaurar padrão')}</button>` : ''}<span class="sp"></span>` +
        `<button type="button" class="tbtn" data-a="up">↑ ${t('Mover para cima')}</button><button type="button" class="tbtn" data-a="down">↓ ${t('Mover para baixo')}</button>` +
        (o.bulk ? `<button type="button" class="tbtn" data-a="bulk">＋ ${t('Adicionar em massa')}</button>` : '') + (o.visual ? `<button type="button" class="tbtn" data-a="visual">\u200e${t('Extra\u00e7\u00e3o Visual')}</button>` : '') + `<button type="button" class="tbtn" data-a="add">＋ ${t('Adicionar')}</button></div>`;
    };
    el.addEventListener('input', (e) => {
      const row = e.target.closest('.ter');
      if (!row) return;
      ed.rows[+row.dataset.i][+e.target.dataset.c] = e.target.value;
      ed.save();
    });
    el.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT' && e.target.closest('.ter')) { ed.rows[+e.target.closest('.ter').dataset.i][+e.target.dataset.c] = e.target.value; ed.save(); } });
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.ter');
      if (row && !e.target.closest('[data-del]')) { ed.sel = +row.dataset.i; el.querySelectorAll('.ter').forEach((r) => r.classList.toggle('sel', r === row)); }
      const del = e.target.closest('[data-del]');
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (del) { ed.rows.splice(+del.dataset.del, 1); ed.sel = -1; }
      else if (a === 'clear') { if (ed.rows.length && !confirm(t('Excluir todas as linhas?'))) return; ed.rows = []; ed.sel = -1; }
      else if (a === 'reset') { ed.rows = o.reset.map((r) => [...r]); }
      else if (a === 'add') { ed.rows.push(o.cols.map((c) => c.def ?? (c.options ? c.options[0][0] : ''))); ed.sel = ed.rows.length - 1; }
      else if (a === 'visual') { visual(); }
      else if (a === 'bulk') {
        const txt = window.prompt(t('Cole uma linha por item, no formato:') + ' ' + o.bulk);
        if (!txt) return;
        txt.split(/\n|\\n/).map((l) => l.trim()).filter(Boolean).forEach((l) => ed.rows.push(o.parse(l)));
      } else if ((a === 'up' || a === 'down') && ed.sel >= 0) {
        const j = ed.sel + (a === 'up' ? -1 : 1);
        if (j < 0 || j >= ed.rows.length) return;
        [ed.rows[ed.sel], ed.rows[j]] = [ed.rows[j], ed.rows[ed.sel]];
        ed.sel = j;
      } else return;
      ed.render();
      ed.save();
      if (a === 'add') el.querySelector('.ter.sel input')?.focus();
    });
    editors[id] = ed;
    return ed;
  }
  const splitFirst = (l, sep) => { const i = l.indexOf(sep); return i < 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + sep.length).trim()]; };
  const splitLast = (l, sep) => { const i = l.lastIndexOf(sep); return i < 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + sep.length).trim()]; };
  TE('path', { cols: [{ label: 'Regex da URL', ph: '/blog/' }, { label: 'Máx. URLs', type: 'number', w: '120px', def: '100' }],
    parse: (l) => splitLast(l, '|'), format: ([a, b]) => `${a} | ${b}`, bulk: 'regex | número' });
  TE('rewrite', { cols: [{ label: 'Regex', ph: 'http:' }, { label: 'Substituir por', ph: 'https:' }],
    parse: (l) => splitFirst(l, '->'), format: ([a, b]) => `${a} -> ${b}`, bulk: 'regex -> substituição', onchange: () => test('rewrite') });
  TE('embed', { cols: [{ label: 'Regra', type: 'select', w: '130px', options: [['Incluir', 'Incluir'], ['Excluir', 'Excluir URLs']] }, { label: 'Regex da URL', ph: '/blog/' }],
    parse: (l) => splitFirst(l, '|'), format: ([a, b]) => `${a} | ${b}` });
  const HDR = [['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'], ['Accept-Encoding', 'gzip'], ['Cache-Control', 'no-cache'], ['Pragma', 'no-cache']];
  TE('headers', { cols: [{ label: 'Cabeçalho', w: '260px', list: 'hdrNames' }, { label: 'Valor' }],
    parse: (l) => splitFirst(l, ':'), format: ([a, b]) => `${a}: ${b}`, reset: HDR });
  TE('search', { cols: [{ label: 'Nome', w: '160px' }, { label: 'Modo', type: 'select', w: '130px', options: [['contém', 'Contém'], ['não contém', 'Não contém']] },
    { label: 'Tipo', type: 'select', w: '100px', options: [['texto', 'Texto'], ['regex', 'Regex']] }, { label: 'Onde', type: 'select', w: '140px', options: [['html', 'HTML'], ['texto', 'Texto da página']] },
    { label: 'Expressão' }],
  parse: (l) => { const p = l.split('|'); return [p[0], p[1], p[2], p[3], p.slice(4).join('|')].map((x) => (x || '').trim()); },
  format: (r) => r.map((x) => x || '').join(' | '), bulk: 'nome | contém | texto | html | expressão' });
  TE('extract', { visual: true, cols: [{ label: 'Nome', w: '180px' }, { label: 'Tipo', type: 'select', w: '100px', options: [['css', 'CSS'], ['xpath', 'XPath'], ['regex', 'Regex']] },
    { label: 'Expressão' }, { label: 'Atributo (opcional)', w: '170px' }],
  parse: (l) => { const p = l.split('|'); const type = (p[1] || '').trim().toLowerCase(); const rest = p.slice(2); const attr = type !== 'regex' && rest.length > 1 ? rest.pop().trim() : ''; return [(p[0] || '').trim(), type || 'css', rest.join('|').trim(), attr]; },
  format: ([n, ty, ex, at]) => (at ? `${n} | ${ty} | ${ex} | ${at}` : `${n} | ${ty} | ${ex}`) });
  const LP_DEFAULT = [['Head', '/head/'], ['Navegação', 'nav'], ['Cabeçalho', 'header'], ['Lateral', 'aside'], ['Rodapé', 'footer'], ['Conteúdo', '/']];
  TE('linkpos', { cols: [{ label: 'Posição', w: '200px' }, { label: 'Termo do caminho' }], parse: (l) => splitFirst(l, '|'), format: ([a, b]) => `${a} | ${b}`,
    reset: LP_DEFAULT, onchange: () => lpTest() });
  TE('auth', { json: true, cols: [{ label: 'Host', ph: 'www.exemplo.com' }, { label: 'Usuário', w: '200px' }, { label: 'Senha', type: 'password', w: '200px' }],
    fromObj: (o) => [o.host || '', o.user || '', o.pass || ''], toObj: ([host, user, pass]) => ({ host, user, pass }) });
  document.body.insertAdjacentHTML('beforeend', `<datalist id="hdrNames">${['Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control', 'Cookie', 'DNT', 'Pragma', 'Referer', 'X-Forwarded-For'].map((h) => `<option value="${h}">`).join('')}</datalist>`);

  // ---------- Extração Visual (inspetor) ----------
  function visual() { window.EXTRACT?.open(); }
  window.cfgExtract = (items) => {
    const ed = editors.extract;
    if (!ed || !window.EXTRACT) return;
    for (const it of items) {
      if (ed.rows.some((r) => r[2] === it.expr && String(r[3] || '') === String(it.attr || '') && String(r[1] || '') === String(it.type || ''))) continue;
      ed.rows.push([it.name || '', it.type || 'css', it.expr || '', it.attr || '']);
    }
    ed.render();
    ed.save();
    open('custom-extraction');
  };

  // ---------- testers ----------
  let testTimer;
  function test(kind) {
    clearTimeout(testTimer);
    testTimer = setTimeout(async () => {
      const urlEl = { rewrite: '#rwBefore', include: '#includeTest', exclude: '#excludeTest', cdn: '#cdnTest' }[kind];
      const url = $(urlEl).value.trim();
      const body = { config: readConfig(), url, kind, start_url: kind === 'cdn' ? $('#cdnStart').value.trim() : '' };
      const r = await fetch('/api/config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => null);
      if (!r) return;
      if (kind === 'rewrite') $('#rwAfter').value = r.ok ? r.normalized : r.error;
      else if (kind === 'cdn') $('#cdnRes').textContent = !url ? '' : t(r.internal ? 'Interna' : 'Externa');
      else {
        $(`#${kind}Enc`).value = r.normalized || r.error || '';
        const label = kind === 'include' ? 'Include' : 'Exclude';
        $(`#${kind}Res`).innerHTML = `<div class="cfginfo"><b>ⓘ Info</b><div>${!r.configured ? t(`Nenhum ${label} configurado`)
          : r.matched.length ? tf('A URL corresponde a: {{0}}', esc(r.matched.join(', '))) : t(kind === 'include' ? 'A URL não corresponde a nenhum Include (não será rastreada).' : 'A URL não corresponde a nenhum Exclude (será rastreada).')}</div></div>`;
      }
    }, 250);
  }
  $('#rwBefore').addEventListener('input', () => test('rewrite'));
  ['include', 'exclude'].forEach((k) => {
    $(`#${k}Test`).addEventListener('input', () => test(k));
    $(`#cfgModal [name="${k}"]`).addEventListener('input', () => test(k));
  });
  ['#cdnStart', '#cdnTest'].forEach((s) => $(s).addEventListener('input', () => test('cdn')));
  $('#cfgModal [name="cdn_domains"]').addEventListener('input', () => test('cdn'));
  ['strip_params', 'strip_all_params', 'lowercase_urls', 'url_pct_case'].forEach((n) => $(`#cfgModal [name="${n}"]`).addEventListener('input', () => test('rewrite')));
  $('#cfgModal [name="url_pct_case"]').addEventListener('change', () => test('rewrite'));
  function lpTest() {
    const path = ($('#lpPath').value || '').toLowerCase();
    const rows = editors.linkpos.rows.filter((r) => r[0] && r[1]);
    const hit = rows.find(([, term]) => path.includes(term.toLowerCase()));
    $('#lpRes').textContent = !$('#cfgModal [name=link_pos_enabled]').checked || !rows.length ? t('Classificação padrão')
      : hit ? `${hit[0]} (${hit[1]})` : t('Nenhuma posição encontrada (classificação padrão)');
  }
  $('#lpPath').addEventListener('input', lpTest);

  // ---------- page-specific behaviour ----------
  const fld = (n) => $(`#cfgModal [name="${n}"]`);
  function syncControls() {
    $$('#cfgModal input[data-store]').forEach((c) => { const s = fld(c.dataset.store); if (c.checked) s.checked = true; s.disabled = c.checked; });
    $$('#cfgModal input[data-limit]').forEach((c) => { fld(c.dataset.limit).disabled = !c.checked; });
    fld('max_rps').disabled = !fld('limit_rps').checked;
    fld('sitemap_list').disabled = !fld('sitemap_list_on').checked;
    fld('near_dup_threshold').disabled = !fld('near_dups').checked;
    $('#renderMode').value = fld('render_js').checked ? 'js' : 'text';
    $('#jsOpts').hidden = !fld('render_js').checked;
    const mode = fld('content_mode').value || 'exclude';
    $$('#cfgModal [data-radio="content_mode"]').forEach((r) => { r.checked = r.value === mode; });
    const word = mode === 'include' ? 'Incluir' : 'Excluir';
    $$('#cfgModal [data-ca]').forEach((p) => { p.textContent = t(`${word} ${{ tags: 'tags', classes: 'classes', ids: 'IDs' }[p.dataset.ca]}`); });
    $('#caHint').textContent = t(mode === 'include' ? 'Lista de elementos HTML a incluir, um por linha' : 'Lista de elementos HTML a excluir, um por linha');
    const auto = fld('spell_lang').value === 'auto';
    $$('#cfgModal [data-radio="spell_mode"]').forEach((r) => { r.checked = (r.value === 'auto') === auto; });
    fld('spell_lang').disabled = auto;
    $('#hdrUa').value = fld('user_agent').value;
    $('#faUa').textContent = 'User-Agent: ' + fld('user_agent').value;
  }
  $('#cfgModal').addEventListener('change', (e) => {
    if (e.target.id === 'renderMode') fld('render_js').checked = e.target.value === 'js';
    if (e.target.dataset.radio === 'content_mode') fld('content_mode').value = e.target.value;
    if (e.target.dataset.radio === 'spell_mode') fld('spell_lang').value = e.target.value === 'auto' ? 'auto' : (fld('spell_lang').value === 'auto' ? 'pt' : fld('spell_lang').value);
    syncControls();
  });
  $('#cfgModal').addEventListener('input', (e) => { if (e.target.name === 'user_agent') syncControls(); });

  // Custom JavaScript list (the snippet editor itself is the existing Custom JavaScript window)
  let JSSEL = -1;
  function renderJsList() {
    const el = $('#te-js');
    el.innerHTML = `<div class="tehead"><span>${t('Nome')}</span><span style="flex:0 0 140px">${t('Tipo')}</span><span style="flex:0 0 160px">${t('Tipo de conteúdo')}</span></div><div class="terows">` +
      (SNIPPETS.length ? SNIPPETS.map((s, i) => `<div class="ter ${i === JSSEL ? 'sel' : ''}" data-i="${i}"><span>${esc(s.name || 'Snippet ' + (i + 1))}</span><span style="flex:0 0 140px">${t(s.type === 'action' ? 'Ação' : 'Extração')}</span><span style="flex:0 0 160px">${esc(s.content_type || 'text/html')}</span></div>`).join('')
        : `<div class="teempty">${t('Nenhum snippet de JavaScript personalizado configurado')}</div>`) + '</div>' +
      `<div class="tefoot"><button type="button" class="tbtn danger" data-j="clear">🗑 ${t('Excluir todos')}</button><span class="sp"></span><button type="button" class="tbtn" data-j="up">↑ ${t('Mover para cima')}</button>` +
      `<button type="button" class="tbtn" data-j="down">↓ ${t('Mover para baixo')}</button><button type="button" class="tbtn" data-j="lib">＋ ${t('Adicionar da biblioteca')}</button><button type="button" class="tbtn" data-j="add">＋ ${t('Adicionar')}</button></div>`;
  }
  $('#te-js').addEventListener('click', (e) => {
    const row = e.target.closest('.ter');
    if (row) { JSSEL = +row.dataset.i; renderJsList(); return; }
    const a = e.target.closest('[data-j]')?.dataset.j;
    if (a === 'clear') { if (!SNIPPETS.length || !confirm(t('Excluir todas as linhas?'))) return; SNIPPETS.length = 0; saveSnippets(); }
    else if ((a === 'up' || a === 'down') && JSSEL >= 0) {
      const j = JSSEL + (a === 'up' ? -1 : 1);
      if (j < 0 || j >= SNIPPETS.length) return;
      [SNIPPETS[JSSEL], SNIPPETS[j]] = [SNIPPETS[j], SNIPPETS[JSSEL]];
      JSSEL = j;
      saveSnippets();
    } else if (a === 'add') { ACTIONS.customjs(); return; }
    else if (a === 'lib') { ACTIONS.customjs(); $('#jsLibBtn').click(); return; }
    renderJsList();
  });
  $('#te-js').addEventListener('dblclick', () => ACTIONS.customjs());

  // API Access list + embedded API page
  let MOUNTED = null;
  const badge = (p) => `<span class="apibadge">${esc(p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3))}</span>`;
  function renderApiList() {
    $('#apiList').innerHTML = APIS.map((p) => `<div class="apirow">${badge(p)}<div class="apiname"><b>${esc(p.name)}</b>
      <span class="${apiOn(p.id) ? 's2' : 'muted'}">${apiOn(p.id) ? '●' : '○'} ${t(apiOn(p.id) ? 'Conectado' : 'Desconectado')}</span></div>
      <button type="button" class="tbtn" data-go="api:${p.id}" title="${t('Configurar')}">⚙</button></div>`).join('');
  }
  function apiStatus() {
    const on = MOUNTED && apiOn(MOUNTED);
    $('#apiStatus').className = 'apistatus ' + (on ? 'on' : 'off');
    $('#apiStatus').textContent = t(on ? 'Conectado' : 'Não conectado');
  }
  function mountApi(id) {
    if (MOUNTED !== id) unmountApi();
    MOUNTED = id;
    openApiModal(id);
    $('#apiModal').hidden = true;
    const w = $('#apiModal .window');
    $('#apiMount').append(w.querySelector('.wbody'), w.querySelector('.wfoot'));
    $('#apiMount [data-close]')?.setAttribute('hidden', '');
    apiStatus();
  }
  function unmountApi() {
    if (!MOUNTED) return;
    const w = $('#apiModal .window');
    const body = $('#apiMount .wbody');
    const foot = $('#apiMount .wfoot');
    if (body) w.append(body);
    if (foot) { foot.querySelector('[data-close]')?.removeAttribute('hidden'); w.append(foot); }
    MOUNTED = null;
  }
  const _openModal = openModal;
  openModal = (id) => { if (id === '#apiModal' && MOUNTED && !$('#cfgModal').hidden) { $('#apiModal').hidden = true; apiStatus(); return; } _openModal(id); }; // eslint-disable-line no-global-assign
  $('#apiMount').addEventListener('click', () => setTimeout(async () => { await loadApis(); apiStatus(); }, 1500));

  // robots.txt per subdomain
  let RB = {};
  let RBSEL = null;
  const rbField = () => fld('robots_custom');
  function rbLoad() { try { RB = JSON.parse(rbField().value || '{}') || {}; } catch { RB = {}; } if (!(RBSEL in RB)) RBSEL = Object.keys(RB)[0] || null; rbRender(); }
  function rbSave() { rbField().value = JSON.stringify(RB); }
  function rbRender() {
    $('#rbHosts').innerHTML = Object.keys(RB).length ? Object.keys(RB).map((h) => `<div class="rbh ${h === RBSEL ? 'sel' : ''}" data-h="${esc(h)}">${esc(h)}</div>`).join('')
      : `<div class="teempty">${t('Nenhum subdomínio')}</div>`;
    $('#rbText').value = RBSEL ? RB[RBSEL] : '';
    $('#rbText').disabled = !RBSEL;
    rbLines();
  }
  function rbLines() {
    const n = $('#rbText').value.split('\n').length;
    $('#rbLines').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    const pos = $('#rbText').value.slice(0, $('#rbText').selectionStart).split('\n');
    $('#rbPos').textContent = `Ln ${pos.length}, Col ${pos[pos.length - 1].length + 1}`;
  }
  const hostOf = (u) => { try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).hostname; } catch { return ''; } };
  $('#rbHosts').addEventListener('click', (e) => { const h = e.target.closest('[data-h]'); if (h) { RBSEL = h.dataset.h; rbRender(); } });
  $('#rbText').addEventListener('input', () => { if (RBSEL) { RB[RBSEL] = $('#rbText').value; rbSave(); } rbLines(); });
  ['click', 'keyup'].forEach((ev) => $('#rbText').addEventListener(ev, rbLines));
  $('#rbText').addEventListener('scroll', () => { $('#rbLines').scrollTop = $('#rbText').scrollTop; });
  $('#rbAdd').addEventListener('click', () => {
    const h = hostOf(window.prompt(t('Subdomínio (ex.: www.exemplo.com):'), hostOf($('#url').value) || '') || '');
    if (!h) return;
    RB[h] ??= '';
    RBSEL = h;
    rbSave();
    rbRender();
  });
  $('#rbEdit').addEventListener('click', () => {
    if (!RBSEL) return;
    const h = hostOf(window.prompt(t('Subdomínio (ex.: www.exemplo.com):'), RBSEL) || '');
    if (!h || h === RBSEL) return;
    RB[h] = RB[RBSEL];
    delete RB[RBSEL];
    RBSEL = h;
    rbSave();
    rbRender();
  });
  $('#rbDel').addEventListener('click', () => { if (!RBSEL) return; delete RB[RBSEL]; RBSEL = Object.keys(RB)[0] || null; rbSave(); rbRender(); });
  $('#rbClear').addEventListener('click', () => { if (!RBSEL) return; RB[RBSEL] = ''; rbSave(); rbRender(); });
  $('#rbDownload').addEventListener('click', async () => {
    if (!RBSEL) { alert(t('Adicione um subdomínio primeiro.')); return; }
    const r = await fetch(`/api/robots?url=${encodeURIComponent('https://' + RBSEL + '/')}&user_agent=${encodeURIComponent(fld('user_agent').value)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(t(j.detail || 'Erro')); return; }
    RB[RBSEL] = j.text || '';
    rbSave();
    rbRender();
  });
  $('#rbTest').addEventListener('click', async () => {
    if (!RBSEL) return;
    const path = $('#rbPath').value.trim() || '/';
    const url = 'https://' + RBSEL + (path.startsWith('/') ? path : '/' + path);
    const r = await fetch('/api/robots/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ robots_text: RB[RBSEL], urls: [url], user_agent: fld('robots_ua').value || fld('user_agent').value }) }).then((x) => x.json());
    const res = r[0];
    $('#rbResult').innerHTML = res ? `<b class="${res.allowed ? 's2' : 's4'}">${t(res.allowed ? 'Permitida' : 'Bloqueada')}</b> ${res.line ? `— ${t('linha')} ${res.lineno}: <code>${esc(res.line)}</code>` : ''}` : '';
  });

  // Segments: list + editor (stored as "name | regex" lines)
  let SEGS = [];
  let SEGSEL = 0;
  function segLoad() {
    SEGS = fld('segments').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => splitFirst(l, '|'));
    if (SEGSEL >= SEGS.length) SEGSEL = SEGS.length - 1;
    segRender();
  }
  function segSave() { fld('segments').value = SEGS.filter((s) => s[0]).map(([n, r]) => `${n} | ${r}`).join('\n'); applySegments(); }
  function segRender() {
    $('#segItems').innerHTML = SEGS.map(([n], i) => `<div class="segit ${i === SEGSEL ? 'sel' : ''}" data-s="${i}">${esc(n || t('(sem nome)'))}</div>`).join('');
    const s = SEGS[SEGSEL];
    $('#segEdit').innerHTML = s ? `<label class="stack">${t('Nome')}<input id="segName" value="${esc(s[0])}"></label>
      <label class="stack">${t('A URL corresponde à regex')}<input id="segRe" value="${esc(s[1])}" placeholder="/blog/" translate="no"></label>
      <label class="stack">${t('URL de teste')}<input id="segTest" placeholder="https://www.exemplo.com/blog/post"></label><p id="segRes" class="muted"></p>`
      : `<div class="teempty">${t('Clique em Adicionar para criar um segmento.')}</div>`;
  }
  function segTest() {
    const s = SEGS[SEGSEL];
    const u = $('#segTest')?.value;
    if (!s || !u) { if ($('#segRes')) $('#segRes').textContent = ''; return; }
    let ok = false;
    try { ok = new RegExp(s[1], 'i').test(u); } catch { $('#segRes').textContent = t('Regex inválida'); return; }
    $('#segRes').innerHTML = `<b class="${ok ? 's2' : 's4'}">${t(ok ? 'A URL pertence a este segmento' : 'A URL não pertence a este segmento')}</b>`;
  }
  $('#segItems').addEventListener('click', (e) => { const it = e.target.closest('[data-s]'); if (it) { SEGSEL = +it.dataset.s; segRender(); } });
  $('#segEdit').addEventListener('input', (e) => {
    const s = SEGS[SEGSEL];
    if (!s) return;
    if (e.target.id === 'segName') { s[0] = e.target.value; $(`#segItems [data-s="${SEGSEL}"]`).textContent = s[0] || t('(sem nome)'); }
    if (e.target.id === 'segRe') s[1] = e.target.value;
    segSave();
    segTest();
  });
  $('#cfg-segments').addEventListener('click', (e) => {
    const a = e.target.closest('[data-seg]')?.dataset.seg;
    if (!a) return;
    if (a === 'add') { SEGS.push([tf('Segmento {{0}}', SEGS.length + 1), '']); SEGSEL = SEGS.length - 1; }
    else if (a === 'dup' && SEGS[SEGSEL]) { SEGS.splice(SEGSEL + 1, 0, [SEGS[SEGSEL][0] + ' (2)', SEGS[SEGSEL][1]]); SEGSEL += 1; }
    else if (a === 'del' && SEGS[SEGSEL]) { SEGS.splice(SEGSEL, 1); SEGSEL = Math.max(0, SEGSEL - 1); }
    else if (a === 'sortaz' || a === 'sortza') { SEGS.sort((x, y) => x[0].localeCompare(y[0]) * (a === 'sortaz' ? 1 : -1)); }
    else if ((a === 'up' || a === 'down') && SEGS[SEGSEL]) {
      const j = SEGSEL + (a === 'up' ? -1 : 1);
      if (j < 0 || j >= SEGS.length) return;
      [SEGS[SEGSEL], SEGS[j]] = [SEGS[j], SEGS[SEGSEL]];
      SEGSEL = j;
    }
    segSave();
    segRender();
  });

  // Authentication: forms based list + profiles
  async function faRender() {
    const s = await fetch('/api/formauth').then((r) => r.json()).catch(() => ({ cookies: 0, domains: [] }));
    $('#faList').innerHTML = s.cookies ? s.domains.map((d) => `<div class="ter sel"><span>${esc(d)}</span><span style="flex:0 0 200px">${tf('{{0}} cookies', s.cookies)}</span></div>`).join('')
      : `<div class="teempty">${t('Nenhum dado de autenticação')}</div>`;
  }
  $('#faDelete').addEventListener('click', async () => { await fetch('/api/formauth', { method: 'DELETE' }); faRender(); });
  async function authBundle() {
    const cookies = (await fetch('/api/formauth/export').then((r) => r.json()).catch(() => ({}))).cookies || [];
    let entries = [];
    try { entries = JSON.parse(fld('auth_entries').value || '[]'); } catch {}
    return { format: 'seo-spider-auth', entries, cookies };
  }
  async function authApply(data) {
    fld('auth_entries').value = JSON.stringify(data.entries || []);
    editors.auth.load();
    if (Array.isArray(data.cookies)) await fetch('/api/formauth/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookies: data.cookies }) });
  }
  $('#apExport').addEventListener('click', async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(await authBundle(), null, 2)], { type: 'application/json' }));
    a.download = 'seo-spider-autenticacao.json';
    a.click();
  });
  $('#apImport').addEventListener('click', () => $('#apFile').click());
  $('#apFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.format !== 'seo-spider-auth') throw new Error();
      await authApply(data);
      $('#apMsg').textContent = t('Autenticação importada.');
    } catch { alert(t('Arquivo de autenticação inválido.')); }
  });
  $('#apSetDef').addEventListener('click', async () => {
    await fetch('/api/auth/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await authBundle()) });
    $('#apMsg').textContent = t('Configuração de autenticação padrão salva.');
  });
  $('#apClearDef').addEventListener('click', async () => { await fetch('/api/auth/default', { method: 'DELETE' }); $('#apMsg').textContent = t('Configuração padrão removida.'); });

  // embeddings prompt options (AI providers with embedding prompts)
  function embedOptions() {
    const sel = $('#embPrompt');
    const cur = sel.value;
    const opts = APIS.filter((p) => p.ai && (p.values?.prompts ? (() => { try { return JSON.parse(p.values.prompts); } catch { return []; } })() : []).some((x) => x.type === 'embeddings'));
    sel.innerHTML = `<option value="">${t('Local (TF-IDF, offline)')}</option>` + opts.map((p) => `<option value="${p.id}">${esc(p.name)} (${t('prompts de embedding')})</option>`).join('');
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  }

  const ON_SHOW = {
    'custom-js': renderJsList, api: renderApiList, 'auth-forms': faRender, segments: segLoad, robots: rbLoad,
    'url-rewriting': () => test('rewrite'), include: () => test('include'), exclude: () => test('exclude'),
    cdns: () => { if (!$('#cdnStart').value) $('#cdnStart').value = $('#url').value; test('cdn'); },
    'custom-linkpos': lpTest, 'content-embeddings': embedOptions,
  };

  // ---------- open / OK / Cancel ----------
  function open(sec) {
    SNAP = currentRawConfig();
    _openModal('#cfgModal');
    renderNav();
    cfgSync();
    show(sec);
  }
  function cancel() {
    unmountApi();
    if (SNAP) applyRawConfig(SNAP);
    $('#cfgModal').hidden = true;
  }
  $('#cfgCancel').addEventListener('click', cancel);
  $('#cfgX').addEventListener('click', cancel);
  $('#cfgMax').addEventListener('click', () => $('#cfgModal .cfgwin').classList.toggle('max'));
  $('#cfgOk').addEventListener('click', async () => {
    unmountApi();
    const cfg = readConfig();
    await fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: cfg.prefs, weak_anchors: cfg.weak_anchors }) }).catch(() => {});
    if (DATA.pages.length) loadData();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ';') { e.preventDefault(); open(); }
    if (e.key === 'Escape' && !$('#cfgModal').hidden) cancel();
  }, true);

  // readConfig post-processing (checkbox-enabled limits, preferences, etc.)
  window.cfgPost = (cfg) => {
    cfg.prefs = {};
    for (const k of Object.keys(cfg)) {
      if (k.startsWith('pref_')) { cfg.prefs[k.slice(5)] = Number(cfg[k]); delete cfg[k]; }
    }
    const lim = { limit_total: ['max_urls', 100000], limit_depth: ['max_depth', 100], limit_per_depth: ['max_per_depth', 0],
      limit_folder: ['max_folder_depth', -1], limit_query: ['max_query_strings', -1], limit_per_subdomain: ['max_per_subdomain', 0] };
    for (const [flag, [name, off]] of Object.entries(lim)) { if (flag in cfg && !cfg[flag]) cfg[name] = off; delete cfg[flag]; }
    if ('limit_rps' in cfg) { if (!cfg.limit_rps) cfg.max_rps = 0; delete cfg.limit_rps; }
    if ('sitemap_list_on' in cfg) { if (!cfg.sitemap_list_on) cfg.sitemap_list = []; delete cfg.sitemap_list_on; }
    if ('robots_mode' in cfg) cfg.respect_robots = cfg.robots_mode === 'respect';
    if (!Array.isArray(cfg.auth_entries)) cfg.auth_entries = [];
    cfg.auth_entries = cfg.auth_entries.filter((e) => e && e.host && e.user);
    if (cfg.robots_custom && typeof cfg.robots_custom !== 'object') cfg.robots_custom = {};
    if (cfg.strip_params && Array.isArray(cfg.strip_params)) cfg.strip_params = cfg.strip_params.join(', ');
    return cfg;
  };
  // after loading a configuration into the form: refresh tables and dependent controls
  function cfgSync() {
    Object.values(editors).forEach((ed) => ed.load());
    syncControls();
  }
  window.cfgSync = cfgSync;
  window.CFGW = { open, show };

  // default authentication configuration (Authentication > Profiles) is loaded when the app opens
  fetch('/api/auth/default').then((r) => r.json()).then((d) => { if (d && d.format === 'seo-spider-auth') authApply(d); }).catch(() => {});
  renderNav();
})();
