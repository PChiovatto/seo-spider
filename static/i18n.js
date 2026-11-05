// UI translations (pt = source language, en, es). Strings live in i18n.json as [pt, en, es];
// "{{0}}" marks a placeholder. A MutationObserver translates rendered UI text automatically;
// crawl data (URLs, titles, anchors…) is protected by SKIP_SEL and never translated.
const LANGS = { pt: 'Português', en: 'English', es: 'Español' };
let LANG = (() => { try { return localStorage.getItem('seo-spider-lang') || 'pt'; } catch { return 'pt'; } })();
if (!LANGS[LANG]) LANG = 'pt';
document.documentElement.lang = { pt: 'pt-BR', en: 'en', es: 'es' }[LANG];

let DICT = new Map();
let TPLS = [];
let VALUES = {};
const SKIP_SEL = 'script,style,textarea,pre,code,a.link,[translate="no"],.nt,table.kv td + td,td.path';

function t(s) {
  if (LANG === 'pt' || s == null || typeof s !== 'string') return s;
  const hit = DICT.get(s);
  if (hit != null) return hit;
  if (/^[\d\s.,%:/()+\-–—▾▼▶]*$/.test(s) || /^https?:/.test(s)) return s;
  for (const [re, out] of TPLS) {
    const m = s.match(re);
    if (m) return out.replace(/\{\{(\d)\}\}/g, (_, i) => t(m[+i + 1]));
  }
  return s;
}
// translate a template and fill its {{n}} placeholders
function tf(key, ...args) {
  const out = LANG === 'pt' ? key : (DICT.get(key) ?? key);
  return out.replace(/\{\{(\d)\}\}/g, (_, i) => args[+i] ?? '');
}
// translate a crawl *value* (e.g. Indexable, "Bloqueado pelo robots.txt", comma lists)
function tv(v) {
  if (typeof v !== 'string' || !v) return v;
  const direct = VALUES[LANG]?.[v];
  if (direct != null) return direct;
  if (LANG === 'pt') return v;
  if (v.includes(', ')) return v.split(', ').map((x) => t(x)).join(', ');
  return t(v);
}

function trText(node) {
  const raw = node.nodeValue;
  const s = raw.trim();
  if (!s) return;
  const out = t(s);
  if (out !== s) node.nodeValue = raw.replace(s, out);
}
function trAttrs(el) {
  for (const a of ['placeholder', 'title', 'aria-label']) {
    const v = el.getAttribute(a);
    if (v) { const o = t(v.trim()); if (o !== v.trim()) el.setAttribute(a, o); }
  }
}
function trTree(root) {
  if (root.nodeType === 3) { if (!root.parentElement?.closest(SKIP_SEL)) trText(root); return; }
  if (root.nodeType !== 1) return;
  const placeholderOnly = root.matches('textarea');
  if (root.closest(SKIP_SEL) && !placeholderOnly) return;
  trAttrs(root);
  if (placeholderOnly) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === 1 && n.matches(SKIP_SEL)) {
        if (n.matches('textarea')) trAttrs(n);
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (w.nextNode()) { const n = w.currentNode; n.nodeType === 3 ? trText(n) : trAttrs(n); }
}

const I18N_READY = fetch('i18n.json?v=38').then((r) => r.json()).then((data) => {
  VALUES = data.values || {};
  const col = { en: 1, es: 2 }[LANG];
  if (col) {
    for (const row of data.strings) DICT.set(row[0], row[col]);
    TPLS = data.strings.filter((r) => r[0].includes('{{'))
      .sort((a, b) => b[0].length - a[0].length)
      .map((r) => [new RegExp('^' + r[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\\\{(\d)\\\}\\\}/g, '(.+?)') + '$'), r[col]]);
    trTree(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach(trTree);
        else if (m.type === 'characterData') trTree(m.target);
        else if (m.type === 'attributes' && m.target.nodeType === 1 && !m.target.closest(SKIP_SEL)) trAttrs(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] });
  }
}).catch(() => {});

function setLang(lang) {
  try { localStorage.setItem('seo-spider-lang', lang); } catch {}
  location.reload();
}
