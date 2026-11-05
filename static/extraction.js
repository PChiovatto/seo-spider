/* Extração Visual — inspetor de elementos que gera seletores CSS/XPath/regex para a
   Extração personalizada (Configuração > Personalizado > Extração personalizada).

   O iframe é sandbox="allow-same-origin": os scripts da página NÃO rodam (logo não há
   como a página alcançar a interface), mas o painel ainda lê e mede o DOM.
   Nada é gravado direto na configuração: o usuário revisa e salva na janela de
   Extração personalizada. */
(() => {
  const DEFAULT_ATTR = 'href';

  const S = { open: false, url: '', attr: '', type: 'css', sel: null, list: [], doc: null };
  let els = {};

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (s, n = 80) => {
    const v = String(s ?? '').replace(/\s+/g, ' ').trim();
    return v.length > n ? v.slice(0, n - 1) + '…' : v;
  };
  const tt = (s) => (typeof window.t === 'function' ? window.t(s) : s);
  const shot = (url) => `/api/extraction/source?url=${encodeURIComponent(url)}`;

  // ---------- DOM helpers (run against the inspected document) ----------
  function idOf(el) {
    const id = el.getAttribute('id');
    return id && /^[A-Za-z][\w-]*$/.test(id) ? '#' + id : '';
  }

  // caminho CSS mais curto que já é único; id, depois atributos estáveis, depois estrutural
  function cssPath(el, doc) {
    const id = idOf(el);
    if (id) return id;
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 12; depth++) {
      let part = cur.tagName.toLowerCase();
      const curId = idOf(cur);
      if (curId && parts.length) {
        parts.unshift(curId);
        break;
      }
      for (const a of ['data-testid', 'data-test', 'itemprop', 'name', 'aria-label', 'role']) {
        const v = cur.getAttribute(a);
        if (v && v.length < 60) {
          part += `[${a}="${v.replace(/"/g, '\"')}"]`;
          break;
        }
      }
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try {
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        return part;
      }
      cur = parent;
    }
    return parts.join(' > ');
  }

  function xpathOf(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 20) {
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
      cur = cur.parentElement;
    }
    return '//' + parts.join('/');
  }

  const htmlOf = (el) => {
    const h = el.outerHTML || '';
    return h.length > 600 ? h.slice(0, 600) + '…' : h;
  };

  function lastPathSeg(url) {
    try {
      const p = new URL(url).pathname.replace(/\/+$/, '');
      const seg = p.split('/').filter(Boolean).pop() || '';
      return seg.replace(/\.[a-z0-9]{1,5}$/i, '');
    } catch {
      return '';
    }
  }

  const valueOf = (el) => {
    if (S.attr) return el.getAttribute(S.attr) ?? '';
    const parts = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) parts.push(n.textContent);
      else if (n.nodeType === 1 && !/^(SCRIPT|STYLE)$/.test(n.tagName)) parts.push(' ' + n.textContent + ' ');
    }
    return (parts.join(' ') || el.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const regexEscape = (v) => v.replace(/[.*+?^${}()|[%\\]/g, '\$&');

  function exprFor(el, css) {
    if (S.type === 'xpath') return xpathOf(el);
    if (S.type === 'regex') return regexEscape(valueOf(el).slice(0, 120));
    return css;
  }

  // ---------- UI ----------
  function build() {
    if (els.root) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal" id="exvModal" hidden>
        <div class="window huge exvwin">
          <div class="wtitle"><span>${tt('Extração Visual')}</span><button type="button" class="wclose" id="exvX" title="${tt('Fechar')}">×</button></div>
          <div class="toolbar exv-bar">
            <label class="stack exv-urlsel"><span>${tt('Página')}</span><select id="exvPage"></select></label>
            <button type="button" class="tbtn" id="exvLoad">${tt('Carregar')}</button>
            <label class="stack"><span>${tt('Atributo (vazio = texto)')}</span><input type="text" id="exvAttr" list="exvAttrNames" placeholder="${tt('ex.: href')}" value="${DEFAULT_ATTR}"></label>
            <div class="exv-type" role="group" aria-label="${tt('Tipo de seletor')}">
              <button type="button" class="tbtn on" data-exv-type="css">CSS</button>
              <button type="button" class="tbtn" data-exv-type="xpath">XPath</button>
              <button type="button" class="tbtn" data-exv-type="regex">Regex</button>
            </div>
            <span class="sp"></span>
            <span class="muted exv-count" id="exvCount"></span>
          </div>
          <div class="wbody exv-body">
            <div class="exv-stage" id="exvStage"><div class="empty">Escolha uma URL do crawl e clique em Carregar.</div></div>
            <aside class="exv-side">
              <div class="exv-pick">
                <h4>${tt('Seletor')}</h4>
                <label class="muted">Expressão</label><code id="exvExpr">—</code>
                <label class="muted">${tt('Resultado nesta página')}</label><div id="exvResult" class="exv-result">—</div>
                <label class="muted">${tt('Correspondências na página')}</label>
                <div id="exvMatches" class="exv-matches muted">${tt('Selecione um elemento.')}</div>
              </div>
              <div class="exv-list">
                <div class="exv-listhead"><h4>${tt('Extrações')}</h4><span class="muted" id="exvN">0</span></div>
                <div id="exvItems" class="exv-items"><div class="empty">${tt('Nada extraído ainda.')}</div></div>
              </div>
            </aside>
          </div>
          <div class="wfoot">
            <button type="button" class="tbtn" id="exvClear">Limpar lista</button>
            <span class="sp"></span>
            <button type="button" class="tbtn" id="exvLayout">${tt('Salvar como Extração')}</button>
            <button type="button" class="tbtn" id="exvApply" disabled>${tt('Aplicar na Extração personalizada')}</button>
            <button type="button" class="tbtn" id="exvClose">${tt('Fechar')}</button>
          </div>
          <datalist id="exvAttrNames">${['href', 'src', 'alt', 'title', 'content', 'value', 'data-src', 'datetime'].map((a) => `<option value="${a}">`).join('')}</datalist>
        </div>
      </div>`);
    els = {
      root: document.getElementById('exvModal'),
      page: document.getElementById('exvPage'),
      load: document.getElementById('exvLoad'),
      attr: document.getElementById('exvAttr'),
      stage: document.getElementById('exvStage'),
      count: document.getElementById('exvCount'),
      expr: document.getElementById('exvExpr'),
      result: document.getElementById('exvResult'),
      matches: document.getElementById('exvMatches'),
      items: document.getElementById('exvItems'),
      n: document.getElementById('exvN'),
      apply: document.getElementById('exvApply'),
      clear: document.getElementById('exvClear'),
      layout: document.getElementById('exvLayout'),
    };
    wire();
  }

  function pageOptions() {
    const pages = (window.DATA && window.DATA.pages) || [];
    return pages.filter((p) => p.status === 200 && p.content_type === 'text/html');
  }

  function fillPages(preferred) {
    const list = pageOptions();
    const prev = preferred || els.page.value;
    if (!list.length) {
      els.page.innerHTML = `<option value="">${tt('(nenhuma página HTML no crawl)')}</option>`;
      return;
    }
    els.page.innerHTML = list.map((p) => `<option value="${esc(p.url)}">${esc(p.url)}${p.title ? ' — ' + esc(clip(p.title, 60)) : ''}</option>`).join('');
    if (prev && list.some((p) => p.url === prev)) els.page.value = prev;
  }

  function open(url) {
    build();
    fillPages(url);
    els.root.hidden = false;
    S.open = true;
    load();
  }

  function close() {
    if (!els.root) return;
    els.root.hidden = true;
    S.open = false;
    if (els.stage) els.stage.innerHTML = '<div class="empty">Escolha uma URL do crawl e clique em Carregar.</div>';
    S.doc = null;
  }

  function setType(type) {
    if (type === 'regex') S.attr = '';   // regex trabalha sobre o HTML, nao sobre atributo
    if (els.attr) {
      const label = els.attr.closest('label');
      if (label) label.hidden = type === 'regex';
    }
    S.type = type;
    els.root.querySelectorAll('[data-exv-type]').forEach((b) => b.classList.toggle('on', b.dataset.exvType === type));
    if (S.sel) showPick(S.sel.el, S.sel.css);
  }

  function load() {
    const url = els.page.value;
    if (!url) {
      els.stage.innerHTML = `<div class="empty">${tt('Nenhuma página HTML disponível neste crawl.')}</div>`;
      return;
    }
    S.url = url;
    S.attr = els.attr.value.trim();
    S.sel = null;
    S.doc = null;
    els.stage.innerHTML = `<div class="empty">${tt('Carregando…')}</div>`;
    els.expr.textContent = '—';
    els.result.textContent = '—';
    els.matches.textContent = tt('Selecione um elemento.');
    const frame = document.createElement('iframe');
    frame.className = 'exv-frame';
    frame.setAttribute('sandbox', 'allow-same-origin');   // scripts desativados, DOM legível
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Página inspecionada');
    frame.src = shot(url);
    frame.addEventListener('load', () => onLoaded(frame, url));
    frame.addEventListener('error', () => { els.stage.innerHTML = `<div class="empty">${tt('Não foi possível carregar a página.')}</div>`; });
    els.stage.replaceChildren(frame);
  }

  function onLoaded(frame, url) {
    const doc = frame.contentDocument;
    if (!doc) {
      els.stage.innerHTML = `<div class="empty">${tt('Sem acesso ao documento da página.')}</div>`;
      return;
    }
    // nada pode executar nem navegar: a página é um documento estático
    doc.querySelectorAll('script, iframe, object, embed').forEach((n) => n.remove());
    doc.querySelectorAll('form').forEach((f) => f.removeAttribute('action'));
    doc.querySelectorAll('base').forEach((b) => b.remove());
    try {
      const style = doc.createElement('style');
      style.textContent = '.exv-hover{outline:2px solid #6cb33f !important;outline-offset:-2px;background:rgba(108,179,63,.12) !important}\n' +
        '.exv-on{outline:2px solid #f5b52e !important;outline-offset:-2px;background:rgba(245,181,46,.18) !important}\n' +
        '.exv-match{outline:1px dashed #2a7bd6 !important;outline-offset:-1px}';
      (doc.head || doc.documentElement).appendChild(style);
    } catch {}
    S.doc = doc;
    bind(doc);
    els.count.textContent = `${doc.querySelectorAll('*').length} ${tt('elementos na página')}`;
    if (!doc.body) els.stage.innerHTML = `<div class="empty">${tt('Página sem conteúdo.')}</div>`;
  }

  function target(e) {
    const el = e.target;
    return el && el.nodeType === 1 && el !== S.doc.documentElement ? el : null;
  }

  function bind(doc) {
    let hovered = null;
    doc.addEventListener('mouseover', (e) => {
      const el = target(e);
      if (hovered && hovered !== el) hovered.classList.remove('exv-hover');
      hovered = el;
      if (el) el.classList.add('exv-hover');
    }, true);
    doc.addEventListener('mouseleave', () => { hovered?.classList.remove('exv-hover'); hovered = null; }, true);
    doc.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = target(e);
      if (el) showPick(el, cssPath(el, doc));
    }, true);
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
  }

  function showPick(el, css) {
    const doc = S.doc;
    if (!doc) return;
    doc.querySelectorAll('.exv-on, .exv-match').forEach((n) => n.classList.remove('exv-on', 'exv-match'));
    S.sel = { el, css, expr: exprFor(el, css), value: valueOf(el), html: htmlOf(el) };
    els.expr.textContent = S.sel.expr || '—';
    els.result.textContent = clip(S.sel.value, 160) || '(vazio)';
    if (S.type === 'regex') {
      countRegex(S.sel.expr);
      els.matches.innerHTML = `${tt('Correspondências na página')}: …`;
      els.count.textContent = '';
      return;
    }
    el.classList.add('exv-on');
    let n = 0;
    try {
      doc.querySelectorAll(S.type === 'xpath' ? css : css).forEach((x) => { n++; if (x !== el) x.classList.add('exv-match'); });
    } catch {}
    if (S.type === 'xpath') {
      const res = doc.evaluate(S.sel.expr, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      n = res.snapshotLength;
      for (let i = 0; i < res.snapshotLength; i++) {
        const x = res.snapshotItem(i);
        if (x !== el) x.classList.add?.('exv-match');
      }
    }
    els.count.textContent = `${n} ${tt(n === 1 ? 'elemento' : 'elementos')} ${tt('nesta página')}`;
    els.matches.innerHTML = S.type === 'xpath' ? esc(clip(S.sel.expr, 120)) : esc(css);
  }

  function countRegex(expr) {
    if (!expr) return;
    fetch(`/api/extraction/check?url=${encodeURIComponent(S.url)}&type=regex&expr=${encodeURIComponent(expr)}`)
      .then((r) => r.json())
      .then((d) => {
        els.matches.innerHTML = d.error ? `<span class="s4">${esc(d.error)}</span>`
          : `${tt('Correspondências na página')}: <b>${d.count}</b> — ${esc(clip(d.sample || '', 120) || '—')}`;
      })
      .catch(() => {});
  }

  function add() {
    if (!S.sel) return;
    const tag = S.sel.el.tagName.toLowerCase();
    const base = S.attr ? `${tag}-${S.attr.replace(/[^\w-]/g, '')}${lastPathSeg(S.url) ? '-' + lastPathSeg(S.url) : ''}`
      : `${tag}${lastPathSeg(S.url) ? '-' + lastPathSeg(S.url) : ''}`;
    const fallback = S.sel.el.tagName.toLowerCase() + (lastPathSeg(S.url) ? '-' + lastPathSeg(S.url) : '');
    let name = base || fallback;
    let i = 2;
    while (S.list.some((x) => x.name === name)) name = `${base}-${i++}`;
    S.list.push({ name, type: S.type, expr: S.type === 'regex' ? S.sel.expr : S.sel.expr, attr: S.type === 'regex' ? '' : S.attr, value: clip(S.sel.value, 120) });
    renderList();
  }

  function renderList() {
    const n = S.list.length;
    els.n.textContent = n ? `${n} ${tt(n === 1 ? 'item' : 'itens')}` : '0';
    els.apply.disabled = !n;
    els.layout.disabled = !n;
    if (!n) {
      els.items.innerHTML = `<div class="empty">${tt('Nada extraído ainda.')}</div>`;
      return;
    }
    els.items.innerHTML = '<table><thead><tr><th>Nome</th><th>Tipo</th><th>Expressão</th><th></th></tr></thead><tbody>' +
      S.list.map((x, i) => `<tr><td class="nt">${esc(x.name)}</td><td>${esc(x.type)}</td><td class="nt" title="${esc(x.expr)}">${esc(clip(x.expr, 60))}</td>` +
        `<td><button type="button" class="tbtn" data-exv-del="${i}" title="Remover">×</button></td></tr>`).join('') + '</tbody></table>';
  }

  function apply() {
    if (!S.list.length) return;
    if (typeof window.cfgExtract !== 'function') {
      window.alert(tt('A janela de Extração personalizada não está disponível nesta versão.'));
      return;
    }
    const items = S.list.map((x) => ({ name: x.name, type: x.type, expr: x.expr, attr: x.attr }));
    if (typeof window.cfgExtract === 'function') window.cfgExtract(items, S.url);
    close();
  }

  function wire() {
    document.getElementById('exvX').onclick = close;
    document.getElementById('exvClose').onclick = close;
    els.apply.onclick = apply;
    els.layout.onclick = add;
    els.load.onclick = load;
    els.page.onchange = load;
    els.attr.onchange = () => { S.attr = els.attr.value.trim(); if (S.sel) showPick(S.sel.el, S.sel.css); };
    els.attr.closest('label').hidden = false;
    els.clear.onclick = () => { S.list = []; renderList(); };
    els.root.addEventListener('click', (e) => {
      const ty = e.target.closest('[data-exv-type]');
      if (ty) setType(ty.dataset.exvType);
      const del = e.target.closest('[data-exv-del]');
      if (del) { S.list.splice(+del.dataset.exvDel, 1); renderList(); }
      if (e.target === els.root) close();
    });
  }

  // API pública usada por app.js / cfgwin.js
  window.EXTRACT = {
    open,
    close,
    add,
    list: () => S.list.slice(),
    reset() { S.list = []; if (els.items) renderList(); },
  };
})();
