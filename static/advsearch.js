// Advanced Table Search: OR-groups of AND-rules (column + operator + query) for the main grid and the lower detail table.
(() => {
  const OPS = [['~', 'Contém'], ['!~', 'Não contém'], ['=', 'Igual a'], ['!=', 'Diferente de'], [':', 'Corresponde ao regex'],
    ['!:', 'Não corresponde ao regex'], ['{', 'Começa com'], ['!{', 'Não começa com'], ['}', 'Termina com'], ['!}', 'Não termina com'],
    ['<', 'Menor que'], ['>', 'Maior que'], ['empty', 'Está vazio'], ['notempty', 'Não está vazio']];
  const NOQ = new Set(['empty', 'notempty']);
  const state = { main: {}, detail: {} };   // scope -> table key -> groups
  let edit = null;                          // { scope, key, cols: [{key,label}], groups }

  // ---------- matching ----------
  function compile(rule) {
    const { op } = rule;
    const q = rule.q ?? '';
    const cs = !!rule.cs;
    const str = (v) => (v == null ? '' : String(v));
    if (op === 'empty') return (v) => !str(v).trim();
    if (op === 'notempty') return (v) => !!str(v).trim();
    if (q === '') return null;
    if (op === ':' || op === '!:') {
      let re;
      try { re = new RegExp(q, cs ? '' : 'i'); } catch { return null; }
      return op === ':' ? (v) => re.test(str(v)) : (v) => !re.test(str(v));
    }
    if (op === '<' || op === '>') {
      const n = parseFloat(q.replace(',', '.'));
      if (Number.isNaN(n)) return null;
      return (v) => {
        const x = typeof v === 'number' ? v : parseFloat(str(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
        return !Number.isNaN(x) && (op === '<' ? x < n : x > n);
      };
    }
    const norm = (s) => (cs ? str(s) : str(s).toLowerCase());
    const Q = norm(q);
    const base = { '~': (v) => norm(v).includes(Q), '=': (v) => norm(v) === Q, '{': (v) => norm(v).startsWith(Q), '}': (v) => norm(v).endsWith(Q) }[op.replace('!', '')];
    return op.startsWith('!') ? (v) => !base(v) : base;
  }
  function compileGroups(groups) {
    const gs = (groups || []).map((g) => g.map((r) => ({ col: r.col, fn: compile(r) })).filter((x) => x.fn)).filter((g) => g.length);
    return gs.length ? (get) => gs.some((g) => g.every(({ col, fn }) => fn(get(col)))) : null;
  }
  const mainKey = () => S.tab;
  const detailKey = () => S.detail;

  // ---------- public hooks used by app.js ----------
  window.ADV = {
    rows(rows) {
      const m = compileGroups(state.main[mainKey()]);
      return m ? rows.filter((r) => m((k) => r[k])) : rows;
    },
    detailMatcher() {
      const m = compileGroups(state.detail[detailKey()]);
      if (!m) return null;
      const heads = [...$$('#detailBody thead th')].map((th) => th.textContent.trim());
      return (tr) => m((col) => { const i = heads.indexOf(col); return i < 0 ? '' : tr.children[i]?.textContent.trim() ?? ''; });
    },
    active(main) { return !!compileGroups(main ? state.main[mainKey()] : state.detail[detailKey()]); },
    open,
  };

  // ---------- dialog ----------
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'advModal';
  modal.hidden = true;
  // icons (same look as the reference dialog)
  const I = {
    dup: '<svg viewBox="0 0 18 18" width="18" height="18"><path d="M3 5.5h7.5v10H3z" fill="#fff" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.5 5.5V2.5h5l3 3v7h-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M11.5 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 9.5l3 3" stroke="#6cb33f" stroke-width="1.6"/></svg>',
    del: '<svg viewBox="0 0 18 18" width="18" height="18"><path d="M3 4.5h12M7 4.5V2.8h4v1.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4.5 4.5l.8 11h7.4l.8-11z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.3 7v6.5M9 7v6.5M10.7 7v6.5" stroke="currentColor" stroke-width="1.2"/></svg>',
    delFill: '<svg viewBox="0 0 18 18" width="18" height="18"><path d="M2.5 3.6h13v1.6h-13zM6.6 2h4.8v1.8H6.6z" fill="currentColor"/><path d="M4 6h10l-.8 10.5H4.8z" fill="currentColor"/><path d="M7 8v6.5M9 8v6.5M11 8v6.5" stroke="#fff" stroke-width="1.1"/></svg>',
    expand: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M7 1.5v11M1.5 7h11" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
    plusBox: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1" y="1" width="14" height="14" rx="2.5" fill="#fff"/><path d="M8 4v8M4 8h8" stroke="#6cb33f" stroke-width="2.4" stroke-linecap="round"/></svg>',
    reset: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M13.2 6.2A5.4 5.4 0 0 0 3.3 4.4M2.8 9.8a5.4 5.4 0 0 0 9.9 1.8" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/><path d="M2.2 2.2v3.6h3.6M13.8 13.8v-3.6h-3.6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  modal.innerHTML = `<div class="window advwin"><div class="wtitle"><span>Busca avançada na tabela</span><button class="wclose" data-adv="cancel">✕</button></div>
    <div class="wbody advbody"><div class="advgroups"></div><div class="advor"><button type="button" class="tbtn advgreen" data-adv="or">${I.plusBox}<span>OU</span></button></div></div>
    <div class="advbar"><button type="button" class="tbtn advred" data-adv="reset">${I.reset}<span>Restaurar</span></button></div>
    <div class="wfoot"><button type="button" class="tbtn primary advok" data-adv="ok">OK</button><button type="button" class="tbtn advcancel" data-adv="cancel">Cancelar</button></div></div>`;
  document.body.appendChild(modal);
  const box = modal.querySelector('.advgroups');

  const newRule = () => ({ col: edit.cols.find((c) => c.def)?.key || edit.cols[0]?.key || '', op: '~', q: '', cs: false });
  function open(main) {
    closeFloating();
    let cols, key;
    if (main) {
      key = mainKey();
      cols = colsOf(TABS[S.tab]).map((c) => ({ key: c.key, label: t(c.label) }));
    } else {
      key = detailKey();
      cols = [...$$('#detailBody thead th')].map((th) => ({ key: th.textContent.trim(), label: th.textContent.trim() }));
      if (!cols.length) return;
    }
    const scope = main ? 'main' : 'detail';
    const saved = state[scope][key];
    edit = { scope, key, cols, groups: saved ? JSON.parse(JSON.stringify(saved)) : [] };
    if (main && cols.some((c) => c.key === 'url')) cols.find((c) => c.key === 'url').def = true;
    if (!main && cols.some((c) => c.key === t('Para'))) cols.find((c) => c.key === t('Para')).def = true;
    if (!edit.groups.length) edit.groups = [[newRule()]];
    draw();
    modal.hidden = false;
  }
  function ruleOk(r) { return !!compile(r); }
  function draw() {
    box.innerHTML = edit.groups.map((g, gi) => `${gi ? `<div class="advsep">${t('OU')}</div>` : ''}<div class="advgroup" data-g="${gi}">
      ${g.map((r, ri) => {
        const ok = ruleOk(r);
        return `${ri ? `<div class="advand">${t('E')}</div>` : ''}<div class="advwrap" data-r="${ri}"><div class="advrule">
        <select data-f="col">${edit.cols.map((c) => `<option value="${esc(c.key)}" ${c.key === r.col ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
        <select data-f="op">${OPS.map(([v, l]) => `<option value="${v}" ${v === r.op ? 'selected' : ''}>${esc(t(l))}${NOQ.has(v) ? '' : ` ( ${v} )`}</option>`).join('')}</select>
        <div class="advq"><input data-f="q" placeholder="${esc(t('Digite a consulta'))}" value="${esc(r.q)}" ${NOQ.has(r.op) ? 'disabled' : ''}>
          <button type="button" class="advexpbtn" data-adv="exp" title="${esc(t('Expandir'))}">${I.expand}</button>
          ${r.exp ? `<div class="advpop"><input data-f="q" value="${esc(r.q)}" ${NOQ.has(r.op) ? 'disabled' : ''}>
            <label class="advpopcs"><input type="checkbox" data-f="cs" ${r.cs ? 'checked' : ''}> ${t('Diferenciar maiúsculas/minúsculas')}</label></div>` : ''}</div>
        <span class="advst ${ok ? 'ok' : 'bad'}" title="${esc(t(ok ? 'Regra válida' : NOQ.has(r.op) || r.q ? 'Regra inválida' : 'Não pode ficar vazio'))}">!</span>
        <button type="button" class="tbtn advic" data-adv="duprule" title="${esc(t('Duplicar regra'))}">${I.dup}</button>
        <button type="button" class="tbtn advic" data-adv="delrule" title="${esc(t('Remover regra'))}">${I.del}</button></div>
</div>`;
      }).join('')}
      <div class="advgfoot"><button type="button" class="tbtn advic" data-adv="dupgroup" title="${esc(t('Duplicar grupo de regras'))}">${I.dup}</button>
        <button type="button" class="tbtn advic" data-adv="delgroup" title="${esc(t('Remover grupo de regras'))}">${I.delFill}</button>
        <button type="button" class="tbtn advgreen" data-adv="and">${I.plus}<span>${t('E')}</span></button></div></div>`).join('')
      || `<div class="empty">${t('Nenhuma regra de busca adicionada')}</div>`;
  }
  function apply() {
    const groups = edit.groups.map((g) => g.filter((r) => ruleOk(r))).filter((g) => g.length);
    if (groups.length) state[edit.scope][edit.key] = groups; else delete state[edit.scope][edit.key];
    modal.hidden = true;
    syncSearchOpts();
    if (edit.scope === 'main') renderTable(); else filterDetail();
  }
  modal.addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    const gi = +e.target.closest('[data-g]').dataset.g, ri = +e.target.closest('[data-r]').dataset.r;
    const r = edit.groups[gi][ri];
    r[f] = f === 'cs' ? e.target.checked : e.target.value;
    if (f === 'op' || f === 'col') { draw(); return; }
    const wrap = e.target.closest('[data-r]');
    if (f === 'q') wrap.querySelectorAll('[data-f="q"]').forEach((x) => { if (x !== e.target) x.value = r.q; });
    wrap.querySelector('.advst').className = 'advst ' + (ruleOk(r) ? 'ok' : 'bad');
  });
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-adv]');
    if (!b) return;
    const act = b.dataset.adv;
    const gi = b.closest('[data-g]') ? +b.closest('[data-g]').dataset.g : -1;
    const ri = b.closest('[data-r]') ? +b.closest('[data-r]').dataset.r : -1;
    const G = edit?.groups;
    if (act === 'cancel') { modal.hidden = true; return; }
    if (act === 'ok') { apply(); return; }
    if (act === 'exp') {
      const was = G[gi][ri].exp;
      closePops();
      G[gi][ri].exp = !was;
    }
    if (act === 'reset') edit.groups = [[newRule()]];
    if (act === 'or') G.push([newRule()]);
    if (act === 'and') G[gi].push(newRule());
    if (act === 'duprule') G[gi].splice(ri + 1, 0, { ...G[gi][ri], exp: false });
    if (act === 'delrule') { G[gi].splice(ri, 1); if (!G[gi].length) G.splice(gi, 1); }
    if (act === 'dupgroup') G.splice(gi + 1, 0, JSON.parse(JSON.stringify(G[gi])).map((r) => ({ ...r, exp: false })));
    if (act === 'delgroup') G.splice(gi, 1);
    draw();
    modal.querySelector('.advpop input[data-f="q"]')?.focus();
  });
  // expanded query editor (popup under the ⤢ icon): closes on a click outside it or Escape
  function closePops() { edit?.groups.forEach((g) => g.forEach((r) => { r.exp = false; })); }
  modal.addEventListener('mousedown', (e) => {
    if (!edit || e.target.closest('.advpop, .advexpbtn') || !modal.querySelector('.advpop')) return;
    closePops();
    draw();
  });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.querySelector('.advpop')) { closePops(); draw(); return; }
    if (e.key === 'Enter' && e.target.matches('input[data-f="q"]')) { e.preventDefault(); apply(); }
    if (e.key === 'Escape') modal.hidden = true;
  });
})();
syncSearchOpts();   // initial tooltips on the search option icons
