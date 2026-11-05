// SERP Snippet tab (lower window): Google result preview, Chars/Pixels table and an editor (title, description, device,
// site name, keywords, description prefix, rich snippet). Edits are kept per URL until "Revert Changes".
(() => {
  const EDIT = new Map();   // url -> { title, desc, device, site, kw, prefix, prefixMode, rich, richMode }
  const DEVICES = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet' };
  const RICH = { none: 'Nenhum', reviews: 'Avaliações', people: 'Pessoas', events: 'Eventos' };
  const PREFIX = { none: 'Nenhum', date: 'Data', products: 'Nº de produtos' };
  let ctx;
  // canvas width calibrated to the crawler's own pixel measure (same fonts the stats use)
  function px(text, font) {
    ctx ||= document.createElement('canvas').getContext('2d');
    ctx.font = font;
    return ctx.measureText(text || '').width;
  }
  const FONT = { title: '20px Arial', desc: '14px Arial' };
  function widthOf(kind, text, rec) {
    const raw = px(text, FONT[kind]);
    const orig = kind === 'title' ? rec.title : rec.meta_desc;
    const ref = kind === 'title' ? rec.title_px : rec.md_px;
    const k = orig && ref && px(orig, FONT[kind]) ? ref / px(orig, FONT[kind]) : 1;
    return Math.round(raw * k);
  }
  // truncate on word boundaries, like Google
  function fit(text, max, kind, rec) {
    if (widthOf(kind, text, rec) <= max) return { shown: text, cut: false };
    const words = text.split(/(\s+)/);
    let out = '';
    for (const w of words) {
      if (widthOf(kind, (out + w).trimEnd() + ' ...', rec) > max) break;
      out += w;
    }
    return { shown: out.trimEnd() + ' ...', cut: true };
  }
  const prefOf = (k, def) => (typeof PF === 'function' ? PF(k) : def) || def;
  function state(rec) {
    if (!EDIT.has(rec.url)) {
      EDIT.set(rec.url, { title: rec.title || '', desc: rec.meta_desc || '', device: 'desktop', site: '', kw: '', prefix: '',
        prefixMode: 'none', rich: '', richMode: 'none' });
    }
    return EDIT.get(rec.url);
  }
  function hl(text, kw) {
    let h = esc(text);
    const words = kw.split(',').map((x) => x.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const w of words) h = h.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<b>$1</b>');
    return h;
  }
  function today() {
    return new Date().toLocaleDateString(LANG === 'en' ? 'en-GB' : LANG === 'es' ? 'es-ES' : 'pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const PREFIX_TEXT = { none: '', date: () => today() + ' — ', products: () => '12 ' + t('produtos') + ' — ' };
  const RICH_TEXT = { none: '', reviews: () => t('Avaliação: 4,5 · 128 avaliações'), people: () => t('12 pessoas · Diretor executivo'),
    events: () => t('Sáb., 14 dez. · Evento de exemplo') };

  function preview(rec, st) {
    let host = rec.url, crumbs = rec.url;
    try {
      const u = new URL(rec.url);
      host = u.host.replace(/^www\./, '');
      crumbs = u.origin + u.pathname.split('/').filter(Boolean).map((s) => ' › ' + s).join('');
    } catch {}
    const titleMax = prefOf('title_px_max', 561), descMax = prefOf('md_px_max', 985);
    const prefix = st.prefix || (PREFIX_TEXT[st.prefixMode] ? PREFIX_TEXT[st.prefixMode]() : '');
    const t1 = fit(st.title, titleMax, 'title', rec);
    const d1 = fit(prefix + st.desc, descMax, 'desc', rec);
    const rich = st.rich || (RICH_TEXT[st.richMode] ? RICH_TEXT[st.richMode]() : '');
    let fav = '';
    try { fav = new URL('/favicon.ico', rec.url).href; } catch {}
    return { host, crumbs, t1, d1, rich, prefix, titleMax, descMax,
      html: `<div class="sp-card sp-${st.device}">
        <div class="sp-site"><span class="sp-fav">${fav ? `<img src="${esc(fav)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'sp-favx',textContent:'✕'}))">` : '<span class="sp-favx">✕</span>'}</span>
          <div><div class="sp-name">${esc(st.site || host)}</div><div class="sp-url">${esc(crumbs)} <span class="sp-dots">⋮</span></div></div></div>
        <div class="sp-title">${hl(t1.shown || t('(sem title)'), st.kw)}</div>
        ${rich ? `<div class="sp-rich">${st.richMode === 'reviews' ? '<span class="sp-stars">★★★★★</span> ' : ''}${esc(rich)}</div>` : ''}
        <div class="sp-desc">${hl(d1.shown || t('(sem meta description — o Google gera um trecho da página)'), st.kw)}</div></div>` };
  }
  function stats(rec, st, p) {
    const row = (label, full, shown, kind, max) => {
      const len = [...full].length, disp = [...shown.replace(/ \.\.\.$/, '')].length;
      const w = widthOf(kind, full, rec);
      const trunc = len - disp, rem = max - w;
      return `<tr><td>${t(label)}</td><td class="num">${len}</td><td class="num">${disp}</td><td class="num ${trunc > 0 ? 's4' : 's2'}">${trunc}</td>
        <td class="num">${w}</td><td class="num">${max}</td><td class="num ${rem < 0 ? 's4' : 's2'}">${rem}</td></tr>`;
    };
    return `<table class="sp-stats"><thead><tr><th></th><th colspan="3" class="c">${t('Caract.')}</th><th colspan="3" class="c">${t('Pixels')}</th></tr>
      <tr><th>${t('Elemento')}</th><th>${t('Comprimento')}</th><th>${t('Exibido')}</th><th>${t('Truncado')}</th><th>${t('Comprimento')}</th><th>${t('Disponível')}</th><th>${t('Restante')}</th></tr></thead>
      <tbody>${row('Title', st.title, p.t1.shown, 'title', p.titleMax)}${row('Description', p.prefix + st.desc, p.d1.shown, 'desc', p.descMax)}</tbody></table>`;
  }
  function editor(st) {
    const opt = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(t(l))}</option>`).join('');
    return `<div class="sp-edit">
      <div class="sp-left">
        <label class="sp-row"><span>${t('Title')}</span><input data-sp="title" value="${esc(st.title)}"></label>
        <label class="sp-row sp-top"><span>${t('Description')}</span><textarea data-sp="desc" rows="7">${esc(st.desc)}</textarea></label>
        <div class="sp-row"><span></span><button type="button" class="tbtn" data-sp-revert>${t('Reverter alterações')}</button></div>
      </div>
      <div class="sp-right">
        <label class="sp-row"><span>${t('Dispositivo')}</span><select data-sp="device" class="sp-short">${opt(DEVICES, st.device)}</select></label>
        <label class="sp-row"><span>${t('Nome do site')}</span><input data-sp="site" value="${esc(st.site)}" placeholder="${esc(t('Digite o nome do site aqui...'))}"></label>
        <label class="sp-row"><span>${t('Palavras-chave')}</span><input data-sp="kw" value="${esc(st.kw)}" placeholder="${esc(t('Digite as palavras-chave aqui...'))}"></label>
        <div class="sp-gap"></div>
        <div class="sp-row"><span>${t('Prefixo da descrição')}</span><input data-sp="prefix" value="${esc(st.prefix)}" placeholder="${esc(t('Digite o prefixo da descrição aqui...'))}">
          <select data-sp="prefixMode" class="sp-mini">${opt(PREFIX, st.prefixMode)}</select></div>
        <div class="sp-row"><span>${t('Rich snippet')}</span><input data-sp="rich" value="${esc(st.rich)}" placeholder="${esc(t('Digite o rich snippet aqui...'))}">
          <select data-sp="richMode" class="sp-mini">${opt(RICH, st.richMode)}</select><span class="sp-stars sp-off">★★★★★</span></div>
      </div></div>`;
  }
  function render(d) {
    const rec = d.record;
    const st = state(rec);
    const p = preview(rec, st);
    return `<div class="sp-wrap"><div class="sp-top-row"><div class="sp-prev">${p.html}</div><div class="sp-tbl">${stats(rec, st, p)}</div></div>${editor(st)}</div>`;
  }
  function refresh() {
    const rec = selectedRecord();
    if (!rec) return;
    const st = state(rec);
    const p = preview(rec, st);
    $('#detailBody .sp-prev').innerHTML = p.html;
    $('#detailBody .sp-tbl').innerHTML = stats(rec, st, p);
  }
  DETAIL.serp = render;
  $('#detailBody').addEventListener('input', (e) => {
    const k = e.target.dataset.sp;
    if (!k) return;
    const rec = selectedRecord();
    if (!rec) return;
    state(rec)[k] = e.target.value;
    refresh();
  });
  $('#detailBody').addEventListener('click', (e) => {
    if (!e.target.closest('[data-sp-revert]')) return;
    const rec = selectedRecord();
    if (!rec) return;
    EDIT.delete(rec.url);
    renderDetail();
  });
})();
