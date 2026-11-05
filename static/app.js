const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kb = (n) => (n == null ? '' : (n / 1024).toFixed(1));
const yes = (v) => (v ? t('Sim') : '');
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const MAX_ROWS = 3000;
const EMPTY = () => ({ pages: [], external: [], images: [], issues: [], extractors: [], sitemaps: [], finalized: false });

let DATA = EMPTY();
let PAGE = new Map();
window.DATA = DATA;   // leitura pelo inspetor da Extração Visual

const S = {
  tab: 'internal', filter: 'all', custom: null, q: '', sort: null, dir: 1,
  sel: null, multi: new Set(), anchor: null, detail: 'details', view: 'list', viz: 'charts',
  treeState: {}, stState: {}, stLevel: 2, stView: 'indexability', chartView: 'chart',
  rtab: 'overview', hidden: store.get('seo-spider-cols', {}),
};
const detailCache = new Map();
const sourceCache = new Map();

// ---------- helpers ----------
const isHtml = (p) => p.status === 200 && p.content_type === 'text/html';
const htmlPages = () => DATA.pages.filter(isHtml);
const fetched = () => DATA.pages.filter((p) => p.status != null);
const blocked = (r) => r.status === 0 && (r.status_text || '').startsWith('Bloqueado');
const noResp = (r) => r.status === 0 && !blocked(r);
const range = (a, b) => (r) => r.status != null && r.status >= a && r.status <= b;
const lower = (s) => (s || '').trim().toLowerCase();
const path = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
const statusCls = (s) => (s == null ? '' : s === 0 ? 's0' : 's' + String(s)[0]);
const statusCell = (v) => (v == null ? '<span class="muted">…</span>' : `<span class="${statusCls(v)}">${v === 0 ? '—' : v}</span>`);
const scoreCls = (v) => (v == null ? '' : v >= 90 ? 'good' : v >= 50 ? 'avg' : 'poor');
const scoreCell = (v) => (v == null ? '' : `<b class="${scoreCls(v)}">${v}</b>`);
const pctFmt = (v) => (v == null ? '' : (v * 100).toFixed(2) + '%');
const pct = (n, total) => (total ? +((n / total) * 100).toFixed(2) : 0) + '%';

const CATS = ['HTML', 'JavaScript', 'CSS', 'Imagens', 'Mídia', 'Fontes', 'XML', 'PDF', 'Plugins', 'Outros'];
function category(r) {
  if (r.__cat) return r.__cat;
  const ct = (r.content_type || '').toLowerCase();
  const u = r.url.toLowerCase().split(/[?#]/)[0];
  const ext = (u.match(/\.([a-z0-9]{2,5})$/) || [])[1] || '';
  let c = 'Outros';
  if (ct.includes('html') || (!ct && !ext) || (!ct && ['html', 'htm', 'php', 'asp', 'aspx'].includes(ext))) c = 'HTML';
  else if (ct.includes('javascript') || ct.includes('ecmascript') || ext === 'js' || ext === 'mjs') c = 'JavaScript';
  else if (ct.includes('css') || ext === 'css') c = 'CSS';
  else if (ct.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp'].includes(ext)) c = 'Imagens';
  else if (ct.startsWith('video/') || ct.startsWith('audio/') || ['mp4', 'webm', 'mp3', 'ogg', 'wav', 'mov'].includes(ext)) c = 'Mídia';
  else if (ct.includes('font') || ['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) c = 'Fontes';
  else if (ct.includes('xml') || ext === 'xml') c = 'XML';
  else if (ct.includes('pdf') || ext === 'pdf') c = 'PDF';
  else if (ct.includes('flash') || ct.includes('java-archive') || ['swf', 'jar'].includes(ext)) c = 'Plugins';
  return (r.__cat = c);
}

const C = (key, label, o = {}) => ({ key, label, ...o });
const rowKey = (r) => r.key ?? r.url ?? r.name;
const URL_COL = C('url', 'Endereço');
const STATUS = C('status', 'Código', { num: 1, fmt: statusCell });
const STEXT = C('status_text', 'Status', { tr: 1 });
const IDX = C('indexability', 'Indexabilidade', { tr: 1 });
const SIZE = C('size', 'Tamanho (KB)', { num: 1, fmt: kb });
const ALL = ['Todos', () => true];
const has = (k, s) => (r) => (r[k] || '').includes(s);
const catFilters = () => Object.fromEntries([['all', ALL], ...CATS.map((c) => [c, [c, (r) => category(r) === c]])]);

const robotsOf = (r) => ((r.meta_robots || '') + ' ' + (r.x_robots || '')).toLowerCase();
const dir = (re) => (r) => re.test(robotsOf(r));
const SEARCH_RE = /[?&](s|q|query|search|busca|buscar|k|keyword)=|\/(search|busca|buscar|pesquisa)(\/|$|\?)/i;
const GA_RE = /[?&](utm_[a-z]+|_ga|_gl|gclid)=/i;
const repetitive = (u) => { const p = path(u).toLowerCase().split('/').filter(Boolean); return p.length !== new Set(p).size; };
const opp = (id) => (r) => (r.psi_opps || '').split(', ').includes(id);
// Spider > Preferences: thresholds of the crawl (DATA.prefs), labels follow them
const PREF_DEF = { title_px_min: 200, title_px_max: 561, title_min: 30, title_max: 60, md_px_min: 400, md_px_max: 985, md_min: 70, md_max: 155,
  ext_outlinks: 10, int_outlinks: 1000, deep: 3, url_max: 115, h1_max: 70, h2_max: 70, alt_max: 100, img_kb: 100, low_words: 200, slow_s: 1 };
const PF = (k) => (DATA.prefs && DATA.prefs[k] != null ? DATA.prefs[k] : PREF_DEF[k]);
const L = (tpl, k) => ({ toString: () => tf(tpl, PF(k)) });
const CODE_FILTERS = {
  all: ALL,
  blocked: ['Bloqueado pelo robots.txt', blocked],
  blockedres: ['Recurso bloqueado', (r) => r.blocked_resource],
  noresp: ['Sem resposta', noResp],
  s2: ['Sucesso (2xx)', range(200, 299)],
  s3: ['Redirecionamento (3xx)', range(300, 399)],
  jsredir: ['Redirecionamento (JavaScript)', (r) => r.js_redirect],
  metaref: ['Redirecionamento (meta refresh)', (r) => r.meta_refresh_url && r.meta_refresh_url !== r.url],
  s4: ['Erro de cliente (4xx)', range(400, 499)],
  s5: ['Erro de servidor (5xx)', range(500, 599)],
};

// external URLs = external links/resources + external images (images on other hosts are kept in DATA.images)
const extAll = () => { const seen = new Set(DATA.external.map((e) => e.url)); return DATA.external.concat(DATA.images.filter((i) => !seen.has(i.url))); };
const TABS = {
  internal: {
    label: 'Internos', rows: () => DATA.pages, filters: catFilters(),
    cols: [URL_COL, C('content_type', 'Tipo de conteúdo'), STATUS, STEXT, IDX, C('indexability_reason', 'Motivo', { tr: 1 }),
      C('title', 'Title 1'), C('title_len', 'Tam. title', { num: 1 }), C('meta_desc', 'Meta Description 1'), C('md_len', 'Tam. description', { num: 1 }),
      C('h1_1', 'H1-1'), C('meta_robots', 'Meta Robots'), C('canonical', 'Canonical'), SIZE, C('word_count', 'Palavras', { num: 1 }),
      C('response_ms', 'Tempo de resposta (ms)', { num: 1 }), C('depth', 'Profund.', { num: 1 }), C('inlinks', 'Inlinks', { num: 1 }),
      C('unique_inlinks', 'Inlinks únicos', { num: 1 }), C('outlinks', 'Outlinks', { num: 1 }), C('external_outlinks', 'Outlinks ext.', { num: 1 }),
      C('link_score', 'Link Score', { num: 1 }), C('segment', 'Segmento'), C('found_via', 'Encontrada via', { fmt: viaFmt }),
      C('pdf_pages', 'Páginas do PDF', { num: 1 }), C('text_ratio', 'Proporção texto/código (%)', { num: 1 }), C('last_modified', 'Last-Modified'),
      C('co2_mg', 'CO2 (mg)', { num: 1 }), C('green_hosting', 'Hospedagem verde', { fmt: yes })],
  },
  external: {
    label: 'Externos', rows: () => extAll(), filters: catFilters(),
    cols: [URL_COL, C('content_type', 'Tipo de conteúdo'), STATUS, STEXT, C('response_ms', 'Tempo de resposta (ms)', { num: 1 }), C('inlinks', 'Inlinks', { num: 1 }), C('unique_inlinks', 'Inlinks únicos', { num: 1 })],
  },
  security: {
    label: 'Segurança', rows: htmlPages,
    cols: [URL_COL, C('mixed_content', 'Conteúdo misto', { num: 1 }), C('hsts_http_links', 'Links HTTP para host com HSTS', { num: 1 }), C('sec_missing', 'Cabeçalhos ausentes'),
      C('forms', 'Formulários', { num: 1 }), C('unsafe_cross_origin', 'Links cross-origin inseguros', { num: 1 }), C('protocol_relative', 'Recursos com protocolo relativo', { num: 1 })],
    filters: {
      all: ALL,
      http: ['URLs HTTP', (r) => r.url.startsWith('http:')],
      https: ['URLs HTTPS', (r) => r.url.startsWith('https:')],
      mixed: ['Conteúdo misto', (r) => r.mixed_content > 0],
      hsts: ['Sem HSTS', has('sec_missing', 'HSTS')],
      xcto: ['Sem X-Content-Type-Options', has('sec_missing', 'X-Content-Type-Options')],
      xfo: ['Sem X-Frame-Options', has('sec_missing', 'X-Frame-Options')],
      csp: ['Sem Content-Security-Policy', has('sec_missing', 'Content-Security-Policy')],
      ref: ['Sem Referrer-Policy', has('sec_missing', 'Referrer-Policy')],
      hstslinks: ['Links HTTP internos para host com HSTS', (r) => r.hsts_http_links > 0],
      formhttp: ['Formulário em URL HTTP', (r) => r.form_on_http],
      forminsecure: ['Formulário com ação HTTP insegura', (r) => r.form_insecure],
      unsafe: ['Links cross-origin inseguros', (r) => r.unsafe_cross_origin > 0],
      protorel: ['Links de recursos com protocolo relativo', (r) => r.protocol_relative > 0],
    },
  },
  codes: {
    label: 'Códigos de resposta',
    rows: () => DATA.pages.map((p) => ({ ...p, type: 'Interno' })).concat(extAll().map((e) => ({ ...e, type: 'Externo' }))),
    cols: [URL_COL, C('content_type', 'Tipo de conteúdo'), STATUS, STEXT, C('type', 'Origem', { tr: 1 }), C('redirect_url', 'URL de redirecionamento'),
      C('meta_refresh_url', 'Destino do meta refresh'), C('js_redirect', 'Destino do redirecionamento JS'),
      C('robots_line', 'Linha do robots.txt'), C('inlinks', 'Inlinks', { num: 1 })],
    filters: CODE_FILTERS,
  },
  url: {
    label: 'URL', rows: fetched,
    cols: [URL_COL, C('url_len', 'Caracteres', { num: 1 }), STATUS, IDX, C('broken_bookmarks', 'Âncoras (#) quebradas', { num: 1 })],
    filters: {
      all: ALL,
      nonascii: ['Caracteres não-ASCII', (r) => /[^\x00-\x7f]|%/.test(path(r.url))],
      under: ['Underscores', (r) => path(r.url).includes('_')],
      upper: ['Maiúsculas', (r) => path(r.url) !== path(r.url).toLowerCase()],
      params: ['Parâmetros', (r) => r.url.includes('?')],
      dslash: ['Barras duplas', (r) => path(r.url).includes('//')],
      long: [L('Acima de {{0}} caracteres', 'url_max'), (r) => r.url_len > PF('url_max')],
      repet: ['Caminho repetitivo', (r) => repetitive(r.url)],
      space: ['Contém espaço', (r) => / |%20/.test(r.url)],
      search: ['Busca interna', (r) => SEARCH_RE.test(r.url)],
      ga: ['Parâmetros de rastreamento do GA', (r) => GA_RE.test(r.url)],
      bookmark: ['Âncora (#) quebrada', (r) => r.broken_bookmarks > 0],
    },
  },
  titles: {
    label: 'Page Titles', rows: htmlPages,
    cols: [URL_COL, IDX, C('title', 'Title 1'), C('title_len', 'Tam. title 1', { num: 1 }), C('title_px', 'Largura title 1 (px)', { num: 1 }), C('h1_1', 'H1-1'), C('title_count', 'Qtd. titles', { num: 1 })],
    filters: {
      all: ALL,
      missing: ['Ausente', (r) => !r.title],
      dup: ['Duplicado', (r) => r.title_dup],
      over: [L('Acima de {{0}} caracteres', 'title_max'), (r) => r.title_len > PF('title_max')],
      below: [L('Abaixo de {{0}} caracteres', 'title_min'), (r) => r.title_len > 0 && r.title_len < PF('title_min')],
      overpx: [L('Acima de {{0}} pixels', 'title_px_max'), (r) => r.title_px > PF('title_px_max')],
      belowpx: [L('Abaixo de {{0}} pixels', 'title_px_min'), (r) => r.title_px > 0 && r.title_px < PF('title_px_min')],
      sameh1: ['Igual ao H1', (r) => r.title && lower(r.title) === lower(r.h1_1)],
      multiple: ['Múltiplos', (r) => r.title_count > 1],
      outside: ['Fora do <head>', (r) => r.title_outside_head],
    },
  },
  meta: {
    label: 'Meta Description', rows: htmlPages,
    cols: [URL_COL, IDX, C('meta_desc', 'Meta Description 1'), C('md_len', 'Tam. description 1', { num: 1 }), C('md_px', 'Largura description 1 (px)', { num: 1 }), C('md_count', 'Qtd. descriptions', { num: 1 })],
    filters: {
      all: ALL,
      missing: ['Ausente', (r) => !r.meta_desc],
      dup: ['Duplicada', (r) => r.meta_desc_dup],
      over: [L('Acima de {{0}} caracteres', 'md_max'), (r) => r.md_len > PF('md_max')],
      below: [L('Abaixo de {{0}} caracteres', 'md_min'), (r) => r.md_len > 0 && r.md_len < PF('md_min')],
      overpx: [L('Acima de {{0}} pixels', 'md_px_max'), (r) => r.md_px > PF('md_px_max')],
      belowpx: [L('Abaixo de {{0}} pixels', 'md_px_min'), (r) => r.md_px > 0 && r.md_px < PF('md_px_min')],
      multiple: ['Múltiplas', (r) => r.md_count > 1],
      outside: ['Fora do <head>', (r) => r.md_outside_head],
    },
  },
  keywords: {
    label: 'Meta Keywords', rows: htmlPages,
    cols: [URL_COL, IDX, C('meta_keywords', 'Meta Keywords 1')],
    filters: { all: ALL, missing: ['Ausente', (r) => !r.meta_keywords], has: ['Contém', (r) => r.meta_keywords] },
  },
  h1: {
    label: 'H1', rows: htmlPages,
    cols: [URL_COL, IDX, C('h1_1', 'H1-1'), C('h1_len', 'Tam. H1-1', { num: 1 }), C('h1_2', 'H1-2'), C('h1_count', 'Qtd. H1', { num: 1 })],
    filters: {
      all: ALL,
      missing: ['Ausente', (r) => r.h1_count === 0],
      dup: ['Duplicado', (r) => r.h1_1_dup],
      over: [L('Acima de {{0}} caracteres', 'h1_max'), (r) => r.h1_len > PF('h1_max')],
      multiple: ['Múltiplos', (r) => r.h1_count > 1],
      alt: ['Texto alt no H1', (r) => r.h1_img_alt],
      nonseq: ['Não sequencial', (r) => r.h1_nonseq],
    },
  },
  h2: {
    label: 'H2', rows: htmlPages,
    cols: [URL_COL, IDX, C('h2_1', 'H2-1'), C('h2_len', 'Tam. H2-1', { num: 1 }), C('h2_2', 'H2-2'), C('h2_count', 'Qtd. H2', { num: 1 })],
    filters: {
      all: ALL,
      missing: ['Ausente', (r) => r.h2_count === 0],
      dup: ['Duplicado', (r) => r.h2_1_dup],
      over: [L('Acima de {{0}} caracteres', 'h2_max'), (r) => r.h2_len > PF('h2_max')],
      multiple: ['Múltiplos', (r) => r.h2_count > 1],
      nonseq: ['Não sequencial', (r) => r.h2_nonseq],
    },
  },
  content: {
    label: 'Conteúdo', rows: htmlPages,
    cols: [URL_COL, IDX, C('word_count', 'Palavras', { num: 1 }), C('closest_similarity', 'Maior similaridade %', { num: 1 }),
      C('near_dup_count', 'Nº quase duplicados', { num: 1 }), C('content_hash_dup', 'Duplicado exato', { fmt: yes }),
      C('semantic_max', 'Similaridade semântica', { num: 1 }), C('semantic_closest', 'Página semanticamente mais próxima'),
      C('semantic_relevance', 'Relevância semântica', { num: 1 }), C('spelling_errors', 'Erros de ortografia', { num: 1 }),
      C('grammar_errors', 'Erros de gramática', { num: 1 }), C('spell_lang', 'Idioma'), C('truncated', 'Truncada', { fmt: yes }),
      C('flesch', 'Legibilidade (Flesch)', { num: 1 }), C('soft_404', 'Soft 404', { fmt: yes }), C('lorem_ipsum', 'Lorem ipsum', { fmt: yes })],
    filters: {
      all: ALL,
      exact: ['Duplicados exatos', (r) => r.content_hash_dup],
      near: ['Quase duplicados', (r) => r.near_dup_count > 0],
      semsim: ['Semanticamente similares', (r) => r.semantic_similar > 0],
      lowrel: ['Baixa relevância', (r) => r.low_relevance],
      low: ['Conteúdo baixo', (r) => r.word_count < PF('low_words')],
      spell: ['Erros de ortografia', (r) => r.spelling_errors > 0],
      grammar: ['Erros de gramática', (r) => r.grammar_errors > 0],
      trunc: ['Truncada', (r) => r.truncated],
      read1: ['Legibilidade difícil', (r) => r.flesch != null && r.flesch >= 30 && r.flesch < 50],
      read2: ['Legibilidade muito difícil', (r) => r.flesch != null && r.flesch < 30],
      soft404: ['Possível soft 404', (r) => r.soft_404],
      lorem: ['Texto lorem ipsum', (r) => r.lorem_ipsum],
    },
  },
  images: {
    label: 'Imagens', rows: () => DATA.pages.filter((p) => category(p) === 'Imagens').concat(DATA.images),
    cols: [URL_COL, C('content_type', 'Tipo de conteúdo'), STATUS, SIZE, C('found_on', 'Usada em (páginas)', { num: 1 }), C('missing_alt', 'Páginas sem alt', { num: 1 }),
      C('missing_alt_attr', 'Páginas sem atributo alt', { num: 1 }), C('alt_long', 'Páginas com alt > 100 caracteres', { num: 1 }),
      C('missing_size', 'Páginas sem width/height', { num: 1 })],
    filters: {
      all: ALL,
      big: [L('Acima de {{0}} KB', 'img_kb'), (r) => r.size > PF('img_kb') * 1024],
      noalt: ['Sem texto alt', (r) => r.missing_alt > 0],
      noattr: ['Sem atributo alt', (r) => r.missing_alt_attr > 0],
      altlong: [L('Texto alt acima de {{0}} caracteres', 'alt_max'), (r) => r.alt_long > 0],
      nosize: ['Sem atributos de tamanho', (r) => r.missing_size > 0],
      broken: ['Quebradas', (r) => r.status >= 400 || noResp(r)],
    },
  },
  canonicals: {
    label: 'Canonicals', rows: htmlPages,
    cols: [URL_COL, IDX, C('indexability_reason', 'Motivo', { tr: 1 }), C('canonical', 'Elemento canonical 1'),
      C('canonical_header', 'Canonical no cabeçalho HTTP'), C('canonical_count', 'Qtd. canonicals', { num: 1 })],
    filters: {
      all: ALL,
      has: ['Contém canonical', (r) => r.canonical],
      self: ['Autorreferente', (r) => r.canonical === r.url],
      canonicalised: ['Canonicalizada', (r) => r.canonical && r.canonical !== r.url],
      missing: ['Ausente', (r) => !r.canonical],
      multiple: ['Múltiplos', (r) => r.canonical_count > 1],
      conflict: ['HTML e cabeçalho HTTP diferentes', (r) => r.canonical_mismatch],
      nonidx: ['Canonical não indexável', (r) => r.canonical_nonindexable],
      relative: ['URL relativa', (r) => r.canonical_relative],
      outside: ['Fora do <head>', (r) => r.canonical_outside_head],
      fragment: ['Contém fragmento (#)', (r) => r.canonical_fragment],
      unlinked: ['Sem link interno', (r) => r.canonical_unlinked],
    },
  },
  pagination: {
    label: 'Paginação', rows: htmlPages,
    cols: [URL_COL, IDX, C('pag_next', 'rel="next" 1'), C('pag_prev', 'rel="prev" 1')],
    filters: {
      all: ALL,
      has: ['Contém paginação', (r) => r.pag_next || r.pag_prev],
      first: ['Primeira página', (r) => r.pag_next && !r.pag_prev],
      last: ['Última página', (r) => r.pag_prev && !r.pag_next],
      non200: ['URL de paginação não-200', (r) => r.pag_non200],
      nonidx: ['URL de paginação não indexável', (r) => r.pag_nonindexable],
      unlinked: ['URL de paginação sem link', (r) => r.pag_unlinked],
      seq: ['Erro de sequência', (r) => r.pag_sequence_error],
      loop: ['Loop de paginação', (r) => r.pag_loop],
      multiple: ['Múltiplos rel next/prev', (r) => r.pag_multiple],
    },
  },
  directives: {
    label: 'Diretivas', rows: () => DATA.pages.filter((p) => p.status > 0),
    cols: [URL_COL, IDX, C('meta_robots', 'Meta Robots 1'), C('x_robots', 'X-Robots-Tag 1'), C('meta_refresh', 'Meta refresh'),
      C('robots_outside_head', 'Fora do <head>', { fmt: yes })],
    filters: {
      all: ALL,
      index: ['Index', (r) => !/noindex/i.test(r.meta_robots + ' ' + r.x_robots)],
      noindex: ['Noindex', (r) => /noindex/i.test(r.meta_robots + ' ' + r.x_robots)],
      follow: ['Follow', (r) => !/nofollow/i.test(r.meta_robots + ' ' + r.x_robots)],
      nofollow: ['Nofollow', (r) => /nofollow/i.test(r.meta_robots + ' ' + r.x_robots)],
      none: ['None', dir(/\bnone\b/)],
      noarchive: ['NoArchive', dir(/noarchive/)],
      nosnippet: ['NoSnippet', dir(/nosnippet/)],
      maxsnippet: ['Max-Snippet', dir(/max-snippet/)],
      maximage: ['Max-Image-Preview', dir(/max-image-preview/)],
      maxvideo: ['Max-Video-Preview', dir(/max-video-preview/)],
      noimageindex: ['NoImageIndex', dir(/noimageindex/)],
      notranslate: ['NoTranslate', dir(/notranslate/)],
      unavailable: ['Unavailable_After', dir(/unavailable_after/)],
      refresh: ['Refresh', (r) => r.meta_refresh],
      outside: ['Fora do <head>', (r) => r.robots_outside_head],
    },
  },
  hreflang: {
    label: 'Hreflang', rows: htmlPages,
    cols: [URL_COL, C('lang', 'html lang'), C('hreflang_count', 'Qtd. hreflang', { num: 1 }), C('hreflang_issues', 'Problemas', { tr: 1 })],
    filters: {
      all: ALL,
      has: ['Contém hreflang', (r) => r.hreflang_count > 0],
      invalid: ['Código de idioma inválido', has('hreflang_issues', 'código inválido')],
      noself: ['Sem autorreferência', has('hreflang_issues', 'sem autorreferência')],
      noreturn: ['Sem link de retorno', has('hreflang_issues', 'sem retorno')],
      non200: ['Destino não-200', has('hreflang_issues', 'destino não-200')],
      unlinked: ['URLs hreflang sem link interno', has('hreflang_issues', 'URL sem link interno')],
      noncanon: ['Destino não canônico', has('hreflang_issues', 'destino não canônico')],
      noindex: ['Destino noindex', has('hreflang_issues', 'destino noindex')],
      multi: ['Entradas múltiplas', has('hreflang_issues', 'entradas múltiplas')],
      xdefault: ['Sem x-default', has('hreflang_issues', 'sem x-default')],
      outside: ['Fora do <head>', (r) => r.hreflang_outside_head],
      missing: ['Ausente', (r) => !r.hreflang_count],
    },
  },
  javascript: {
    label: 'JavaScript', rows: htmlPages, hidden: () => !hasAny(['js_raw_words']) && !DATA.pages.some((p) => p.blocked_resources > 0),
    cols: [URL_COL, C('js_raw_words', 'Palavras no HTML original', { num: 1 }), C('word_count', 'Palavras no HTML renderizado', { num: 1 }),
      C('js_word_diff_pct', '% de palavras vindas do JS', { num: 1 }), C('js_links_only_rendered', 'Links só no renderizado', { num: 1 }),
      C('js_title_changed', 'Title alterado', { fmt: yes }), C('js_meta_changed', 'Meta description alterada', { fmt: yes }),
      C('js_h1_changed', 'H1 alterado', { fmt: yes }), C('js_canonical_changed', 'Canonical alterado', { fmt: yes }),
      C('js_noindex_only_rendered', 'Noindex só no renderizado', { fmt: yes }), C('blocked_resources', 'Recursos bloqueados', { num: 1 }),
      C('js_errors', 'Erros de JavaScript', { num: 1 }), C('js_error_msgs', 'Mensagens de erro')],
    filters: {
      all: ALL,
      dep: ['Conteúdo depende do JS (20%+)', (r) => r.js_word_diff_pct >= 20],
      links: ['Links só no HTML renderizado', (r) => r.js_links_only_rendered > 0],
      title: ['Title alterado por JS', (r) => r.js_title_changed],
      meta: ['Meta description alterada por JS', (r) => r.js_meta_changed],
      h1: ['H1 alterado por JS', (r) => r.js_h1_changed],
      canon: ['Canonical alterado por JS', (r) => r.js_canonical_changed],
      noindex: ['Noindex só no HTML renderizado', (r) => r.js_noindex_only_rendered],
      blocked: ['Páginas com recursos bloqueados', (r) => r.blocked_resources > 0],
      errors: ['Páginas com erros de JavaScript', (r) => r.js_errors > 0],
    },
  },
  links: {
    label: 'Links', rows: htmlPages,
    cols: [URL_COL, C('unique_inlinks', 'Inlinks únicos', { num: 1 }), C('content_inlinks', 'Inlinks no conteúdo', { num: 1 }), C('outlinks', 'Outlinks internos', { num: 1 }),
      C('external_outlinks', 'Outlinks externos', { num: 1 }), C('nofollow_outlinks', 'Outlinks nofollow', { num: 1 }), C('weak_anchors', 'Âncoras não descritivas', { num: 1 }),
      C('broken_outlinks', 'Links quebrados', { num: 1 }), C('unique_anchors', 'Âncoras de entrada distintas', { num: 1 }), C('top_anchors', 'Âncoras de entrada mais usadas'),
      C('noanchor_outlinks', 'Outlinks sem texto âncora', { num: 1 }), C('uncrawlable_outlinks', 'Outlinks internos não rastreáveis', { num: 1 }),
      C('depth', 'Profund.', { num: 1 })],
    filters: {
      all: ALL,
      noout: ['Sem outlinks internos', (r) => r.outlinks === 0],
      noin: ['Sem inlinks internos', (r) => r.unique_inlinks === 0 && r.depth !== 0],
      manyint: [L('Muitos outlinks internos (> {{0}})', 'int_outlinks'), (r) => r.outlinks > PF('int_outlinks')],
      manyext: [L('Muitos outlinks externos (> {{0}})', 'ext_outlinks'), (r) => r.external_outlinks > PF('ext_outlinks')],
      noanchor: ['Outlinks internos sem texto âncora', (r) => r.noanchor_outlinks > 0],
      deep: [L('Profundidade alta (> {{0}} cliques)', 'deep'), (r) => r.depth > PF('deep')],
      mixedin: ['Inlinks internos follow e nofollow', (r) => r.mixed_inlinks],
      nfonly: ['Só inlinks internos nofollow', (r) => r.nofollow_only_inlinks],
      nonidxonly: ['Só inlinks de páginas não indexáveis', (r) => r.nonidx_inlinks_only],
      nofollow: ['Outlinks internos nofollow', (r) => r.nofollow_outlinks > 0],
      weak: ['Âncora não descritiva', (r) => r.weak_anchors > 0],
      broken: ['Contém links quebrados', (r) => r.broken_outlinks > 0],
      uncrawlable: ['Páginas com outlinks internos não rastreáveis', (r) => r.uncrawlable_outlinks > 0],
      nocontent: ['Sem inlinks no conteúdo', (r) => r.unique_inlinks > 0 && r.content_inlinks === 0 && r.depth !== 0],
    },
  },
  structured: {
    label: 'Dados estruturados', rows: htmlPages,
    cols: [URL_COL, C('sd_formats', 'Formatos'), C('sd_types', 'Tipos'), C('sd_errors', 'Erros', { num: 1 }), C('sd_error_msgs', 'Erros de validação'), C('sd_warnings', 'Avisos de validação')],
    filters: {
      all: ALL,
      has: ['Contém dados estruturados', (r) => r.sd_types],
      missing: ['Sem dados estruturados', (r) => !r.sd_types],
      errors: ['Erros de validação', (r) => r.sd_errors > 0],
      warnings: ['Avisos de validação', (r) => r.sd_warnings],
      parse: ['Erros de parse', (r) => r.sd_parse_error],
      jsonld: ['JSON-LD', has('sd_formats', 'JSON-LD')],
      micro: ['Microdata', has('sd_formats', 'Microdata')],
      rdfa: ['RDFa', has('sd_formats', 'RDFa')],
    },
  },
  social: {
    label: 'Social (OG)', rows: htmlPages,
    cols: [URL_COL, C('og_title', 'og:title'), C('og_description', 'og:description'), C('og_image', 'og:image'), C('og_type', 'og:type'), C('twitter_card', 'twitter:card')],
    filters: {
      all: ALL,
      noog: ['Open Graph ausente', (r) => !r.og_title],
      noimg: ['og:image ausente', (r) => !r.og_image],
      notw: ['twitter:card ausente', (r) => !r.twitter_card],
    },
  },
  redirects: {
    label: 'Redirects', rows: () => DATA.pages.filter((p) => p.redirect_url),
    cols: [URL_COL, STATUS, C('redirect_url', 'Redireciona para'), C('redirect_hops', 'Saltos', { num: 1 }), C('redirect_final', 'Destino final'),
      C('redirect_final_status', 'Código final', { num: 1, fmt: statusCell }), C('redirect_loop', 'Loop', { fmt: yes })],
    filters: {
      all: ALL,
      chain: ['Cadeia (2+ saltos)', (r) => r.redirect_hops >= 2],
      loop: ['Loop', (r) => r.redirect_loop],
      error: ['Destino com erro', (r) => r.redirect_final_status >= 400 || r.redirect_final_status === 0],
    },
  },
  sitemaps: {
    label: 'Sitemaps', rows: () => fetched().filter((p) => category(p) === 'HTML'),
    cols: [URL_COL, STATUS, IDX, C('in_sitemap', 'Na sitemap', { fmt: yes }), C('in_ga', 'No GA4', { fmt: yes }), C('in_gsc', 'No Search Console', { fmt: yes }),
      C('found_via', 'Encontrada via', { fmt: viaFmt }), C('unique_inlinks', 'Inlinks únicos', { num: 1 }), C('orphan', 'Órfã', { fmt: yes }),
      C('sitemap_multi', 'Em várias sitemaps', { fmt: yes })],
    filters: {
      all: ALL,
      in: ['URLs na sitemap', (r) => r.in_sitemap],
      notin: ['URLs fora da sitemap', (r) => r.not_in_sitemap],
      orphan: ['URLs órfãs', (r) => r.orphan],
      osm: ['Órfãs da sitemap', (r) => r.orphan && r.found_via === 'sitemap'],
      oga: ['Órfãs do GA4', (r) => r.orphan && r.found_via === 'ga4'],
      ogsc: ['Órfãs do Search Console', (r) => r.orphan && r.found_via === 'gsc'],
      nonidx: ['Não indexáveis na sitemap', (r) => r.in_sitemap && r.indexability === 'Non-Indexable'],
      multi: ['URLs em várias sitemaps', (r) => r.sitemap_multi],
    },
    actions: () => {
      const n = Object.keys(DATA.api_urls || {}).filter((u) => !PAGE.has(u)).length;
      return n ? `<button class="tbtn" data-crawl-more>${tf('Rastrear {{0}} URLs do GA4/Search Console', n)}</button>` : '';
    },
  },
  analytics: {
    label: 'Analytics', rows: htmlPages, hidden: () => !apiOn('ga4') && !hasAny(['ga_sessions']),
    cols: [URL_COL, C('ga_sessions', 'Sessões', { num: 1 }), C('ga_users', 'Usuários', { num: 1 }), C('ga_views', 'Visualizações de página', { num: 1 }),
      C('ga_engagement_rate', 'Taxa de engajamento', { num: 1, fmt: pctFmt }), C('ga_bounce_rate', 'Taxa de rejeição', { num: 1, fmt: pctFmt }),
      C('ga_avg_session_duration', 'Duração média da sessão (s)', { num: 1 }), C('ga_key_events', 'Eventos-chave', { num: 1 })],
    filters: {
      all: ALL,
      with: ['Sessões acima de 0', (r) => r.ga_sessions > 0],
      none: ['Sem dados do GA', (r) => r.ga_sessions === 0],
      bounce: ['Taxa de rejeição acima de 70%', (r) => r.ga_bounce_rate > 0.7],
      nonidx: ['Não indexável com sessões', (r) => r.ga_sessions > 0 && r.indexability === 'Non-Indexable'],
      orphan: ['URLs órfãs (GA4)', (r) => r.orphan && r.found_via === 'ga4'],
    },
  },
  gsc: {
    label: 'Search Console', rows: htmlPages, hidden: () => !apiOn('gsc') && !hasAny(['gsc_clicks']),
    cols: [URL_COL, C('gsc_clicks', 'Cliques', { num: 1 }), C('gsc_impressions', 'Impressões', { num: 1 }),
      C('gsc_ctr', 'CTR', { num: 1, fmt: pctFmt }), C('gsc_position', 'Posição média', { num: 1 }), IDX],
    filters: {
      all: ALL,
      clicks: ['Com cliques', (r) => r.gsc_clicks > 0],
      noclicks: ['Sem cliques', (r) => r.gsc_clicks === 0],
      noimpr: ['Sem impressões', (r) => r.gsc_impressions === 0],
      top3: ['Posição 1–3', (r) => r.gsc_position != null && r.gsc_position <= 3],
      top10: ['Posição 4–10', (r) => r.gsc_position > 3 && r.gsc_position <= 10],
      rest: ['Posição 11+', (r) => r.gsc_position > 10],
      nonidx: ['Não indexável com impressões', (r) => r.gsc_impressions > 0 && r.indexability === 'Non-Indexable'],
      orphan: ['URLs órfãs (Search Console)', (r) => r.orphan && r.found_via === 'gsc'],
    },
  },
  validation: {
    label: 'Validação', rows: htmlPages,
    cols: [URL_COL, IDX, C('val_invalid_head', 'Elementos inválidos no <head>'), C('val_missing_head', '<head> ausente', { fmt: yes }),
      C('val_multiple_head', 'Múltiplos <head>', { fmt: yes }), C('val_missing_body', '<body> ausente', { fmt: yes }),
      C('val_multiple_body', 'Múltiplos <body>', { fmt: yes }), C('val_body_before_html', '<body> antes de <html>', { fmt: yes }),
      C('val_head_not_first', '<head> não é o primeiro', { fmt: yes }), SIZE],
    filters: {
      all: ALL,
      invalid: ['Elementos inválidos no <head>', (r) => r.val_invalid_head],
      bodyfirst: ['<body> antes de <html>', (r) => r.val_body_before_html],
      headfirst: ['<head> não é o primeiro em <html>', (r) => r.val_head_not_first],
      nohead: ['<head> ausente', (r) => r.val_missing_head],
      multihead: ['Múltiplos <head>', (r) => r.val_multiple_head],
      nobody: ['<body> ausente', (r) => r.val_missing_body],
      multibody: ['Múltiplos <body>', (r) => r.val_multiple_body],
      big: ['Documento HTML acima de 2 MB', (r) => r.val_over_2mb],
    },
  },
  linkmetrics: {
    label: 'Métricas de links', rows: htmlPages,
    hidden: () => !['majestic', 'ahrefs', 'moz'].some(apiOn) && !hasAny(['mj_trust_flow', 'ah_backlinks', 'moz_pa']),
    cols: [URL_COL, C('mj_trust_flow', 'Majestic Trust Flow', { num: 1 }), C('mj_citation_flow', 'Majestic Citation Flow', { num: 1 }),
      C('mj_ext_backlinks', 'Majestic backlinks externos', { num: 1 }), C('mj_ref_domains', 'Majestic domínios de referência', { num: 1 }),
      C('ah_backlinks', 'Ahrefs backlinks', { num: 1 }), C('ah_refdomains', 'Ahrefs domínios de referência', { num: 1 }),
      C('ah_org_traffic', 'Ahrefs tráfego orgânico', { num: 1 }), C('ah_org_keywords', 'Ahrefs palavras-chave orgânicas', { num: 1 }),
      C('moz_pa', 'Moz Page Authority', { num: 1 }), C('moz_da', 'Moz Domain Authority', { num: 1 }), C('moz_spam_score', 'Moz Spam Score', { num: 1 }),
      C('moz_ext_pages', 'Moz páginas externas com link', { num: 1 }), C('moz_root_domains', 'Moz domínios raiz com link', { num: 1 })],
    filters: {
      all: ALL,
      with: ['Com backlinks', (r) => r.mj_ext_backlinks > 0 || r.ah_backlinks > 0 || r.moz_ext_pages > 0],
      without: ['Sem backlinks', (r) => [r.mj_ext_backlinks, r.ah_backlinks, r.moz_ext_pages].some((v) => v === 0) && !(r.mj_ext_backlinks > 0 || r.ah_backlinks > 0 || r.moz_ext_pages > 0)],
    },
  },
  ai: {
    label: 'IA', rows: htmlPages, hidden: () => !aiCols().length,
    cols: () => [URL_COL, C('title', 'Title 1'), ...aiCols()],
    get filters() {
      const cols = aiCols();
      const val = (r, k) => r[k] && !String(r[k]).startsWith('[erro]');
      const f = {
        all: ALL,
        with: ['Com resposta da IA', (r) => cols.some((c) => val(r, c.key))],
        without: ['Sem resposta da IA', (r) => !cols.some((c) => val(r, c.key))],
        errors: ['Com erros', (r) => cols.some((c) => String(r[c.key] || '').startsWith('[erro]'))],
      };
      cols.forEach((c) => { f[c.key] = [c.label, (r) => val(r, c.key)]; });
      return f;
    },
  },
  pagespeed: {
    label: 'PageSpeed', rows: () => htmlPages().filter((p) => p.indexability === 'Indexable'),
    cols: [URL_COL, C('psi_score', 'Performance', { num: 1, fmt: scoreCell }), C('psi_lcp', 'LCP (s)', { num: 1 }), C('psi_fcp', 'FCP (s)', { num: 1 }),
      C('psi_cls', 'CLS', { num: 1 }), C('psi_tbt', 'TBT (ms)', { num: 1 }), C('psi_si', 'Speed Index (s)', { num: 1 }),
      C('psi_field_lcp', 'LCP real (ms)', { num: 1 }), C('psi_field_inp', 'INP real (ms)', { num: 1 }), C('psi_field_cls', 'CLS real', { num: 1 }),
      C('psi_cwv', 'Core Web Vitals', { tr: 1 }), C('psi_field_source', 'Dados de campo de', { tr: 1 }), C('psi_strategy', 'Dispositivo'), C('psi_savings_ms', 'Economia possível (ms)', { num: 1 }),
      C('psi_opps', 'Oportunidades'), C('psi_error', 'Erro')],
    filters: {
      all: ALL,
      done: ['Analisadas', (r) => r.psi_score != null],
      cwvok: ['Core Web Vitals aprovado', (r) => r.psi_cwv === 'Aprovado'],
      cwvfail: ['Core Web Vitals reprovado', (r) => r.psi_cwv === 'Reprovado'],
      cwvnone: ['Sem dados de campo', (r) => r.psi_cwv === 'Sem dados de campo'],
      good: ['Boa (90+)', (r) => r.psi_score >= 90],
      avg: ['Precisa melhorar (50-89)', (r) => r.psi_score != null && r.psi_score >= 50 && r.psi_score < 90],
      poor: ['Ruim (< 50)', (r) => r.psi_score != null && r.psi_score < 50],
      err: ['Com erro', (r) => r.psi_error],
      o1: ['Eliminar recursos que bloqueiam a renderização', opp('render-blocking-resources')],
      o2: ['Dimensionar imagens corretamente', opp('uses-responsive-images')],
      o3: ['Adiar imagens fora da tela', opp('offscreen-images')],
      o4: ['Minificar CSS', opp('unminified-css')],
      o5: ['Minificar JavaScript', opp('unminified-javascript')],
      o6: ['Reduzir CSS não usado', opp('unused-css-rules')],
      o7: ['Reduzir JavaScript não usado', opp('unused-javascript')],
      o8: ['Codificar imagens de forma eficiente', opp('uses-optimized-images')],
      o9: ['Imagens em formatos modernos', opp('modern-image-formats')],
      o10: ['Ativar compressão de texto', opp('uses-text-compression')],
      o11: ['Pré-conectar a origens necessárias', opp('uses-rel-preconnect')],
      o12: ['Reduzir o tempo de resposta do servidor', opp('server-response-time')],
      o13: ['Evitar vários redirecionamentos de página', opp('redirects')],
      o14: ['Pré-carregar a imagem do LCP', opp('prioritize-lcp-image')],
      o15: ['Usar formatos de vídeo para animações', opp('efficient-animated-content')],
      o16: ['Remover módulos duplicados no JavaScript', opp('duplicated-javascript')],
      o17: ['Evitar JavaScript legado', opp('legacy-javascript')],
    },
    actions: () => `<button class="tbtn" data-psi-all="mobile">▶ Analisar todas (mobile)</button>
      <button class="tbtn" data-psi-all="desktop">▶ Desktop</button>
      <button class="tbtn" data-psi-stop>■ Parar</button>`,
  },
  customjs: {
    label: 'JavaScript personalizado', hidden: () => !(DATA.custom_js || []).length,
    rows: () => DATA.pages.filter((p) => (DATA.custom_js || []).some((_, i) => p['js' + (i + 1)] != null)),
    cols: () => [URL_COL, C('content_type', 'Tipo de conteúdo'), ...(DATA.custom_js || []).map((n, i) => C('js' + (i + 1), n))],
    get filters() {
      const f = { all: ALL, errors: ['Com erros', (r) => (DATA.custom_js || []).some((_, i) => String(r['js' + (i + 1)] || '').startsWith('[erro]'))] };
      (DATA.custom_js || []).forEach((n, i) => { f['js' + (i + 1)] = [n, (r) => r['js' + (i + 1)] && !String(r['js' + (i + 1)]).startsWith('[erro]')]; });
      return f;
    },
  },
  customsearch: {
    label: 'Pesquisa personalizada', rows: htmlPages, hidden: () => !(DATA.custom_search || []).length,
    cols: () => [URL_COL, STATUS, ...(DATA.custom_search || []).map((s, i) => C('cs' + (i + 1), tf(s.mode === 'not_contains' ? 'Não contém: {{0}}' : 'Contém: {{0}}', s.name), { num: 1 }))],
    get filters() {
      const f = { all: ALL };
      (DATA.custom_search || []).forEach((s, i) => {
        const k = 'cs' + (i + 1);
        f[k] = [s.name, s.mode === 'not_contains' ? (r) => r[k] === 0 : (r) => r[k] > 0];
      });
      return f;
    },
  },
  cookies: {
    label: 'Cookies', rows: () => DATA.cookies || [], hidden: () => !(DATA.cookies || []).length,
    cols: [C('name', 'Nome do cookie'), C('domain', 'Domínio'), C('path', 'Caminho'), C('expires', 'Expira', { tr: 1 }),
      C('secure', 'Secure', { fmt: yes }), C('httponly', 'HttpOnly', { fmt: yes }), C('samesite', 'SameSite'),
      C('source', 'Origem', { tr: 1 }), C('third_party', 'Terceiros', { fmt: yes }), C('pages', 'Páginas', { num: 1 }), C('url', 'Primeira URL')],
    filters: {
      all: ALL,
      session: ['Cookies de sessão', (r) => r.expires === 'Sessão'],
      persistent: ['Cookies persistentes', (r) => r.expires !== 'Sessão'],
      first: ['Próprios', (r) => !r.third_party],
      third: ['De terceiros', (r) => r.third_party],
      js: ['Definidos por JavaScript', (r) => r.source !== 'HTTP'],
      nosecure: ['Sem Secure', (r) => !r.secure],
      nohttponly: ['Sem HttpOnly', (r) => !r.httponly],
      nosamesite: ['Sem SameSite', (r) => !r.samesite],
    },
  },
  amp: {
    label: 'AMP', rows: () => htmlPages().filter((p) => p.is_amp || p.amp_url), hidden: () => !DATA.pages.some((p) => p.is_amp || p.amp_url),
    cols: [URL_COL, IDX, C('is_amp', 'Página AMP', { fmt: yes }), C('amp_url', 'Link amphtml'), C('canonical', 'Canonical'), C('amp_errors', 'Erros de validação')],
    filters: {
      all: ALL,
      amp: ['Páginas AMP', (r) => r.is_amp],
      nonamp: ['Páginas com versão AMP', (r) => r.amp_url],
      non200: ['URL AMP não-200', (r) => r.amp_non200],
      noreturn: ['Canônica sem link amphtml de volta', (r) => r.amp_no_return],
      nocanon: ['AMP sem canonical', (r) => r.is_amp && !r.canonical],
      errors: ['Com erros de validação', (r) => r.amp_errors],
    },
  },
  mobile: {
    label: 'Mobile', rows: htmlPages,
    cols: [URL_COL, IDX, C('viewport', 'Meta viewport'), C('mob_zoom_disabled', 'Zoom desativado', { fmt: yes }),
      C('mob_plugins', 'Plugins', { num: 1 }), C('mob_alternate', 'Alternate mobile'), C('psi_cwv', 'Core Web Vitals', { tr: 1 })],
    filters: {
      all: ALL,
      noviewport: ['Viewport ausente', (r) => !r.viewport],
      nodevice: ['Viewport sem width=device-width', (r) => r.mob_no_device_width],
      zoom: ['Zoom desativado', (r) => r.mob_zoom_disabled],
      plugins: ['Plugins não suportados', (r) => r.mob_plugins > 0],
      alternate: ['Com alternate mobile', (r) => r.mob_alternate],
    },
  },
  accessibility: {
    label: 'Acessibilidade', rows: htmlPages, hidden: () => !hasAny(['a11y_rules', 'a11y_error']),
    cols: [URL_COL, IDX, C('a11y_rules', 'Regras violadas', { num: 1 }), C('a11y_nodes', 'Elementos', { num: 1 }),
      C('a11y_critical', 'Críticas', { num: 1 }), C('a11y_serious', 'Graves', { num: 1 }), C('a11y_moderate', 'Moderadas', { num: 1 }),
      C('a11y_minor', 'Menores', { num: 1 }), C('a11y_level', 'Nível WCAG'), C('a11y_error', 'Erro')],
    get filters() {
      const f = {
        all: ALL,
        any: ['Com violações', (r) => r.a11y_rules > 0],
        none: ['Sem violações', (r) => r.a11y_rules === 0],
        critical: ['Críticas', (r) => r.a11y_critical > 0],
        serious: ['Graves', (r) => r.a11y_serious > 0],
        moderate: ['Moderadas', (r) => r.a11y_moderate > 0],
        minor: ['Menores', (r) => r.a11y_minor > 0],
        lvla: ['WCAG A', (r) => (r.a11y_level || '').split(', ').includes('A')],
        lvlaa: ['WCAG AA', (r) => (r.a11y_level || '').split(', ').includes('AA')],
        bp: ['Boas práticas', (r) => (r.a11y_level || '').includes('Boas práticas')],
      };
      (DATA.a11y_rules || []).forEach((a) => { f['r_' + a.id] = [`${a.help} (${a.id})`, (r) => (r.a11y_ids || '').split(' ').includes(a.id)]; });
      return f;
    },
  },
  changes: {
    label: 'Detecção de mudanças', hidden: () => !MAIN_CMP, rows: () => chgRows(),
    cols: () => [URL_COL, STATUS, IDX, C('chg_fields', 'Campos alterados'),
      ...(MAIN_CMP && MAIN_CMP.changes.some((c) => c.field === S.filter) ? [C('chg_before', 'Antes'), C('chg_after', 'Depois')] : [])],
    get filters() {
      const f = { all: ALL };
      (MAIN_CMP?.changes || []).forEach((c) => { f[c.field] = [c.label, (r) => r.chg[c.field]]; });
      f.newurls = ['URLs novas', (r) => r.is_new];
      f.missingurls = ['URLs ausentes', (r) => r.is_missing];
      return f;
    },
  },
  extraction: {
    label: 'Extração personalizada', rows: htmlPages, hidden: () => !DATA.extractors.length,
    cols: () => [URL_COL, ...DATA.extractors.map((n, i) => C('ex' + (i + 1), n))],
    filters: {
      all: ALL,
      found: ['Com valor', (r) => DATA.extractors.some((_, i) => r['ex' + (i + 1)])],
      empty: ['Sem valor', (r) => !DATA.extractors.some((_, i) => r['ex' + (i + 1)])],
    },
  },
};
// ---------- change detection in the main window (SF Compare mode) ----------
let MAIN_CMP = null;
let PREV = null;   // previous crawl's data, to evaluate any tab filter against it
function buildPrev(d) {
  const data = { ...EMPTY(), ...d };
  const keys = new Set(data.pages.concat(data.external, data.images, data.cookies || []).map(rowKey));
  return { DATA: data, PAGE: new Map(data.pages.map((p) => [p.url, p])), keys, cache: new Map() };
}
function prevRows(tab, filterKey) {
  if (!PREV) return [];
  const ck = tab + '|' + filterKey;
  if (PREV.cache.has(ck)) return PREV.cache.get(ck);
  const rows = prevRowsRaw(tab, filterKey);
  PREV.cache.set(ck, rows);
  return rows;
}
function prevRowsRaw(tab, filterKey) {
  const saved = [DATA, PAGE];
  [DATA, PAGE] = [PREV.DATA, PREV.PAGE];
  try {
    const t = TABS[tab];
    return t.rows().filter((t.filters[filterKey] || t.filters.all)[1]);
  } catch { return []; } finally { [DATA, PAGE] = saved; }
}
function cmpRows(tab, cur, k) {
  const curSet = new Set(cur.map(rowKey));
  const prev = prevRows(S.tab, S.filter);
  const prevSet = new Set(prev.map(rowKey));
  const curAll = new Set(DATA.pages.concat(DATA.external, DATA.images, DATA.cookies || []).map(rowKey));
  if (k === 'added') return cur.filter((r) => !prevSet.has(rowKey(r)) && PREV.keys.has(rowKey(r)));
  if (k === 'new') return cur.filter((r) => !PREV.keys.has(rowKey(r)));
  if (k === 'missing') return prev.filter((r) => !curAll.has(rowKey(r))).map((r) => ({ ...r, status_text: t('Ausente no crawl atual') }));
  // removed: in the previous filter, still crawled, but no longer in this filter
  const pool = new Map(tab.rows().concat(DATA.pages, DATA.external, DATA.images).map((r) => [rowKey(r), r]));
  return [...prevSet].filter((key) => !curSet.has(key) && curAll.has(key)).map((key) => pool.get(key)).filter(Boolean);
}
function cmpCounts() {
  if (!PREV || S.custom || S.tab === 'changes') return '';
  const t = TABS[S.tab];
  const cur = t.rows().filter((t.filters[S.filter] || t.filters.all)[1]).length;
  const prev = prevRows(S.tab, S.filter).length;
  const d = cur - prev;
  return '   ' + tf('Anterior: {{0}}   Mudança: {{1}}', prev, (d > 0 ? '+' : '') + d);
}
const chgFmt = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');
function chgRows() {
  if (!MAIN_CMP) return [];
  const labels = Object.fromEntries(MAIN_CMP.changes.map((c) => [c.field, c.label]));
  const map = new Map();
  for (const c of MAIN_CMP.changes) {
    for (const r of c.rows) {
      const p = PAGE.get(r.url);
      if (!p) continue;
      if (!map.has(r.url)) map.set(r.url, { ...p, chg: {} });
      map.get(r.url).chg[c.field] = r;
    }
  }
  const fresh = new Set(MAIN_CMP.new_urls);
  for (const u of fresh) if (PAGE.has(u) && !map.has(u)) map.set(u, { ...PAGE.get(u), chg: {} });
  const rows = [...map.values()].map((o) => {
    const cur = o.chg[S.filter];
    return { ...o, is_new: fresh.has(o.url), chg_fields: Object.keys(o.chg).map((k) => t(labels[k])).join(', ') || (fresh.has(o.url) ? t('URL nova') : ''),
      chg_before: cur ? chgFmt(cur.before) : '', chg_after: cur ? chgFmt(cur.after) : '' };
  });
  return rows.concat(MAIN_CMP.missing_urls.map((u) => ({ url: u, status: null, indexability: '', chg: {}, is_missing: true, chg_fields: t('Ausente no crawl atual') })));
}
function syncCmpUi() {
  $('#cmpBar').hidden = !MAIN_CMP;
  if (!MAIN_CMP) $('#chgSel').value = 'all';
}
$('#chgSel').addEventListener('change', () => {
  if (S.custom && DATA.issues.some((i) => i.name === S.custom.label)) applyIssue(S.custom.label);
  else renderTable();
});
$('#cmpExit').addEventListener('click', () => {
  MAIN_CMP = null;
  PREV = null;
  syncCmpUi();
  if (S.tab === 'changes') setView('internal', 'all');
  else renderAll();
});
// ---------- crawl analysis (Configuration > Crawl Analysis) ----------
const ANALYSIS_FILTERS = {
  'redirects.chain': 'response_codes', 'redirects.loop': 'response_codes', 'redirects.error': 'response_codes',
  'content.near': 'content', 'content.semsim': 'content', 'content.lowrel': 'content',
  'canonicals.nonidx': 'canonicals', 'canonicals.unlinked': 'canonicals',
  'pagination.non200': 'pagination', 'pagination.nonidx': 'pagination', 'pagination.unlinked': 'pagination',
  'pagination.seq': 'pagination', 'pagination.loop': 'pagination',
  'hreflang.noreturn': 'hreflang', 'hreflang.non200': 'hreflang', 'hreflang.unlinked': 'hreflang',
  'hreflang.noncanon': 'hreflang', 'hreflang.noindex': 'hreflang',
  'links.mixedin': 'links', 'links.nfonly': 'links', 'links.nonidxonly': 'links',
  'sitemaps.notin': 'sitemaps', 'sitemaps.orphan': 'sitemaps', 'sitemaps.osm': 'sitemaps', 'sitemaps.oga': 'analytics',
  'sitemaps.ogsc': 'search_console', 'sitemaps.multi': 'sitemaps',
  'analytics.orphan': 'analytics', 'gsc.orphan': 'search_console',
};
const needsAnalysis = (tab, fk) => {
  const g = ANALYSIS_FILTERS[tab + '.' + fk];
  return g && !(DATA.analysed || []).includes(g) ? g : null;
};
const REQ_LABEL = () => t('(Análise de crawl necessária)');
const VIA = { link: 'Link interno', sitemap: 'Sitemap', ga4: 'GA4', gsc: 'Search Console', list: 'Modo Lista' };
function viaFmt(v) { return esc(t(VIA[v] || v || '')); }
function aiCols() {
  const out = [];
  for (const p of APIS) {
    if (!p.ai) continue;
    (Array.isArray(p.values?.prompts) ? p.values.prompts : []).forEach((pr, i) => out.push(C(`ai_${p.id}_${i + 1}`, `${p.name}: ${pr.name || 'Prompt ' + (i + 1)}`)));
  }
  return out;
}
const colsOf = (t) => (typeof t.cols === 'function' ? t.cols() : t.cols);
const visibleCols = () => { const hid = new Set(S.hidden[S.tab] || []); return colsOf(TABS[S.tab]).filter((c) => !hid.has(c.key)); };
const visibleTabs = () => Object.entries(TABS).filter(([, t]) => !(t.hidden && t.hidden()));
const BAD = /ausente|duplic|quebr|erro|sem |acima|abaixo|múltiplos|noindex|inválid|loop|cadeia|órfã|fora|misto|http$|truncad|ruim|maiúsc|underscore|não-|barras|nofollow|baixo|muitos/i;

// ---------- search ----------
const SOPTS = { qCase: false, qRegex: false, qCol: 'all' };   // plain search box; rules live in the Advanced Table Search
function matcher(q) {
  if (SOPTS.qRegex) {
    try { const re = new RegExp(q, SOPTS.qCase ? '' : 'i'); return (s) => re.test(s); } catch { return null; }
  }
  if (SOPTS.qCase) return (s) => s.includes(q);
  const lq = q.toLowerCase();
  return (s) => s.toLowerCase().includes(lq);
}
function syncSearchOpts() {
  $$('.sopts').forEach((b) => {
    const main = !b.closest('.bottom');
    const adv = !!window.ADV?.active(main);
    const q = (main ? $('#search') : $('#detailSearch'))?.value.trim();
    b.classList.toggle('on', adv);
    b.title = t(adv ? 'Executando busca avançada' : q ? 'Executando busca simples em todas as colunas' : 'Nenhum termo de busca informado');
  });
}

// ---------- rows ----------
const cmp = (a, b) => (a == null) - (b == null) || (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));

function currentRows() {
  const t = TABS[S.tab];
  let rows;
  if (S.custom) rows = S.custom.rows().filter(S.custom.test);
  else rows = t.rows().filter((t.filters[S.filter] || t.filters.all)[1]);
  if (!S.custom && PREV && S.tab !== 'changes' && $('#chgSel').value !== 'all') rows = cmpRows(t, rows, $('#chgSel').value);
  if (S.q) {
    const all = colsOf(t);
    const cols = all.some((c) => c.key === SOPTS.qCol) ? all.filter((c) => c.key === SOPTS.qCol) : all;
    const m = matcher(S.q);
    rows = m ? rows.filter((r) => cols.some((c) => m(String(r[c.key] ?? '')))) : [];
  }
  if (window.ADV) rows = ADV.rows(rows);   // Advanced Table Search
  if (S.sort) rows = [...rows].sort((a, b) => cmp(a[S.sort], b[S.sort]) * S.dir);
  return rows;
}
let ROWS = [];

function setView(tab, filter = 'all', custom = null) {
  Object.assign(S, { tab, filter, custom, sort: null, sel: null, multi: new Set(), anchor: null });
  renderAll();
}

// ---------- main tabs / toolbar / grid ----------
function renderTabs() {
  if (TABS[S.tab].hidden?.()) S.tab = 'internal';
  $('#tabs').innerHTML = visibleTabs().map(([k, t]) => `<button data-tab="${k}" class="${k === S.tab ? 'active' : ''}">${t.label}</button>`).join('');
  $('#tabs .active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const t = TABS[S.tab];
  $('#filter').innerHTML = (S.custom ? `<option value="__custom" selected>${esc(S.custom.label)}</option>` : '') +
    Object.entries(t.filters).map(([k, [label]]) => `<option value="${k}" ${!S.custom && k === S.filter ? 'selected' : ''}>${esc(label)}</option>`).join('');
  $('#tabActions').innerHTML = t.actions ? t.actions() : '';
}

function rowHtml(r, i, cols) {
  const k = rowKey(r);
  const cls = k === S.sel ? 'cur' : S.multi.has(k) ? 'sel' : '';
  return `<tr data-key="${esc(k)}" data-i="${i}" class="${cls}"><td class="idx">${i + 1}</td>` +
    cols.map((c) => { const v = r[c.key]; return `<td class="${c.num ? 'num' : ''}" title="${esc(v)}">${c.fmt ? c.fmt(v, r) : esc(c.tr ? tv(v) : v)}</td>`; }).join('') + '<td></td></tr>';
}

function renderTable() {
  ROWS = currentRows();
  const cols = visibleCols();
  $('#treeView').hidden = true;
  $$('.viewtoggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  $('#grid').classList.toggle('treemode', S.view === 'tree');
  if (S.view === 'tree') renderTreeGrid(cols.filter((c) => c.key !== 'url' || true));
  else {
    $('#grid thead').innerHTML = '<tr><th class="idx">Linha</th>' + cols.map((c) =>
      `<th data-sort="${c.key}" class="${c.num ? 'num' : ''}">${esc(c.label)}${S.sort === c.key ? ` <span class="arrow">${S.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('') +
      '<th class="addcol" data-addcol title="Escolher colunas">+</th></tr>';
    $('#grid tbody').innerHTML = ROWS.length ? ROWS.slice(0, MAX_ROWS).map((r, i) => rowHtml(r, i, cols)).join('')
      : `<tr><td colspan="${cols.length + 2}" class="empty">${!S.custom && needsAnalysis(S.tab, S.filter)
        ? t('Você precisa executar a análise de crawl para preencher este filtro (Análise de crawl > Iniciar análise).') : t('Nenhum resultado.')}</td></tr>`;
  }
  renderGridStatus();
}

function renderGridStatus() {
  const extra = ROWS.length > MAX_ROWS ? '  ' + tf('(mostrando {{0}} — use busca/filtro ou exporte)', MAX_ROWS) : '';
  $('#gridStatus').textContent = tf('Células selecionadas: {{0}}   Total do filtro: {{1}}', S.multi.size * visibleCols().length, ROWS.length) + cmpCounts() + extra;
}

function paintSelection() {
  $$('#grid tbody tr[data-key]').forEach((tr) => {
    const k = tr.dataset.key;
    tr.classList.toggle('cur', k === S.sel);
    tr.classList.toggle('sel', k !== S.sel && S.multi.has(k));
  });
  renderGridStatus();
}

function selectRow(key, e = {}) {
  const idx = ROWS.findIndex((r) => (rowKey(r)) === key);
  if (e.shiftKey && S.anchor != null) {
    const a = ROWS.findIndex((r) => (rowKey(r)) === S.anchor);
    const [lo, hi] = [Math.min(a, idx), Math.max(a, idx)];
    S.multi = new Set(ROWS.slice(lo, hi + 1).map((r) => rowKey(r)));
  } else if (e.ctrlKey || e.metaKey) {
    S.multi.has(key) ? S.multi.delete(key) : S.multi.add(key);
    S.anchor = key;
  } else {
    S.multi = new Set([key]);
    S.anchor = key;
  }
  S.sel = key;
  paintSelection();
  renderDetail();
}

// ---------- URL path tree (main tree view + Site Structure) ----------
const ICON_FOLDER = '<svg class="fi" viewBox="0 0 16 13"><path d="M0 1.6C0 1 .4.6 1 .6h4.6l1.6 1.8H15c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H1c-.6 0-1-.4-1-1z" fill="#3f8fd8"/></svg>';
const ICON_PAGE = '<svg class="fi" viewBox="0 0 12 14"><path d="M1 .5h6.6L11 3.9v9.6H1z" fill="#fff" stroke="#3f8fd8"/><path d="M3 6.5h6M3 8.8h6M3 11h4" stroke="#3f8fd8" stroke-width=".9"/></svg>';
const STATUS_CLASSES = [
  ['blocked', 'Bloqueado pelo robots.txt', '#8c8c8c', blocked], ['noresp', 'Sem resposta', '#f28b8b', noResp],
  ['s2', '2xx', '#76b82a', range(200, 299)], ['s3', '3xx', '#f5b52e', range(300, 399)],
  ['s4', '4xx', '#d9363e', range(400, 499)], ['s5', '5xx', '#7a0f12', range(500, 599)],
];

function buildTree(rows) {
  const root = { key: '', prefix: '', name: '', children: new Map(), rec: null, n: 0, idx: 0, nonidx: 0, codes: {}, depth: -1 };
  const child = (node, name, prefix) => {
    if (!node.children.has(name)) node.children.set(name, { key: prefix, prefix, name, children: new Map(), rec: null, n: 0, idx: 0, nonidx: 0, codes: {}, depth: node.depth + 1 });
    return node.children.get(name);
  };
  for (const r of rows) {
    let u;
    try { u = new URL(r.url); } catch { continue; }
    const parts = u.pathname.split('/').slice(1);
    const leaf = parts.pop() + u.search;
    let node = child(root, u.protocol.replace(':', '') + '/', u.protocol + '//');
    const nodes = [root, node];
    node = child(node, u.host + '/', `${u.protocol}//${u.host}/`);
    nodes.push(node);
    for (const seg of parts) { node = child(node, seg + '/', node.prefix + seg + '/'); nodes.push(node); }
    if (leaf) { node = child(node, leaf, node.prefix + leaf); nodes.push(node); }
    node.rec = r;
    const cls = STATUS_CLASSES.find(([, , , f]) => f(r))?.[0];
    for (const x of nodes) {
      x.n++;
      if (r.indexability === 'Indexable') x.idx++; else if (r.indexability === 'Non-Indexable') x.nonidx++;
      if (cls) x.codes[cls] = (x.codes[cls] || 0) + 1;
    }
  }
  return root;
}
const treeKids = (node) => [...node.children.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
function flattenTree(root, isOpen) {
  const out = [];
  const walk = (node) => { for (const ch of treeKids(node)) { out.push(ch); if (ch.children.size && isOpen(ch)) walk(ch); } };
  walk(root);
  return out;
}
function treeMaxDepth(node) { let m = node.depth; for (const c of node.children.values()) m = Math.max(m, treeMaxDepth(c)); return m; }
const pathCell = (node, open, toggleAttr) => {
  const tg = node.children.size ? `<span class="tg" ${toggleAttr}="${esc(node.key)}">${open ? '▼' : '▶'}</span>` : '<span class="tg"></span>';
  return `<td class="path" style="padding-left:${4 + node.depth * 16}px">${tg}${node.children.size || node.name.endsWith('/') ? ICON_FOLDER : ICON_PAGE}${esc(node.name)}</td>`;
};

// main grid tree view
const mainTreeOpen = (node) => S.treeState[node.key] ?? node.depth < 3;
function renderTreeGrid(cols) {
  const nodes = flattenTree(buildTree(ROWS), mainTreeOpen);
  $('#grid thead').innerHTML = '<tr><th>Caminho</th><th class="num">URLs</th>' + cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('') +
    '<th class="addcol" data-addcol title="Escolher colunas">+</th></tr>';
  $('#grid tbody').innerHTML = nodes.length ? nodes.slice(0, MAX_ROWS).map((node, i) => {
    const r = node.rec;
    const k = r ? r.url : '';
    const cls = r && k === S.sel ? 'cur' : r && S.multi.has(k) ? 'sel' : '';
    return `<tr ${r ? `data-key="${esc(k)}"` : ''} data-i="${i}" class="${cls}">${pathCell(node, mainTreeOpen(node), 'data-tnode')}<td class="num">${node.n}</td>` +
      cols.map((c) => { const v = r ? r[c.key] : ''; return `<td class="${c.num ? 'num' : ''}" title="${esc(v)}">${r ? (c.fmt ? c.fmt(v, r) : esc(c.tr ? tv(v) : v)) : ''}</td>`; }).join('') + '<td></td></tr>';
  }).join('') : `<tr><td colspan="${cols.length + 3}" class="empty">${t('Nenhum resultado.')}</td></tr>`;
}

// site structure (right panel)
const stOpen = (node) => S.stState[node.key] ?? node.depth < S.stLevel;
function niceMax(v) {
  if (v <= 10) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => v / s <= 10);
  return Math.ceil(v / step) * step;
}
function depthData() {
  const labels = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'];
  const of = (p) => (p.depth >= 10 ? '10+' : String(p.depth));
  return labels.map((l) => [l, STATUS_CLASSES.map(([, , , f]) => DATA.pages.filter((p) => p.depth != null && of(p) === l && f(p)).length)]);
}
function depthChart() {
  const data = depthData();
  const W = 640, H = 300, L = 44, R = 10, T = 12, B = 30;
  const pw = W - L - R, ph = H - T - B;
  const max = niceMax(Math.max(1, ...data.flatMap(([, v]) => v)));
  const step = max / 10;
  let g = '';
  for (let i = 0; i <= 10; i++) {
    const y = T + ph - (ph * i) / 10;
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 3.5}" text-anchor="end">${+(step * i).toFixed(1)}</text>`;
  }
  const gw = pw / data.length;
  const bw = (gw * 0.8) / STATUS_CLASSES.length;
  data.forEach(([label, vals], i) => {
    const x0 = L + i * gw + gw * 0.1;
    vals.forEach((v, j) => {
      if (!v) return;
      const h = (ph * v) / max;
      g += `<rect x="${x0 + j * bw}" y="${T + ph - h}" width="${bw - 0.6}" height="${h}" fill="${STATUS_CLASSES[j][2]}"><title>Profundidade ${label} — ${STATUS_CLASSES[j][1]}: ${v}</title></rect>`;
    });
    g += `<text x="${L + i * gw + gw / 2}" y="${H - B + 16}" text-anchor="middle">${label}</text>`;
  });
  g += `<line x1="${L}" x2="${L}" y1="${T}" y2="${T + ph}" class="axis"/><line x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}" class="axis"/>`;
  g += `<text transform="translate(12 ${T + ph / 2}) rotate(-90)" text-anchor="middle">URLs</text>`;
  return `<svg class="depthchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>
    <div class="clegend">${STATUS_CLASSES.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`;
}
function depthTable() {
  return `<table class="dtable"><thead><tr><th>Profundidade</th>${STATUS_CLASSES.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>` +
    depthData().map(([l, v]) => `<tr><td>${l}</td>${v.map((n) => `<td class="num">${n}</td>`).join('')}<td class="num">${v.reduce((a, b) => a + b, 0)}</td></tr>`).join('') + '</tbody></table>';
}
let ST_TREE = null;
function structurePanel() {
  ST_TREE = buildTree(DATA.pages);
  const nodes = flattenTree(ST_TREE, stOpen);
  const codes = S.stView === 'codes';
  const cols = codes ? STATUS_CLASSES.slice(2).map(([k, l]) => [l, (n) => n.codes[k] || 0]) : [['Indexáveis', (n) => n.idx], ['Não indexáveis', (n) => n.nonidx]];
  const h = `<div class="sttool">
      <button class="tbtn sq" data-ract="st-collapse" title="Recolher tudo">⊟</button><button class="tbtn sq" data-ract="st-expand" title="Expandir tudo">⊞</button>
      <span class="lvl">Nível: <button class="tbtn sq" data-ract="st-less">−</button><b>${S.stLevel}</b><button class="tbtn sq" data-ract="st-more">+</button></span>
      <button class="tbtn" data-ract="st-export">${ICON_EXPORT_SVG} Exportar</button>
      <span class="stview">Ver: <select id="stView"><option value="indexability" ${codes ? '' : 'selected'}>Indexabilidade</option><option value="codes" ${codes ? 'selected' : ''}>Códigos de resposta</option></select></span>
    </div><table class="sttable"><thead><tr><th>Caminho</th><th class="num">URLs ▾</th>${cols.map(([l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>` +
    (nodes.length ? nodes.map((n) => `<tr class="${S.custom?.label === 'Caminho: ' + n.prefix ? 'on' : ''}" data-stpath="${esc(n.prefix)}">${pathCell(n, stOpen(n), 'data-stnode')}<td class="num">${n.n}</td>${cols.map(([, f]) => `<td class="num">${f(n)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length + 2}" class="empty">Rode um crawl para ver a estrutura.</td></tr>`) +
    `</tbody></table><div class="stfoot">Nível máx.: ${Math.max(0, treeMaxDepth(ST_TREE))}</div>`;
  const chart = `<h3 class="withview"><span class="ttl">Profundidade de rastreamento</span><span class="stview">Ver: <select id="chartView"><option value="chart" ${S.chartView === 'chart' ? 'selected' : ''}>Gráfico</option><option value="table" ${S.chartView === 'table' ? 'selected' : ''}>Tabela</option></select></span></h3>` +
    (S.chartView === 'table' ? depthTable() : depthChart());
  return [h, chart];
}
function exportStructure() {
  const rows = [];
  const walk = (node) => { for (const ch of treeKids(node)) { rows.push(ch); walk(ch); } };
  walk(ST_TREE || buildTree(DATA.pages));
  exportCsv(rows.map((n) => ({ path: '  '.repeat(n.depth) + n.name, prefix: n.prefix, n: n.n, idx: n.idx, nonidx: n.nonidx, ...Object.fromEntries(STATUS_CLASSES.map(([k]) => [k, n.codes[k] || 0])) })),
    [{ key: 'path', label: 'Caminho' }, { key: 'prefix', label: 'URL' }, { key: 'n', label: 'URLs' }, { key: 'idx', label: 'Indexáveis' }, { key: 'nonidx', label: 'Não indexáveis' },
      ...STATUS_CLASSES.map(([k, l]) => ({ key: k, label: l }))], t('seo-spider-estrutura-do-site'));
}
const ICON_EXPORT_SVG = '<svg class="i" viewBox="0 0 16 16"><path d="M8 1l4 4.2H9.4V10H6.6V5.2H4z"/><path d="M1 9.5V15h14V9.5h-2.2v3.3H3.2V9.5z"/></svg>';

// ---------- API integrations ----------
let APIS = [];
const ICON_GEAR = '<svg class="i" viewBox="0 0 16 16"><path d="M9.3 1l.4 1.9c.5.2.9.4 1.3.7l1.8-.7 1.3 2.2-1.5 1.3a5 5 0 0 1 0 1.6l1.5 1.3-1.3 2.2-1.8-.7c-.4.3-.8.6-1.3.7L9.3 15H6.7l-.4-1.9c-.5-.2-.9-.4-1.3-.7l-1.8.7-1.3-2.2 1.5-1.3a5 5 0 0 1 0-1.6L1.9 6.1l1.3-2.2 1.8.7c.4-.3.8-.6 1.3-.7L6.7 1zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/></svg>';
const ICON_CLOUD = '<svg class="i" viewBox="0 0 16 16"><path d="M4.5 13a3.5 3.5 0 0 1-.6-6.95A4.5 4.5 0 0 1 12.6 5 3 3 0 0 1 12.5 11H10V8.5h1.6L8 5 4.4 8.5H6V11H4.5z"/><path d="M6.6 9.5h2.8V13H6.6z"/></svg>';
async function loadApis() {
  const r = await fetch('/api/integrations');
  if (r.ok) APIS = await r.json();
}
const apiOn = (id) => (lastStatus?.integrations?.[id]?.connected ?? APIS.find((p) => p.id === id)?.connected) || false;
const hasAny = (keys) => DATA.pages.some((p) => keys.some((k) => p[k] != null && p[k] !== ''));

// ---------- right panel ----------
const RTABS = {
  overview: 'Visão geral', issues: 'Problemas', structure: 'Estrutura do site', segments: 'Segmentos', times: 'Tempos de resposta',
  api: 'API', spelling: 'Ortografia e gramática', semantic: 'Busca semântica',
};

// segments: "nome | regex" lines from the config, applied client-side without recrawling
function segmentDefs() {
  return ($('[name=segments]')?.value || '').split('\n').map((l) => l.split('|')).filter((p) => p.length >= 2 && p[0].trim())
    .map(([name, ...rest]) => { try { return { name: name.trim(), re: new RegExp(rest.join('|').trim(), 'i') }; } catch { return null; } })
    .filter(Boolean);
}
function applySegments() {
  const defs = segmentDefs();
  for (const r of DATA.pages.concat(DATA.external, DATA.images)) r.segment = (defs.find((d) => d.re.test(r.url)) || {}).name || '';
  return defs;
}
const SEG_NONE = '(sem segmento)';
const PALETTE = ['#76b82a', '#b9df5b', '#dbf5c6', '#a9b5d9', '#6f86c6', '#f2c46d', '#e88e5a', '#d9534f', '#9b7fc4', '#3aa58f', '#9e9e9e', '#f1c40f'];
// fixed colour per content type, so a category keeps its colour whatever else is in the chart
const CAT_COLORS = {
  HTML: '#76b82a', JavaScript: '#b9df5b', CSS: '#dbf5c6', Imagens: '#a9b5d9', 'Mídia': '#6f86c6',
  Fontes: '#f2c46d', XML: '#e88e5a', PDF: '#d9534f', Plugins: '#9b7fc4', Outros: '#9e9e9e',
};
const COLLAPSED = store.get('seo-spider-collapsed', {});

// entries: [label, count, filterKey?] — hovering a segment/legend item shows "label / n (pct%)" in the centre
function donut(entries) {
  entries = entries.filter(([, n]) => n > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (!total) return '<div class="empty">Sem dados para o gráfico.</div>';
  const gap = entries.length > 1 ? 0.7 : 0;
  const color = (l, i) => CAT_COLORS[l] || PALETTE[i % PALETTE.length];
  let off = 25;
  const arcs = entries.map(([l, n, key], i) => {
    const p = (n / total) * 100;
    const seg = Math.max(p - gap, 0.15);
    const s = `<circle class="seg" data-seg="${i}" ${key ? `data-key="${key}"` : ''} r="15.915" cx="21" cy="21" fill="none" stroke="${color(l, i)}" stroke-width="7" stroke-dasharray="${seg} ${100 - seg}" stroke-dashoffset="${off - gap / 2}"/>`;
    off -= p;
    return s;
  }).join('');
  const info = entries.map(([l, n]) => [l, `${n} (${((n / total) * 100).toFixed(2)}%)`]);
  return `<div class="donutwrap" data-info="${esc(JSON.stringify(info))}">
    <div class="legend">${entries.map(([l, , key], i) => `<span data-seg="${i}" ${key ? `data-key="${key}"` : ''}><i style="background:${color(l, i)}"></i>${esc(l)}</span>`).join('')}</div>
    <svg viewBox="0 0 42 42">${arcs}<text class="c1" x="21" y="20.4" text-anchor="middle">${esc(info[0][0])}</text><text class="c2" x="21" y="23.8" text-anchor="middle">${esc(info[0][1])}</text></svg></div>`;
}

function highlightSeg(wrap, i) {
  const info = JSON.parse(wrap.dataset.info);
  const [label, value] = info[i] || info[0];
  wrap.querySelector('.c1').textContent = label;
  wrap.querySelector('.c2').textContent = value;
  wrap.querySelectorAll('[data-seg]').forEach((el) => el.classList.toggle('hl', i != null && +el.dataset.seg === i));
}

function hbars(entries) {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return `<div class="hbars">${entries.map(([l, v]) => `<div class="bar-row"><span>${esc(l)}</span><div class="bar" style="width:${(v / max) * 100}%"></div><span class="v">${v}</span></div>`).join('')}</div>`;
}

const DEPTH_GROUPS = () => {
  const html = DATA.pages.filter((p) => category(p) === 'HTML' && p.status != null);
  const keys = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10+', 'Só sitemap'];
  const of = (p) => (p.depth == null ? 'Só sitemap' : p.depth >= 10 ? '10+' : String(p.depth));
  return { html, keys, of };
};
const TIME_BUCKETS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, Infinity]];
const timeLabel = ([a, b]) => (b === Infinity ? `${a}s+` : `${a}s – ${b}s`);

function renderRight() {
  $('#rtabs').innerHTML = Object.entries(RTABS).map(([k, l]) => `<button data-rtab="${k}" class="${k === S.rtab ? 'active' : ''}">${l}</button>`).join('');
  const box = $('#rtable');
  const scroll = box.scrollTop;
  let h = '';
  let chart = '';
  if (S.rtab === 'overview') {
    const head = (id, label, lvl, attrs = '') => `<tr class="sec" ${attrs}><td class="name" style="padding-left:${6 + lvl * 18}px"><span class="tg" data-toggle="${id}">${COLLAPSED[id] ? '▶' : '▼'}</span> ${label}</td><td></td><td></td></tr>`;
    const row = (label, n, total, lvl, attrs = '', on = false, bad = false) =>
      `<tr class="sub ${on ? 'on' : ''} ${bad ? 'bad' : ''}" ${attrs}><td class="name" style="padding-left:${24 + lvl * 18}px">${esc(label)}</td><td class="num n">${n}</td><td class="num">${pct(n, total)}</td></tr>`;
    const pages = DATA.pages, ext = extAll();
    const encountered = pages.length + ext.length;
    const intBlocked = pages.filter(blocked).length;
    const extBlocked = ext.filter(blocked).length;
    const crawled = encountered - intBlocked - extBlocked;
    const indexable = pages.filter((p) => p.indexability === 'Indexable').length;
    const nonIdx = pages.filter((p) => p.indexability === 'Non-Indexable').length;
    h = '<table><thead><tr><th></th><th class="num">URLs</th><th class="num">% do total</th></tr></thead><tbody>';
    h += head('summary', 'Resumo', 0);
    if (!COLLAPSED.summary) {
      h += row('Total de URLs encontradas', encountered, encountered, 0) +
        row('Internas bloqueadas pelo robots.txt', intBlocked, encountered, 0, 'data-tab="codes" data-filter="blocked"') +
        row('Externas bloqueadas pelo robots.txt', extBlocked, encountered, 0) +
        row('Total de URLs rastreadas', crawled, encountered, 0) +
        row('Total de URLs internas', pages.length - intBlocked, crawled, 0, 'data-tab="internal" data-filter="all"') +
        row('Total de URLs externas', ext.length - extBlocked, crawled, 0, 'data-tab="external" data-filter="all"') +
        row('Internas indexáveis', indexable, pages.length, 0, 'data-sum="indexable"') +
        row('Internas não indexáveis', nonIdx, pages.length, 0, 'data-sum="nonindexable"');
    }
    h += head('crawl', 'Dados do crawl', 0);
    if (!COLLAPSED.crawl) {
      const req = REQ_LABEL();
      for (const [k, t] of visibleTabs()) {
        const base = t.rows();
        h += head('tab:' + k, t.label, 1, `data-tab="${k}" data-filter="${'all'}"`);
        if (COLLAPSED['tab:' + k]) continue;
        for (const [fk, [label, f]] of Object.entries(t.filters)) {
          const n = fk === 'all' ? base.length : base.filter(f).length;
          h += row(needsAnalysis(k, fk) ? `${label} ${req}` : label, n, base.length, 1, `data-tab="${k}" data-filter="${fk}"`,
            !S.custom && S.tab === k && S.filter === fk, fk !== 'all' && n > 0 && BAD.test(label));
        }
      }
    }
    const t = TABS[S.tab];
    const base = t.rows();
    chart = `<h3>${t.label}</h3>` + donut(Object.entries(t.filters).filter(([fk]) => fk !== 'all').map(([fk, [l, f]]) => [l, base.filter(f).length, fk]));
  } else if (S.rtab === 'issues') {
    const order = { Issue: 0, Warning: 1, Opportunity: 2 };
    const prio = { Alta: 0, 'Média': 1, Baixa: 2 };
    const prevOf = (name) => MAIN_CMP?.issues.find((i) => i.name === name);
    const list = DATA.issues.filter((i) => i.count > 0 || prevOf(i.name)?.previous > 0).sort((a, b) => order[a.type] - order[b.type] || prio[a.priority] - prio[b.priority] || b.count - a.count);
    const total = DATA.pages.length;
    const cmpH = MAIN_CMP ? '<th class="num">Anterior</th><th class="num">Mudança</th>' : '';
    const cmpD = (i) => { if (!MAIN_CMP) return ''; const p = prevOf(i.name); const prev = p ? p.previous : 0; return `<td class="num">${prev}</td><td class="num">${delta(i.count - prev)}</td>`; };
    h = `<table><thead><tr><th>Problema</th><th>Tipo</th><th>Prioridade</th><th class="num">URLs</th><th class="num">% do total</th>${cmpH}</tr></thead><tbody>` +
      (list.length ? list.map((i) => `<tr class="${S.custom?.label === i.name ? 'on' : ''}" data-issue="${esc(i.name)}"><td class="name" title="${esc(i.name)}">${esc(i.name)}</td><td><span class="pill ${i.type}">${i.type}</span></td><td>${i.priority}</td><td class="num">${i.count}</td><td class="num">${pct(i.count, total)}</td>${cmpD(i)}</tr>`).join('')
        : '<tr><td colspan="5" class="empty">Nenhum problema encontrado.</td></tr>');
    const byType = ['Issue', 'Warning', 'Opportunity'].map((ty) => [ty === 'Issue' ? 'Issues' : ty === 'Warning' ? 'Warnings' : 'Oportunidades', list.filter((i) => i.type === ty).length]);
    chart = '<h3>Problemas</h3>' + donut(byType);
  } else if (S.rtab === 'structure') {
    [h, chart] = structurePanel();
  } else if (S.rtab === 'times') {
    const html = htmlPages();
    const counts = TIME_BUCKETS.map((b) => [timeLabel(b), html.filter((p) => p.response_ms / 1000 >= b[0] && p.response_ms / 1000 < b[1]).length]);
    h = '<table><thead><tr><th>Tempo de resposta (HTML)</th><th class="num">URLs</th><th class="num">% do total</th></tr></thead><tbody>' +
      counts.map(([k, n], i) => `<tr class="${S.custom?.label === 'Tempo ' + k ? 'on' : ''}" data-time="${i}"><td class="name">${k}</td><td class="num">${n}</td><td class="num">${pct(n, html.length)}</td></tr>`).join('');
    chart = '<h3>Tempos de resposta</h3>' + hbars(counts);
  } else {
    [h, chart] = RIGHT_PANELS[S.rtab]();
  }
  box.innerHTML = h + (h.includes('<tbody>') ? '</tbody></table>' : '');
  $('.right').classList.toggle('apimode', S.rtab === 'api');
  box.scrollTop = scroll;
  $('#rchart').innerHTML = chart;
}

const issueTypes = () => new Map(DATA.issues.map((i) => [i.name, i.type]));
const RIGHT_PANELS = {
  segments() {
    const defs = applySegments();
    if (!defs.length) {
      return [`<div class="rnote">Nenhum segmento configurado. Segmentos agrupam URLs por regex e mostram contagens e problemas por grupo.</div><div class="rnote"><code>Blog | /blog/</code></div>
        <div class="rbar"><button class="tbtn" data-ract="segments-config">Configurar segmentos…</button></div>`, '<h3>Segmentos</h3><div class="empty">Sem segmentos.</div>'];
    }
    const types = issueTypes();
    const all = DATA.pages;
    const names = [...defs.map((d) => d.name), SEG_NONE];
    const rows = names.map((n) => {
      const pages = all.filter((p) => (p.segment || SEG_NONE) === n);
      const withIssues = pages.filter((p) => (p.issues || []).some((i) => types.get(i) === 'Issue')).length;
      return [n, pages.length, withIssues];
    });
    const h = '<table><thead><tr><th>Segmento</th><th class="num">URLs</th><th class="num">% do total</th><th class="num">Com issues</th></tr></thead><tbody>' +
      rows.map(([n, c, wi]) => `<tr class="${S.custom?.label === 'Segmento: ' + n ? 'on' : ''} ${wi ? 'bad' : ''}" data-segment="${esc(n)}"><td class="name">${esc(n)}</td><td class="num">${c}</td><td class="num">${pct(c, all.length)}</td><td class="num n">${wi}</td></tr>`).join('') +
      '</tbody></table><div class="rbar"><button class="tbtn" data-ract="segments-config">Editar segmentos…</button></div>';
    return [h, '<h3>Segmentos</h3>' + donut(rows.map(([n, c]) => [n, c]))];
  },
  api() {
    const states = lastStatus?.integrations || {};
    const cards = APIS.map((p) => {
      const st = { ...p.state, ...(states[p.id] || {}) };
      const connected = states[p.id]?.connected ?? p.connected;
      const pctDone = st.total ? Math.round((st.done / st.total) * 100) : 0;
      const label = connected ? t('Conectado') : t('Desconectado');
      return `<div class="apicard">
        <div class="apiicon" style="background:${p.color}" translate="no">${esc(p.icon)}</div>
        <div class="apibody">
          <div class="apiname" translate="no">${esc(p.name)}</div>
          <div class="apirow"><div class="apibar ${st.running ? 'run' : ''}"><div style="width:${pctDone}%"></div></div>
            <button class="gear" data-api-cfg="${p.id}" title="${esc(t('Configurar'))}">${ICON_GEAR}</button></div>
          <div class="apimeta"><span>${tf('Progresso: {{0}}%', pctDone)}</span>
            <span class="${st.errors ? 's4' : ''}" title="${esc(st.last_error || '')}">${tf('Erros: {{0}}', st.errors || 0)}</span>
            <span class="${connected ? 's2' : 'muted'}">${label}</span></div>
        </div></div>`;
    }).join('');
    const running = Object.values(states).some((s) => s.running);
    const anyConnected = APIS.some((p) => states[p.id]?.connected ?? p.connected);
    const foot = `<div class="apifoot">${running ? `<button class="tbtn" data-ract="api-stop">■ ${t('Parar')}</button>` : ''}
      <button class="tbtn apireq" data-ract="api-run" ${!anyConnected || !DATA.pages.length || running ? 'disabled' : ''}>${ICON_CLOUD} ${t('Solicitar dados da API')}</button></div>`;
    return [`<div class="apicards">${cards}</div>`, foot];
  },
  spelling() {
    const hp = htmlPages();
    const sp = hp.filter((p) => p.spelling_errors > 0);
    const gr = hp.filter((p) => p.grammar_errors > 0);
    const g = (lastStatus || {}).grammar || {};
    const top = DATA.spelling_top || [];
    let h = '<table><thead><tr><th></th><th class="num">URLs</th><th class="num">% do total</th></tr></thead><tbody>' +
      `<tr class="sub ${S.custom?.label === 'Erros de ortografia' ? 'on' : ''} ${sp.length ? 'bad' : ''}" data-sg="spelling"><td class="name">Erros de ortografia</td><td class="num n">${sp.length}</td><td class="num">${pct(sp.length, hp.length)}</td></tr>` +
      `<tr class="sub ${S.custom?.label === 'Erros de gramática' ? 'on' : ''} ${gr.length ? 'bad' : ''}" data-sg="grammar"><td class="name">Erros de gramática</td><td class="num n">${gr.length}</td><td class="num">${pct(gr.length, hp.length)}</td></tr>` +
      `<tr class="sec"><td class="name">Palavras desconhecidas mais frequentes</td><td></td><td></td></tr>` +
      (top.length ? top.map((t) => `<tr class="sub ${S.custom?.label === 'Palavra: ' + t.word ? 'on' : ''}" data-word="${esc(t.word)}"><td class="name">${esc(t.word)}</td><td class="num">${t.count}</td><td class="num">${pct(t.count, hp.length)}</td></tr>`).join('')
        : `<tr><td colspan="3" class="rnote">${DATA.finalized ? 'Nenhuma palavra desconhecida.' : 'Calculado na Análise de crawl (ao fim do rastreamento).'}</td></tr>`) +
      `</tbody></table><div class="rbar">${g.running ? `<span class="muted">Gramática: ${g.done}/${g.total}</span><button class="tbtn" data-ract="grammar-stop">■ Parar</button>`
        : '<button class="tbtn" data-ract="grammar">▶ Verificar gramática (LanguageTool)</button>'}
        <button class="tbtn" data-ract="spell-config">Idioma / ignorar palavras…</button></div>
        <div class="rnote">A gramática envia o texto das páginas para a API pública do LanguageTool (20 páginas/min).</div>`;
    return [h, '<h3>Palavras mais frequentes</h3>' + (top.length ? hbars(top.slice(0, 12).map((t) => [t.word, t.count])) : '<div class="empty">Sem dados.</div>')];
  },
  semantic() {
    const hp = htmlPages();
    const sim = hp.filter((p) => p.semantic_similar > 0);
    const low = hp.filter((p) => p.low_relevance);
    let h = `<div class="rbar"><div class="search"><svg class="i ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
        <input id="semQuery" type="search" placeholder="Buscar por significado (ex.: pintura de casas)" value="${esc(SEM.q)}"></div><button class="tbtn" data-ract="semantic-search">Buscar</button></div>`;
    if (!DATA.semantic_ready) h += `<div class="rnote">${DATA.finalized ? 'Índice indisponível (precisa de ao menos 3 páginas indexáveis com texto).' : 'O índice semântico é montado na Análise de crawl, ao fim do rastreamento.'}</div>`;
    h += '<table><thead><tr><th></th><th class="num">URLs</th><th class="num">% do total</th></tr></thead><tbody>' +
      `<tr class="sub ${S.custom?.label === 'Semanticamente similares' ? 'on' : ''} ${sim.length ? 'bad' : ''}" data-sem="similar"><td class="name">Semanticamente similares</td><td class="num n">${sim.length}</td><td class="num">${pct(sim.length, hp.length)}</td></tr>` +
      `<tr class="sub ${S.custom?.label === 'Baixa relevância' ? 'on' : ''} ${low.length ? 'bad' : ''}" data-sem="low"><td class="name">Baixa relevância</td><td class="num n">${low.length}</td><td class="num">${pct(low.length, hp.length)}</td></tr>`;
    if (SEM.results) {
      h += `<tr class="sec"><td class="name">Resultados para “${esc(SEM.q)}”</td><td class="num">Score</td><td></td></tr>` +
        (SEM.results.length ? SEM.results.map((r) => `<tr class="sub" data-goto-url="${esc(r.url)}"><td class="name" title="${esc(r.url)}">${esc(r.url)}</td><td class="num">${r.score.toFixed(3)}</td><td></td></tr>`).join('')
          : '<tr><td colspan="3" class="rnote">Nenhum resultado.</td></tr>');
    }
    h += '</tbody></table><div class="rnote">Índice local TF-IDF + LSA: similaridade por tópico e vocabulário, sem enviar dados para fora.</div>';
    const rel = hp.map((p) => p.semantic_relevance).filter((v) => v != null);
    return [h, '<h3>Relevância para o site</h3>' + (rel.length ? hbars(buckets(rel.map((v) => Math.max(v, 0)), [0, 0.2, 0.4, 0.6, 0.8])) : '<div class="empty">Sem dados.</div>')];
  },
};
const SEM = { q: '', results: null };

function issueTab(name) {
  const rules = [[/^Acessibilidade/, 'accessibility'], [/^Mobile/, 'mobile'], [/^AMP/, 'amp'], [/^Segurança/, 'security'], [/^Códigos de resposta/, 'codes'], [/^URL:/, 'url'], [/^Diretivas/, 'directives'],
    [/^Sitemaps/, 'sitemaps'], [/^Analytics/, 'analytics'], [/^Validação/, 'validation'], [/^JavaScript:/, 'javascript'], [/^Paginação/, 'pagination'], [/HSTS/, 'security'], [/^Core Web Vitals/, 'pagespeed'],
    [/^PDF/, 'internal'], [/^Title/, 'titles'], [/^Meta description/, 'meta'], [/^H1/, 'h1'], [/^H2/, 'h2'], [/Canonical/, 'canonicals'],
    [/^Hreflang/, 'hreflang'], [/dados estruturados|Dados estruturados/, 'structured'], [/Open Graph|og:image/, 'social'],
    [/Cadeia|Loop|Redirect para/, 'redirects'], [/^URL com|^URL acima/, 'url'], [/^Imagem/, 'images'], [/Imagens sem alt/, 'images'],
    [/Conteúdo|truncada|renderização/, 'content'], [/^Noindex/, 'directives'], [/Órfã|sitemap/, 'sitemaps'],
    [/HTTP|misto|HSTS|X-Content|X-Frame|Content-Security|Referrer/, 'security'], [/PageSpeed/, 'pagespeed'],
    [/^Links:|links quebrados/, 'links'], [/externo/, 'external'], [/Erro|Sem resposta|Bloqueado|Redirecionamento/, 'codes']];
  return (rules.find(([re]) => re.test(name)) || [, 'internal'])[1];
}

function applyIssue(name) {
  const issue = DATA.issues.find((i) => i.name === name) || (MAIN_CMP && MAIN_CMP.issues.find((i) => i.name === name) && { name, urls: [] });
  if (!issue) return;
  const k = MAIN_CMP && $('#chgSel').value;
  const ci = k && k !== 'all' && MAIN_CMP.issues.find((i) => i.name === name);
  if (ci) {
    const set = new Set(ci[k]);
    const extra = k === 'missing' ? ci.missing.map((u) => ({ url: u, status: null, indexability: '', status_text: t('Ausente no crawl atual') })) : [];
    setView(issueTab(name), 'all', { label: name, rows: () => DATA.pages.concat(DATA.external, DATA.images, extra), test: (r) => set.has(r.url) });
    return;
  }
  const urls = new Set(issue.urls);
  const tab = name === 'Imagens sem alt' ? 'images' : issueTab(name);
  const all = () => DATA.pages.concat(DATA.external, DATA.images);
  const test = name === 'Imagens sem alt' ? (r) => r.missing_alt > 0 : (r) => urls.has(r.url);
  setView(tab, 'all', { label: name, rows: name === 'Imagens sem alt' ? TABS.images.rows : all, test });
}

// ---------- visualizations ----------
function barChart(title, entries) {
  return `<div class="chart"><h4>${esc(title)}</h4>${hbars(entries)}</div>`;
}
function buckets(values, edges, unit = '') {
  return edges.map((lo, i) => {
    const hi = edges[i + 1];
    return [hi == null ? `${lo}${unit}+` : `${lo}–${hi}${unit}`, values.filter((v) => v != null && v >= lo && (hi == null || v < hi)).length];
  });
}
function charts() {
  const { html, keys, of } = DEPTH_GROUPS();
  const codes = [['2xx', range(200, 299)], ['3xx', range(300, 399)], ['4xx', range(400, 499)], ['5xx', range(500, 599)], ['Bloqueado', blocked], ['Sem resposta', noResp]]
    .map(([l, f]) => [l, DATA.pages.filter(f).length]);
  const hp = htmlPages();
  return '<div class="charts">' +
    barChart('Profundidade de rastreamento (HTML)', keys.map((k) => [k, html.filter((p) => of(p) === k).length]).filter(([, n]) => n)) +
    barChart('Códigos de resposta (internos)', codes) +
    barChart('Tipos de conteúdo (internos)', CATS.map((c) => [c, DATA.pages.filter((p) => category(p) === c).length]).filter(([, n]) => n)) +
    barChart('Tempo de resposta', buckets(DATA.pages.map((p) => p.response_ms), [0, 250, 500, 1000, 2000], ' ms')) +
    barChart('Link Score (HTML)', buckets(hp.map((p) => p.link_score), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90])) +
    barChart('Contagem de palavras (HTML)', buckets(hp.map((p) => p.word_count), [0, 200, 500, 1000, 2000])) +
    barChart('Inlinks únicos (HTML)', buckets(hp.map((p) => p.unique_inlinks), [0, 1, 2, 5, 10, 50])) +
    '</div>';
}
const leaf = (p, label) => `<div class="leaf"><span class="${statusCls(p.status)}">${p.status ?? '…'}</span> <a class="link" data-goto="${esc(p.url)}">${esc(label)}</a></div>`;
function dirTree(rows) {
  const root = { children: new Map(), pages: [], count: 0 };
  for (const p of rows) {
    let u;
    try { u = new URL(p.url); } catch { continue; }
    const segs = [u.host, ...u.pathname.split('/').filter(Boolean)];
    const dirs = u.pathname.endsWith('/') ? segs : segs.slice(0, -1);
    let node = root;
    node.count++;
    for (const s of dirs) {
      if (!node.children.has(s)) node.children.set(s, { children: new Map(), pages: [], count: 0 });
      node = node.children.get(s);
      node.count++;
    }
    node.pages.push(p);
  }
  const render = (node, depth) => [...node.children.entries()].sort((a, b) => b[1].count - a[1].count).map(([name, n]) =>
    `<details ${depth < 2 ? 'open' : ''}><summary>${esc(name)}/<span class="n">(${n.count})</span></summary>${render(n, depth + 1)}${n.pages.map((p) => leaf(p, path(p.url) + new URL(p.url).search)).join('')}</details>`).join('');
  return `<div class="tree">${render(root, 0)}${root.pages.map((p) => leaf(p, p.url)).join('')}</div>`;
}
function crawlTree() {
  const kids = new Map();
  const roots = [];
  for (const p of DATA.pages) {
    if (p.parent && PAGE.has(p.parent)) { if (!kids.has(p.parent)) kids.set(p.parent, []); kids.get(p.parent).push(p); }
    else roots.push(p);
  }
  const seen = new Set();
  const render = (p, depth) => {
    if (seen.has(p.url)) return '';
    seen.add(p.url);
    const ch = kids.get(p.url) || [];
    if (!ch.length) return leaf(p, p.url);
    return `<details ${depth < 1 ? 'open' : ''}><summary><span class="${statusCls(p.status)}">${p.status ?? '…'}</span> <a class="link" data-goto="${esc(p.url)}">${esc(p.url)}</a><span class="n">(${ch.length} filhos)</span></summary>${ch.map((c) => render(c, depth + 1)).join('')}</details>`;
  };
  return `<div class="tree">${roots.map((r) => render(r, 0)).join('')}</div>`;
}
function renderViz() {
  const modes = { charts: 'Gráficos do crawl', dir: 'Árvore de diretórios', crawl: 'Árvore de rastreamento', force: 'Diagrama de links (força)', clusters: 'Clusters de conteúdo' };
  let h = `<div class="switch">${Object.entries(modes).map(([k, l]) => `<button data-viz="${k}" class="${k === S.viz ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  if (!DATA.pages.length) h += '<div class="empty">Rode um crawl para ver as visualizações.</div>';
  else if (S.viz === 'force' || S.viz === 'clusters') h += `<div id="vizCanvas" class="vizcanvas">${empty('Carregando…')}</div>`;
  else h += S.viz === 'charts' ? charts() : S.viz === 'dir' ? dirTree(DATA.pages) : crawlTree();
  $('#viz').innerHTML = h;
  if (DATA.pages.length && S.viz === 'force') forceDiagram();
  if (DATA.pages.length && S.viz === 'clusters') clusterMap();
}

const nodeColor = (n) => (n.status === 0 || n.status >= 400 ? '#d9363e' : n.status >= 300 ? '#f5b52e' : n.indexability === 'Non-Indexable' ? '#9b7fc4' : '#76b82a');
async function forceDiagram() {
  const g = await fetch('/api/graph?limit=400').then((r) => r.json()).catch(() => null);
  const box = $('#vizCanvas');
  if (!box) return;
  if (!g || !g.nodes.length) { box.innerHTML = empty('Sem dados.'); return; }
  const W = 1000, H = 640, idx = new Map(g.nodes.map((n, i) => [n.url, i]));
  const N = g.nodes.map((n, i) => ({ ...n, x: W / 2 + Math.cos(i) * (40 + (n.depth || 0) * 60), y: H / 2 + Math.sin(i) * (40 + (n.depth || 0) * 60), vx: 0, vy: 0 }));
  const E = g.edges.map(([a, b]) => [idx.get(a), idx.get(b)]).filter(([a, b]) => a != null && b != null);
  for (let it = 0; it < 220; it++) {
    const k = 1 - it / 220;
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
      let dx = N[i].x - N[j].x, dy = N[i].y - N[j].y;
      const d2 = dx * dx + dy * dy + 0.01, f = 900 / d2;
      dx *= f; dy *= f;
      N[i].vx += dx; N[i].vy += dy; N[j].vx -= dx; N[j].vy -= dy;
    }
    for (const [a, b] of E) {
      const dx = N[b].x - N[a].x, dy = N[b].y - N[a].y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 40) * 0.02;
      N[a].vx += dx / d * f; N[a].vy += dy / d * f; N[b].vx -= dx / d * f; N[b].vy -= dy / d * f;
    }
    for (const n of N) {
      n.vx += (W / 2 - n.x) * 0.004; n.vy += (H / 2 - n.y) * 0.004;
      n.x += Math.max(-20, Math.min(20, n.vx)) * k; n.y += Math.max(-20, Math.min(20, n.vy)) * k;
      n.vx *= 0.5; n.vy *= 0.5;
    }
  }
  const xs = N.map((n) => n.x), ys = N.map((n) => n.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (x) => 20 + ((x - x0) / ((x1 - x0) || 1)) * (W - 40), sy = (y) => 20 + ((y - y0) / ((y1 - y0) || 1)) * (H - 40);
  box.innerHTML = `<div class="muted">${tf('{{0}} páginas e {{1}} links internos (mostrando até 400 páginas, as mais próximas da home).', N.length, E.length)}</div>
    <svg viewBox="0 0 ${W} ${H}" class="forcesvg">
      ${E.map(([a, b]) => `<line x1="${sx(N[a].x)}" y1="${sy(N[a].y)}" x2="${sx(N[b].x)}" y2="${sy(N[b].y)}"/>`).join('')}
      ${N.map((n) => `<circle cx="${sx(n.x)}" cy="${sy(n.y)}" r="${Math.min(14, 3 + Math.sqrt(n.inlinks || 0))}" fill="${nodeColor(n)}" data-goto="${esc(n.url)}"><title>${esc(n.url)} · ${n.status} · ${tf('profundidade {{0}}', n.depth ?? '-')} · ${tf('{{0}} inlinks', n.inlinks)}</title></circle>`).join('')}
    </svg>
    <div class="clegend"><span><i style="background:#76b82a"></i>${t('Indexável')}</span><span><i style="background:#9b7fc4"></i>${t('Não indexável')}</span><span><i style="background:#f5b52e"></i>3xx</span><span><i style="background:#d9363e"></i>${t('4xx / 5xx / sem resposta')}</span></div>`;
}

async function clusterMap() {
  const box = $('#vizCanvas');
  const r = await fetch('/api/semantic/map');
  if (!box) return;
  if (!r.ok) { box.innerHTML = empty(t((await r.json().catch(() => ({}))).detail || 'Sem dados.')); return; }
  const m = await r.json();
  const W = 1000, H = 600, xs = m.points.map((p) => p.x), ys = m.points.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (x) => 30 + ((x - x0) / ((x1 - x0) || 1)) * (W - 60), sy = (y) => 30 + ((y - y0) / ((y1 - y0) || 1)) * (H - 60);
  box.innerHTML = `<div class="muted">${m.source === 'embeddings' ? t('Calculado com embeddings de IA.') : t('Calculado com o índice semântico local (TF-IDF + LSA). Para mais precisão, rode um prompt de embeddings na aba API.')}</div>
    <svg viewBox="0 0 ${W} ${H}" class="forcesvg">${m.points.map((p) => `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="6" fill="${PALETTE[p.cluster % PALETTE.length]}" ${p.low ? 'stroke="#d9363e" stroke-width="2.5"' : ''} data-goto="${esc(p.url)}"><title>${esc(p.title || '')}\n${esc(p.url)}${p.low ? '\n' + t('Baixa relevância') : ''}</title></circle>`).join('')}</svg>
    <div class="clegend" translate="no">${m.clusters.map((n, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(n)}</span>`).join('')}</div>`;
}

// ---------- bottom detail panel ----------
const PAGE_DTABS = {
  details: 'Detalhes da URL', inlinks: 'Inlinks', outlinks: 'Outlinks', images: 'Detalhes da imagem', resources: 'Recursos',
  serp: 'SERP Snippet', rendered: 'Página renderizada', source: 'Ver código-fonte', headers: 'Cabeçalhos HTTP',
  anchors: 'Texto âncora', ngrams: 'N-gramas', structured: 'Dados estruturados', dups: 'Detalhes de duplicados', semantic: 'Semântica', spelling: 'Ortografia e gramática',
  redirects: 'Redirects', hreflang: 'Hreflang', psi: 'PageSpeed', cookies: 'Cookies', a11y: 'Acessibilidade',
};
function selectedRecord() {
  if (!S.sel) return null;
  return PAGE.get(S.sel) || DATA.external.find((e) => e.url === S.sel) || DATA.images.find((i) => i.url === S.sel) || null;
}
let measureCtx;
function truncPx(text, maxPx, font) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  if (measureCtx.measureText(text).width <= maxPx) return text;
  let s = text;
  while (s && measureCtx.measureText(s + ' …').width > maxPx) s = s.slice(0, -1);
  return s.trimEnd() + ' …';
}
const kvTable = (obj, labels = {}) => '<table class="kv"><thead><tr><th>Nome</th><th>Valor</th></tr></thead><tbody>' + Object.entries(obj)
  .map(([k, v]) => `<tr><td>${esc(labels[k] || k)}</td><td>${k === 'status' ? statusCell(v) : esc(Array.isArray(v) ? v.map((x) => (KV_TR.has(k) ? t(x) : x)).join(' · ') : KV_TR.has(k) ? tv(v) : v)}</td></tr>`).join('') + '</tbody></table>';
const KV_TR = new Set(['status_text', 'indexability', 'indexability_reason', 'hreflang_issues', 'issues', 'Baixa relevância']);
const empty = (msg) => `<div class="empty">${msg}</div>`;

async function loadNgrams() {
  const box = $('#ngOut');
  if (!box) return;
  const urls = [...(S.multi.size ? S.multi : [S.sel])].filter(Boolean);
  const r = await fetch('/api/ngrams', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls, n: S.ngramN || 2, stopwords: S.ngramStop !== false }) });
  const rows = await r.json().catch(() => []);
  if (!$('#ngOut')) return;
  $('#ngOut').innerHTML = rows.length ? `<table><thead><tr><th>${t('Frase')}</th><th class="num">${t('Ocorrências')}</th><th class="num">${t('Páginas')}</th></tr></thead><tbody>` +
    rows.map((g) => `<tr class="ngrow" data-ng="${esc(g.phrase)}"><td class="nt">${esc(g.phrase)}</td><td class="num">${g.count}</td><td class="num">${g.pages}</td></tr>`).join('') + '</tbody></table>'
    : empty(t('Sem texto para analisar (a página precisa ser HTML com conteúdo).'));
  detailStatus();
}
$('#detailBody').addEventListener('change', (e) => {
  if (e.target.id === 'ngN') { S.ngramN = +e.target.value; loadNgrams(); }
  if (e.target.id === 'ngStop') { S.ngramStop = e.target.checked; loadNgrams(); }
});
$('#detailBody').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-ng]');
  if (!row) return;
  $$('.ngrow').forEach((x) => x.classList.toggle('cur', x === row));
  const pages = await fetch('/api/ngrams/pages?phrase=' + encodeURIComponent(row.dataset.ng)).then((r) => r.json());
  $('#ngPages').innerHTML = `<table><thead><tr><th>${tf('Páginas com “{{0}}”', esc(row.dataset.ng))}</th><th class="num">${t('Ocorrências')}</th></tr></thead><tbody>` +
    pages.map((p) => `<tr><td><a class="link" data-goto="${esc(p.url)}">${esc(p.url)}</a></td><td class="num">${p.count}</td></tr>`).join('') + '</tbody></table>';
});
function linkTable(list, other, label) {
  if (!list.length) return empty('Nenhum item.');
  return `<table><thead><tr><th>Tipo</th><th>${label}</th><th>Texto âncora / Alt</th><th>Posição do link</th><th class="num">Código</th><th>Follow</th><th>Rastreabilidade do link</th></tr></thead><tbody>` +
    list.map((l) => { const unc = l.kind === 'uncrawlable'; return `<tr><td>${esc(unc ? 'a' : l.kind)}</td><td><a class="link" data-goto="${esc(l[other])}">${esc(l[other])}</a></td><td class="nt">${esc(l.anchor)}</td><td>${esc(t(l.position || ''))}</td><td class="num">${statusCell(l.status)}</td><td>${l.nofollow ? 'Nofollow' : 'Follow'}</td><td${unc ? ` class="s4" title="${esc(l.via || '')}"` : ''}>${esc(t(unc ? 'Não rastreável' : 'Rastreável'))}</td></tr>`; }).join('') + '</tbody></table>';
}
function sourceView(d, rendered) {
  if (!(rendered ? d.has_rendered : d.has_source)) return empty(rendered ? 'Ative "Renderizar JavaScript" em Configuração para ver a página renderizada.' : 'Código-fonte não disponível.');
  const key = (rendered ? 'r:' : 's:') + d.record.url;
  if (sourceCache.has(key)) return `<pre class="src">${esc(sourceCache.get(key))}</pre>`;
  fetch(`/api/source?url=${encodeURIComponent(d.record.url)}&rendered=${rendered}`).then((r) => r.text()).then((t) => {
    sourceCache.set(key, t);
    if (S.sel === d.record.url && S.detail === (rendered ? 'rendered' : 'source')) renderDetail();
  });
  return empty('Carregando…');
}

// URL Details: the reference field list, in order, with readable names and formatted values
const kB = (b) => (b == null || b === '' ? '' : `${(b / 1000).toFixed(1)} kB`);
const secs = (ms) => (ms == null || ms === '' ? '' : (ms / 1000).toFixed(2));
function urlDetailRows(d) {
  const r = d.record, x = d.extra || {};
  const html = /html/.test(r.content_type || '');
  const len = (s) => (s ? [...s].length : '');
  const rows = [
    ['Endereço', r.url, 1], ['Endereço codificado', x.encoded, 1], ['Tipo de conteúdo', r.content_type_header || r.content_type, 1],
    ['Código de status', r.status, 1, 'status'], ['Status', t(r.status_text || ''), 1], ['Indexabilidade', tv(r.indexability || ''), 1],
    ['Status de indexabilidade', tv(r.indexability_reason || '')],
    ['Title 1', r.title, html], ['Tamanho do title 1', r.title ? r.title_len : '', html], ['Largura do title 1 (px)', r.title ? r.title_px : '', html],
    ['Meta description 1', r.meta_desc, html], ['Tamanho da meta description 1', r.meta_desc ? r.md_len : '', html],
    ['Largura da meta description 1 (px)', r.meta_desc ? r.md_px : '', html],
    ['Meta keywords 1', r.meta_keywords], ['Tamanho das meta keywords 1', len(r.meta_keywords)],
    ['H1-1', r.h1_1, html], ['Tamanho do H1-1', r.h1_1 ? r.h1_len : '', html], ['H1-2', r.h1_2], ['Tamanho do H1-2', len(r.h1_2)],
    ['H2-1', r.h2_1, html], ['Tamanho do H2-1', r.h2_1 ? r.h2_len : '', html], ['H2-2', r.h2_2], ['Tamanho do H2-2', len(r.h2_2)],
    ['Meta robots 1', r.meta_robots, html], ['X-Robots-Tag 1', r.x_robots], ['Meta refresh 1', r.meta_refresh],
    ['Canonical link element 1', x.canonical, html], ['Origem do canonical link element 1', x.canonical_origin, html],
    ['Indexabilidade do canonical link element 1', tv(x.canonical_indexability || ''), html],
    ['rel="next" 1', r.pag_next], ['rel="prev" 1', r.pag_prev], ['amphtml link element', r.amp_url],
    ['Tamanho', kB(r.size), 1], ['Transferido', kB(r.transferred), 1], ['Total transferido', kB(r.transferred), 1],
    ['CO2 (mg)', r.co2_mg, 1], ['Classificação de carbono', x.carbon_rating, 1],
    ['Contagem de palavras', r.word_count, html], ['Contagem de frases', r.sentences, html], ['Média de palavras por frase', r.avg_wps, html],
    ['Índice de facilidade de leitura Flesch', r.flesch, html], ['Legibilidade', t(x.readability || ''), html], ['Proporção de texto', r.text_ratio, html],
    ['Profundidade do crawl', r.depth, 1], ['Profundidade de pastas', x.folder_depth, 1], ['Link Score', r.link_score, 1],
    ['Inlinks', r.inlinks, 1], ['Inlinks únicos', r.unique_inlinks, 1], ['Inlinks JS únicos', 0, html], ['% do total', x.pct_total, 1],
    ['Outlinks', x.outlinks, html], ['Outlinks únicos', x.unique_outlinks, html], ['Outlinks JS únicos', x.js_unique_outlinks, html],
    ['Outlinks externos', x.external_outlinks, html], ['Outlinks externos únicos', x.unique_external_outlinks, html],
    ['Outlinks externos JS únicos', 0, html],
    ['Hash', r.md5, 1], ['Tempo de resposta', secs(r.response_ms), 1], ['Última modificação', r.last_modified, 1],
    ['URL de redirecionamento', r.redirect_url], ['Tipo de redirecionamento', r.redirect_url ? t('Redirecionamento HTTP') : ''],
    ['Destino do meta refresh', r.meta_refresh_url], ['Destino do redirecionamento JS', r.js_redirect],
    ['Idioma', r.lang, html], ['Versão HTTP', r.http_version, 1], ['Data/hora do crawl', r.crawl_ts, 1],
  ];
  (d.extractors || []).forEach((n, i) => rows.push([`${t('Extração')}: ${n}`, r['ex' + (i + 1)]]));
  (d.custom_js || []).forEach((n, i) => rows.push([`JavaScript: ${n}`, r['js' + (i + 1)]]));
  return rows.filter(([, v, always]) => always || (v !== '' && v != null && v !== false));
}
const DETAIL = {
  details: (d) => '<table class="kv"><thead><tr><th>Nome</th><th>Valor</th></tr></thead><tbody>' +
    urlDetailRows(d).map(([k, v, , kind]) => `<tr><td>${esc(t(k))}</td><td>${kind === 'status' ? statusCell(v) : esc(Array.isArray(v) ? v.join(' · ') : v ?? '')}</td></tr>`).join('') +
    '</tbody></table>',
  inlinks: (d) => linkView(d.links.inlinks, 'in'),
  outlinks: (d) => linkView(d.links.outlinks, 'out'),
  resources: (d) => linkView(d.links.outlinks.filter((l) => l.kind === 'resource' || l.kind === 'img'), 'res'),
  ngrams: () => {
    setTimeout(loadNgrams);
    const n = S.ngramN || 2;
    return `<div class="ngbar"><label>N <select id="ngN">${[1, 2, 3, 4, 5, 6].map((k) => `<option ${k === n ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="ngStop" ${S.ngramStop !== false ? 'checked' : ''}> ${t('Ignorar palavras comuns (stopwords)')}</label>
      <span class="muted">${tf('{{0}} URL(s) selecionada(s) — use Ctrl/Shift para selecionar várias.', S.multi.size || 1)}</span></div>
      <div class="ngsplit"><div id="ngOut">${empty(t('Carregando…'))}</div><div id="ngPages"></div></div>`;
  },
  anchors: (d) => {
    const agg = new Map();
    for (const l of d.links.inlinks.filter((x) => x.kind === 'a')) {
      const k = (l.anchor || '').trim() || t('(sem texto)');
      const a = agg.get(k) || { n: 0, pos: new Map() };
      a.n++;
      a.pos.set(l.position || '', (a.pos.get(l.position || '') || 0) + 1);
      agg.set(k, a);
    }
    if (!agg.size) return empty('Nenhum link interno aponta para esta URL.');
    return '<table><thead><tr><th>Texto âncora de entrada</th><th class="num">Links</th><th>Posições</th></tr></thead><tbody>' +
      [...agg].sort((a, b) => b[1].n - a[1].n).map(([k, a]) => `<tr><td class="nt">${esc(k)}</td><td class="num">${a.n}</td><td>${[...a.pos].map(([p, n]) => `${esc(t(p || '?'))} (${n})`).join(', ')}</td></tr>`).join('') + '</tbody></table>';
  },
  images: (d) => imageDetails(d),
  serp: (d) => {
    const r = d.record;
    let crumbs = r.url;
    try { const u = new URL(r.url); crumbs = u.host + u.pathname.split('/').filter(Boolean).map((s) => ' › ' + s).join(''); } catch {}
    return `<div class="serp"><div class="s-url">${esc(crumbs)}</div>
      <div class="s-title">${esc(truncPx(r.title || '(sem title)', 580, '20px Arial'))}</div>
      <div class="s-desc">${esc(truncPx(r.meta_desc || '(sem meta description — o Google gera um trecho da página)', 920 * 2, '14px Arial'))}</div></div>
      <div class="serp-meta">Title: ${r.title_len} caracteres · ${r.title_px}px de 580px — Description: ${r.md_len} caracteres · ${r.md_px}px de 920px</div>`;
  },
  headers: (d) => (Object.keys(d.headers).length ? kvTable(d.headers) : empty('Sem cabeçalhos.')) +
    (d.mixed.length ? `<h4 class="sec">Conteúdo misto (${d.mixed.length})</h4><table><tbody>${d.mixed.map((u) => `<tr><td class="s4">${esc(u)}</td></tr>`).join('')}</tbody></table>` : ''),
  structured: (d) => {
    let h = d.structured.length ? d.structured.map((s) => {
      let raw = s.raw;
      try { raw = JSON.stringify(JSON.parse(s.raw), null, 2); } catch {}
      return `<div class="sd-item"><b>${s.format}</b> — ${esc(s.types.join(', ') || '(sem @type)')}
        ${s.error ? `<div class="s4">Erro de sintaxe: ${esc(s.error)}</div>` : ''}
        ${(s.entities || []).map((en) => `<div class="sdent"><b translate="no">${esc(en.type)}</b>
          ${en.errors.length ? `<ul class="s4">${en.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${en.warnings.length ? `<ul class="s3">${en.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${!en.errors.length && !en.warnings.length ? '<div class="s2">Válido</div>' : ''}</div>`).join('')}
        ${raw ? `<pre>${esc(raw)}</pre>` : ''}</div>`;
    }).join('') : empty('Nenhum dado estruturado encontrado.');
    if (Object.keys(d.og).length) h += '<h4 class="sec">Open Graph</h4>' + kvTable(d.og);
    return h;
  },
  dups: (d) => {
    let h = '';
    if (d.exact_dups.length) h += `<h4 class="sec">Duplicados exatos (${d.exact_dups.length})</h4><table><tbody>${d.exact_dups.map((u) => `<tr><td><a class="link" data-goto="${esc(u)}">${esc(u)}</a></td></tr>`).join('')}</tbody></table>`;
    if (!DATA.finalized) h += empty('Os quase duplicados são calculados na Análise de crawl, ao final do rastreamento.');
    else if (d.near_dups.length) h += `<h4 class="sec">Quase duplicados (${d.near_dups.length})</h4><table><thead><tr><th>URL</th><th class="num">Similaridade</th></tr></thead><tbody>${d.near_dups.map((n) => `<tr><td><a class="link" data-goto="${esc(n.url)}">${esc(n.url)}</a></td><td class="num">${n.similarity}%</td></tr>`).join('')}</tbody></table>`;
    return h || empty('Nenhum duplicado encontrado.');
  },
  redirects: (d) => !d.chain.length ? empty('Esta URL não redireciona.') :
    `<table><thead><tr><th>#</th><th>URL</th><th class="num">Código</th></tr></thead><tbody>${d.chain.map((c, i) => `<tr><td class="idx">${i}</td><td><a class="link" data-goto="${esc(c.url)}">${esc(c.url)}</a></td><td class="num">${statusCell(c.status)}</td></tr>`).join('')}</tbody></table>` +
    (d.loop ? '<div class="empty s4">Loop de redirecionamento detectado.</div>' : ''),
  hreflang: (d) => !d.hreflang.length ? empty('Nenhuma anotação hreflang.') :
    `<table><thead><tr><th>Idioma</th><th>URL</th><th class="num">Código</th><th>Link de retorno</th></tr></thead><tbody>${d.hreflang.map((h) => `<tr><td>${esc(h.lang)}</td><td><a class="link" data-goto="${esc(h.url)}">${esc(h.url)}</a></td><td class="num">${statusCell(h.status)}</td><td>${h.returns == null ? '<span class="muted">não rastreada</span>' : h.returns ? '<span class="s2">Sim</span>' : '<span class="s4">Não</span>'}</td></tr>`).join('')}</tbody></table>`,
  semantic: (d) => {
    const r = d.record;
    let h = r.semantic_relevance == null ? empty('Calculado na Análise de crawl (página HTML indexável com texto).') :
      kvTable({ 'Relevância para o site': r.semantic_relevance, 'Baixa relevância': r.low_relevance ? 'Sim' : 'Não', 'Página mais próxima': r.semantic_closest, 'Similaridade máxima': r.semantic_max });
    if (d.semantic.length) h += `<h4 class="sec">Semanticamente similares (${d.semantic.length})</h4><table><thead><tr><th>URL</th><th class="num">Similaridade</th></tr></thead><tbody>${d.semantic.map((s) => `<tr><td><a class="link" data-goto="${esc(s.url)}">${esc(s.url)}</a></td><td class="num">${s.score.toFixed(3)}</td></tr>`).join('')}</tbody></table>`;
    return h;
  },
  spelling: (d) => {
    const r = d.record;
    let h = '';
    if (r.spelling_errors == null) h += empty('A ortografia é verificada na Análise de crawl (ao fim do rastreamento).');
    else if (!d.spelling.length) h += empty(`Nenhum erro de ortografia (idioma: ${esc(r.spell_lang)}).`);
    else h += `<table><thead><tr><th>Ortografia — palavra (${esc(r.spell_lang)})</th><th>Sugestão</th></tr></thead><tbody>${d.spelling.map((s) => `<tr><td class="s4 nt">${esc(s.word)}</td><td class="nt">${esc(s.suggestion)}</td></tr>`).join('')}</tbody></table>`;
    if (d.grammar == null) h += '<div class="rnote">Gramática não verificada — use “Verificar gramática” na aba Ortografia e gramática do painel direito.</div>';
    else if (!d.grammar.length) h += empty('Nenhum erro de gramática.');
    else h += `<h4 class="sec">Gramática (${d.grammar.length})</h4><table><thead><tr><th>Problema</th><th>Contexto</th><th>Sugestões</th></tr></thead><tbody>${d.grammar.map((g) => {
      const c = g.context || '';
      const ctx = esc(c.slice(0, g.offset)) + '<b class="s4">' + esc(c.slice(g.offset, g.offset + g.length)) + '</b>' + esc(c.slice(g.offset + g.length));
      return `<tr><td class="nt">${esc(g.message)}</td><td class="nt">${ctx}</td><td>${esc(g.suggestions.join(', '))}</td></tr>`;
    }).join('')}</tbody></table>`;
    return h;
  },
  source: (d) => sourceView(d, false),
  rendered: (d) => sourceView(d, true),
  psi: (d) => {
    const r = d.record;
    const card = (l, v, cls = '') => `<div class="card">${l}<b class="${cls}">${v ?? '—'}</b></div>`;
    return `<div class="psi"><div><button class="tbtn" data-psi="mobile">▶ Analisar (mobile)</button> <button class="tbtn" data-psi="desktop">▶ Analisar (desktop)</button>
      ${r.psi_strategy ? `<span class="muted">Última análise: ${r.psi_strategy}</span>` : ''}</div>
      ${r.psi_error ? `<div class="s4">${esc(r.psi_error)}</div>` : ''}
      <div class="scores">${card('Performance', r.psi_score, scoreCls(r.psi_score))}${card('LCP (s)', r.psi_lcp)}${card('FCP (s)', r.psi_fcp)}${card('CLS', r.psi_cls)}${card('TBT (ms)', r.psi_tbt)}${card('Speed Index (s)', r.psi_si)}</div>
      <div class="muted">Dados reais de usuários (CrUX, quando houver):</div>
      <div class="scores">${card('LCP (ms)', r.psi_field_lcp)}${card('INP (ms)', r.psi_field_inp)}${card('CLS', r.psi_field_cls)}</div>
      ${(d.psi_audits || []).length ? `<h4 class="sec">${t('Oportunidades e diagnósticos (Lighthouse)')}</h4><table><thead><tr><th>${t('Auditoria')}</th><th>${t('Tipo')}</th><th>${t('Valor')}</th><th class="num">${t('Economia (ms)')}</th><th class="num">Score</th></tr></thead><tbody>` +
        d.psi_audits.map((a) => `<tr><td class="nt">${esc(a.title)} <span class="muted">(${esc(a.id)})</span></td><td>${t(a.kind)}</td><td class="nt">${esc(a.display)}</td><td class="num">${a.savings_ms || ''}</td><td class="num"><b class="${scoreCls(a.score * 100)}">${Math.round(a.score * 100)}</b></td></tr>`).join('') + '</tbody></table>' : ''}</div>`;
  },
  cookies: (d) => (d.cookies.length ? `<table><thead><tr><th>${t('Nome do cookie')}</th><th>${t('Domínio')}</th><th>${t('Caminho')}</th><th>${t('Expira')}</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th></tr></thead><tbody>` +
    d.cookies.map((c) => `<tr><td class="nt">${esc(c.name)}</td><td>${esc(c.domain)}</td><td>${esc(c.path)}</td><td>${esc(tv(c.expires))}</td><td>${yes(c.secure)}</td><td>${yes(c.httponly)}</td><td>${esc(c.samesite)}</td></tr>`).join('') + '</tbody></table>'
    : empty(t('Nenhum cookie definido por cabeçalho Set-Cookie nesta URL.'))),
  a11y: (d) => {
    const r = d.record;
    if (r.a11y_error) return empty(esc(r.a11y_error));
    if (r.a11y_rules == null) return empty(t('Ative “Auditar acessibilidade” em Configuração > Spider e rastreie de novo.'));
    if (!d.a11y.length) return empty(t('Nenhuma violação encontrada pelo axe-core.'));
    return `<table><thead><tr><th>${t('Regra')}</th><th>${t('Impacto')}</th><th>${t('Descrição')}</th><th class="num">${t('Elementos')}</th><th>${t('Seletores')}</th></tr></thead><tbody>` +
      d.a11y.map((v) => `<tr><td><a href="${esc(v.helpUrl)}" target="_blank" rel="noopener">${esc(v.id)}</a></td><td class="imp-${esc(v.impact)}">${t(IMPACT[v.impact] || v.impact)}</td><td class="nt">${esc(v.help)}</td><td class="num">${v.nodes}</td><td class="nt"><code>${v.targets.map(esc).join('<br>')}</code></td></tr>`).join('') + '</tbody></table>';
  },
};

const IMPACT = { critical: 'Crítica', serious: 'Grave', moderate: 'Moderada', minor: 'Menor' };
function detailStatus() {
  const n = $$('#detailBody tbody tr').filter((tr) => !tr.hidden).length;
  $('#detailStatus').textContent = tf('Células selecionadas: 0   Total: {{0}}', n);
}

// ---------- Inlinks / Outlinks / Resources: filter bar + full link table ----------
const LF = { type: '', origin: '', view: 'all', show: { internal: true, external: true, follow: true, nofollow: true, self: true } };
const SHOW_LABELS = { internal: 'Internos', external: 'Externos', follow: 'Follow', nofollow: 'Nofollow', self: 'Autorreferentes' };
// full link type list (always shown in the filter, like the reference)
const LINK_TYPES = ['Hiperlink', 'JavaScript', 'CSS', 'Imagem', 'SWF', 'Canonical HTML', 'Canonical HTTP', 'Rel Prev HTML', 'Rel Prev HTTP',
  'Rel Next HTML', 'Rel Next HTTP', 'Hreflang HTTP', 'Hreflang HTML', 'Hreflang da sitemap', 'Redirecionamento HTTP', 'Redirecionamento HSTS',
  'Redirecionamento JavaScript', 'Redirecionamento meta refresh', 'Redirecionamento HTTP Refresh', 'Sitemap XML', 'AMPHTML', 'Alternate mobile',
  'Iframe', 'Diversos', 'PDF', 'Vídeo', 'Áudio', 'Fonte'];
const EXT_TYPE = [[/\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)(\?|$)/i, 'Imagem'], [/\.css(\?|$)/i, 'CSS'], [/\.m?js(\?|$)/i, 'JavaScript'],
  [/\.(woff2?|ttf|otf|eot)(\?|$)/i, 'Fonte'], [/\.(mp4|webm|ogv|mov|m4v)(\?|$)/i, 'Vídeo'], [/\.(mp3|wav|ogg|m4a|aac)(\?|$)/i, 'Áudio'],
  [/\.swf(\?|$)/i, 'SWF'], [/\.pdf(\?|$)/i, 'PDF']];
const byExt = (u) => (EXT_TYPE.find(([re]) => re.test(u)) || [, ''])[1];
function linkType(l) {
  const src = PAGE.get(l.src) || {};
  switch (l.kind) {
    case 'a': case 'uncrawlable': return l.position === 'PDF' ? 'PDF' : 'Hiperlink';
    case 'img': return 'Imagem';
    case 'iframe': return 'Iframe';
    case 'canonical': return src.canonical_header && src.canonical_header === l.dst && src.canonical !== l.dst ? 'Canonical HTTP' : 'Canonical HTML';
    case 'pagination': return src.pag_prev === l.dst ? 'Rel Prev HTML' : 'Rel Next HTML';
    case 'hreflang': return 'Hreflang HTML';
    case 'amphtml': return 'AMPHTML';
    case 'alternate': return 'Alternate mobile';
    case 'meta_refresh': return 'Redirecionamento meta refresh';
    case 'redirect': return src.js_redirect && src.js_redirect === l.dst && !src.redirect_url ? 'Redirecionamento JavaScript' : 'Redirecionamento HTTP';
    case 'resource': {
      const c = { images: 'Imagem', js: 'JavaScript', css: 'CSS', swf: 'SWF' }[l.cat];
      if (c) return c;
      const e = byExt(l.dst);
      if (l.cat === 'media') return e === 'Áudio' ? 'Áudio' : 'Vídeo';
      return e || 'Diversos';
    }
    default: return 'Diversos';
  }
}
const linkOrigin = (l) => l.origin || 'HTML';
const recOf = (u) => PAGE.get(u) || DATA.external.find((e) => e.url === u) || DATA.images.find((i) => i.url === u);
function linkView(list, mode) {
  const other = mode === 'in' ? 'src' : 'dst';
  const types = LINK_TYPES;
  const origins = ['HTML renderizado', 'HTML', 'HTML e HTML renderizado', 'Carregado dinamicamente'];   // fixed list, like the reference
  const sh = LF.show, nOn = Object.values(sh).filter(Boolean).length;
  $('#dtools').innerHTML = `<select class="dsel" data-lf="type"><option value="">${t('Todos os tipos de link')}</option>${types.map((x) => `<option value="${esc(x)}" ${x === LF.type ? 'selected' : ''}>${esc(t(x))}</option>`).join('')}</select>
    <select class="dsel" data-lf="origin"><option value="">${t('Todas as origens de link')}</option>${origins.map((x) => `<option value="${esc(x)}" ${x === LF.origin ? 'selected' : ''}>${esc(t(x))}</option>`).join('')}</select>
    <button type="button" class="tbtn dsel" data-lshow>${tf('Mostrar links ({{0}}/5)', nOn)} ▾</button>
    <select class="dsel" data-lf="view"><option value="all" ${LF.view === 'all' ? 'selected' : ''}>${t('Todos os links')}</option><option value="anchors" ${LF.view === 'anchors' ? 'selected' : ''}>${t('Âncoras')}</option></select>`;
  const rows = list.filter((l) => (!LF.type || linkType(l) === LF.type) && (!LF.origin || linkOrigin(l) === LF.origin)
    && (l.internal ? sh.internal : sh.external) && (l.nofollow ? sh.nofollow : sh.follow) && (l.src !== l.dst || sh.self));
  const rank = (l) => (l.kind === 'a' || l.kind === 'uncrawlable' ? 0 : l.kind === 'img' ? 1 : 2);   // hyperlinks first, then images, then the rest
  rows.sort((x, y) => rank(x) - rank(y));
  if (!rows.length) return empty(t('Nenhum link encontrado.'));
  if (LF.view === 'anchors') {
    const g = new Map();
    for (const l of rows) {
      const k = l.alt && l.anchor === l.alt ? '' : l.anchor || '';
      const e = g.get(k) || { n: 0, urls: new Set(), follow: 0, nofollow: 0 };
      e.n++; e.urls.add(l[other]); l.nofollow ? e.nofollow++ : e.follow++;
      g.set(k, e);
    }
    const lbl = mode === 'in' ? 'Inlinks' : 'Outlinks';
    return `<table class="atable"><thead><tr><th>${t('Texto âncora')}</th><th class="num">${t(lbl)}</th><th class="num">${t(lbl + ' únicos')}</th><th class="num">${t('% do total')}</th><th class="num">Follow</th><th class="num">Nofollow</th></tr></thead><tbody>` +
      [...g.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, e]) => `<tr><td class="nt">${k ? esc(k) : `<span class="muted">${t('(sem texto âncora)')}</span>`}</td><td class="num">${e.n}</td><td class="num">${e.urls.size}</td><td class="num">${(e.n / rows.length * 100).toFixed(2)}%</td><td class="num">${e.follow}</td><td class="num">${e.nofollow}</td></tr>`).join('') + '</tbody></table>';
  }
  const cols = LINK_COLS;
  const width = cols.reduce((n, [k, w]) => n + (LCOL_W[k] || w), 0);
  const fmtB = (b) => (b == null || b === '' ? '0 B' : b < 1000 ? `${b} B` : `${(b / 1000).toFixed(1)} kB`);   // unknown size → 0 B, like the reference
  const cell = {
    'Tipo': (l) => esc(t(linkType(l))),
    'De': (l) => `<a class="link" data-goto="${esc(l.src)}">${esc(l.src)}</a>`,
    'Para': (l) => `<a class="link" data-goto="${esc(l.dst)}">${esc(l.dst)}</a>`,
    'Texto âncora': (l) => esc(l.alt && l.anchor === l.alt ? '' : l.anchor || ''),
    'Texto alt': (l) => esc(l.alt || ''),
    'Follow': (l) => (l.nofollow ? 'False' : 'True'),
    'Target': (l) => esc(l.target || ''),
    'Rel': (l) => esc(l.rel || ''),
    'Código de status': (l) => statusCell(l.status),
    'Status': (l) => esc(t(recOf(l[other])?.status_text || '')),
    'Rastreabilidade do link': (l) => esc(t(l.kind === 'uncrawlable' ? 'Não rastreável' : 'Rastreável')),
    'Tipo de caminho': (l) => esc(t(l.path_type || '')),
    'Caminho do link': (l) => esc((l.link_path || '').replace(/^\/html\//, '//')),
    'Posição do link': (l) => esc(t(l.position || '')),
    'Origem do link': (l) => esc(t(linkOrigin(l))),
    'Tamanho': (l) => fmtB(recOf(l[other])?.size),
    'Transferido': (l) => fmtB(recOf(l[other])?.transferred),
  };
  const tdAttr = (k, l) => (k === 'Código de status' ? ' class="num"' : k === 'Rastreabilidade do link' && l.kind === 'uncrawlable' ? ` class="s4" title="${esc(l.via || '')}"` : '');
  return `<table class="ltable" style="width:${width}px"><colgroup>${cols.map(([k, w]) => `<col data-k="${esc(k)}" style="width:${LCOL_W[k] || w}px">`).join('')}</colgroup>` +
    `<thead><tr>${cols.map(([k], i) => `<th class="${k === 'Código de status' ? 'num' : ''}">${t(k)}<span class="rz" data-rz="${i}"></span></th>`).join('')}</tr></thead><tbody>` +
    rows.map((l) => `<tr>${cols.map(([k]) => `<td${tdAttr(k, l)}>${cell[k](l)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
}
// link table columns (reference order) with default widths; widths are user-resizable and remembered
const LINK_COLS = [['Tipo', 110], ['De', 260], ['Para', 260], ['Texto âncora', 170], ['Texto alt', 130], ['Follow', 70], ['Target', 80],
  ['Rel', 100], ['Código de status', 105], ['Status', 90], ['Rastreabilidade do link', 150], ['Tipo de caminho', 130], ['Caminho do link', 280],
  ['Posição do link', 120], ['Origem do link', 120], ['Tamanho', 90], ['Transferido', 100]];
const LCOL_W = (() => { try { return JSON.parse(localStorage.getItem('seo-spider-link-cols') || '{}'); } catch { return {}; } })();
$('#detailBody').addEventListener('mousedown', (e) => {
  const h = e.target.closest('.ltable .rz');
  if (!h) return;
  e.preventDefault();
  const table = h.closest('table'), col = table.querySelectorAll('col')[+h.dataset.rz];
  const x0 = e.clientX, w0 = col.getBoundingClientRect().width || parseFloat(col.style.width), tw0 = table.getBoundingClientRect().width;
  document.body.classList.add('col-resizing');
  const move = (ev) => {
    const w = Math.max(40, Math.round(w0 + ev.clientX - x0));
    col.style.width = w + 'px';
    table.style.width = Math.round(tw0 + w - w0) + 'px';
    LCOL_W[col.dataset.k] = w;
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('col-resizing');
    try { localStorage.setItem('seo-spider-link-cols', JSON.stringify(LCOL_W)); } catch {}
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});
$('#dtools').addEventListener('change', (e) => {
  const s = e.target.closest('[data-lf]');
  if (s) { LF[s.dataset.lf] = s.value; renderDetail(); }
});
$('#dtools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lshow]');
  if (!b) return;
  const r = b.getBoundingClientRect();
  showFloating('#lshowMenu', r.left, r.bottom, Object.entries(SHOW_LABELS).map(([k, l]) =>
    `<label><input type="checkbox" data-lshowk="${k}" ${LF.show[k] ? 'checked' : ''}> ${esc(t(l))}</label>`).join(''));
});
$('#lshowMenu').addEventListener('change', (e) => {
  const k = e.target.dataset.lshowk;
  if (!k) return;
  LF.show[k] = e.target.checked;
  renderDetail();
});

// ---------- Image Details: From/To table + preview with zoom ----------
const IMG = { pick: null, zoom: null };   // pick = image shown in the preview; zoom = null → fit to the pane
const isImageRec = (r) => /^image\//.test(r?.content_type || '') || DATA.images.some((i) => i.url === r?.url);
function imageDetails(d) {
  const r = d.record;
  const own = isImageRec(r);
  const rows = own ? d.links.image_refs : d.links.images;
  if (!own && IMG.page !== r.url) { IMG.page = r.url; IMG.pick = rows[0]?.src || null; IMG.zoom = null; }
  if (own) { IMG.page = r.url; IMG.pick = r.url; }
  const altCell = (a) => (a == null ? `<span class="s4">${t('(sem atributo alt)')}</span>` : a.trim() ? esc(a) : `<span class="s3">${t('(alt vazio)')}</span>`);
  const dims = (i) => (i.w || i.h ? `${esc(i.w || '?')}×${esc(i.h || '?')}` : '');
  const table = rows.length
    ? `<table class="imgtable"><thead><tr><th>${t('De')}</th><th>${t('Para')}</th><th>${t('Texto alt')}</th><th>${t('Dimensões nos atributos (LxA)')}</th><th class="num">${t('Código')}</th><th class="num">${t('Tamanho')}</th></tr></thead><tbody>` +
      rows.map((i) => `<tr data-isrc="${esc(i.src)}" class="${!own && i.src === IMG.pick ? 'on' : ''}"><td class="nt">${own ? `<a class="link" data-goto="${esc(i.page)}">${esc(i.page)}</a>` : esc(i.page)}</td>
        <td class="nt">${own ? `<a class="link" data-goto="${esc(i.src)}">${esc(i.src)}</a>` : esc(i.src)}</td><td class="nt">${altCell(i.alt)}</td><td>${dims(i)}</td>
        <td class="num">${statusCell(i.status)}</td><td class="num">${kB(i.size)}</td></tr>`).join('') + '</tbody></table>'
    : empty(t(own ? 'Nenhuma página com esta imagem.' : 'Nenhuma imagem nesta página.'));
  return `<div class="imgsplit"><div class="imgleft">${table}</div>${imagePreview(IMG.pick)}</div>`;
}
function imagePreview(src) {
  if (!src) return `<div class="imgprev"><div class="empty">${t('Nenhuma imagem selecionada')}</div></div>`;
  return `<div class="imgprev"><div class="imgbar"><button type="button" class="tbtn" data-izoom="-" title="${t('Diminuir zoom')}">−</button><button type="button" class="tbtn" data-izoom="+" title="${t('Aumentar zoom')}">+</button>
    <span id="izLabel">${t('Zoom')}: …</span><span id="izDims" class="muted"></span></div>
    <div class="imgbox" id="izBox"><img id="izImg" src="${esc(src)}" alt="" referrerpolicy="no-referrer"></div></div>`;
}
function applyZoom() {
  const img = $('#izImg'), box = $('#izBox');
  if (!img || !img.naturalWidth) return;
  if (IMG.zoom == null) IMG.zoom = Math.min(1, (box.clientWidth - 16) / img.naturalWidth) || 1;   // fit to the pane width
  img.style.width = Math.max(1, Math.round(img.naturalWidth * IMG.zoom)) + 'px';
  $('#izLabel').textContent = `${t('Zoom')}: ${Math.round(IMG.zoom * 100)}%`;
  $('#izDims').textContent = `${t('Dimensões reais')}: ${img.naturalWidth}×${img.naturalHeight}`;
}
document.addEventListener('load', (e) => { if (e.target.id === 'izImg') applyZoom(); }, true);
document.addEventListener('error', (e) => {
  if (e.target.id === 'izImg') $('#izBox').innerHTML = empty(t('Não foi possível exibir a imagem'));
}, true);
$('#detailBody').addEventListener('click', (e) => {
  const z = e.target.closest('[data-izoom]');
  if (z) {
    const steps = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
    const cur = IMG.zoom || 1;
    IMG.zoom = z.dataset.izoom === '+' ? (steps.find((s) => s > cur + 0.001) || 4) : ([...steps].reverse().find((s) => s < cur - 0.001) || 0.1);
    applyZoom();
    return;
  }
  const tr = e.target.closest('tr[data-isrc]');
  if (tr && !e.target.closest('a') && !isImageRec(selectedRecord())) {
    IMG.pick = tr.dataset.isrc;
    IMG.zoom = null;
    $$('#detailBody tr[data-isrc]').forEach((x) => x.classList.toggle('on', x === tr));
    $('#detailBody .imgprev').outerHTML = imagePreview(IMG.pick);
    if ($('#izImg')?.complete) applyZoom();
  }
});

async function renderDetail() {
  const body = $('#detailBody');
  const rec = selectedRecord();
  const tabs = !rec || PAGE.has(rec.url) ? PAGE_DTABS
    : isImageRec(rec) ? { details: 'Detalhes da URL', inlinks: 'Inlinks', images: 'Detalhes da imagem' } : { details: 'Detalhes da URL', inlinks: 'Inlinks' };
  if (!tabs[S.detail]) S.detail = 'details';
  $('#dtabs').innerHTML = Object.entries(tabs).map(([k, l]) => `<button data-dtab="${k}" class="${k === S.detail ? 'active' : ''}">${l}</button>`).join('');
  if (!rec) {
    $('#dtools').innerHTML = '';
    body.innerHTML = '<table class="kv"><thead><tr><th>Nome</th><th>Valor</th></tr></thead></table><div class="empty big">Nenhuma URL selecionada</div>';
    detailStatus();
    return;
  }
  const url = rec.url;
  let d = detailCache.get(url);
  if (!d) {
    body.innerHTML = empty('Carregando…');
    const r = await fetch('/api/url?url=' + encodeURIComponent(url));
    if (!r.ok) { body.innerHTML = empty('Sem dados.'); return; }
    d = await r.json();
    detailCache.set(url, d);
    if (S.sel !== url) return;
  }
  if (!['inlinks', 'outlinks', 'resources'].includes(S.detail)) $('#dtools').innerHTML = '';
  body.innerHTML = DETAIL[S.detail](d);
  filterDetail();
  if ($('#izImg')?.complete) applyZoom();
}

function filterDetail() {
  const q = $('#detailSearch').value;
  const m = q ? matcher(q) : null;
  const am = window.ADV?.detailMatcher();
  $$('#detailBody tbody tr').forEach((tr) => { tr.hidden = (!!q && !(m && m(tr.textContent))) || (!!am && !am(tr)); });
  syncSearchOpts();
  detailStatus();
}

function gotoUrl(u) {
  const where = PAGE.has(u) ? 'internal' : DATA.external.some((e) => e.url === u) ? 'external' : DATA.images.some((i) => i.url === u) ? 'images' : null;
  if (!where) return;
  $('#vizModal').hidden = true;
  Object.assign(S, { q: '' });
  $('#search').value = '';
  setView(where);
  S.sel = u; S.multi = new Set([u]); S.anchor = u;
  paintSelection();
  renderDetail();
  $('#grid tr.cur')?.scrollIntoView({ block: 'center' });
}

function renderAll() { renderTabs(); renderTable(); renderRight(); renderDetail(); }

// ---------- crawl control ----------
let polling = false;
let lastData = 0;
let lastStatus = null;
let rateRef = null;

function setRunning(running) {
  const b = $('#startBtn');
  b.textContent = running ? '■ Parar' : '▶ Iniciar';
  b.classList.toggle('stop', running);
  b.dataset.running = running ? '1' : '';
}

function renderProgress(st) {
  if (st.status === 'empty') return;
  const p = st.discovered ? Math.floor((st.crawled / st.discovered) * 100) : 0;
  const shown = st.status === 'running' ? p : 100;
  $('#bar').style.width = shown + '%';
  $('#barText').textContent = st.status === 'running' && st.phase && !st.phase.startsWith('Rastreando') ? t(st.phase) : tf('Crawl {{0}}%', shown);
  if (st.analysis?.running) {
    const ap = st.analysis.total ? Math.floor((st.analysis.done / st.analysis.total) * 100) : 0;
    $('#bar').style.width = ap + '%';
    $('#barText').textContent = tf('Análise {{0}}%', ap);
  }
  $('#crawlbar').title = t(st.phase || '');
  const now = Date.now();
  let cur = 0;
  if (rateRef && st.status === 'running') cur = Math.max(0, (st.crawled - rateRef.n) / ((now - rateRef.t) / 1000));
  rateRef = { n: st.crawled, t: now };
  const state = { running: t('Rastreando'), finished: t('Ocioso'), stopped: t('Parado'), error: tf('Erro — {{0}}', st.error) }[st.status] || st.status;
  const modeName = t(st.mode === 'list' ? 'Lista' : 'Spider');
  $('#sbMode').textContent = tf('Modo {{0}}: {{1}}', modeName, state) + (st.render_js ? ' ' + t('(JS renderizado)') : '') +
    (st.psi?.running ? ` · PageSpeed ${st.psi.done}/${st.psi.total}` : '') + (st.grammar?.running ? ' · ' + tf('Gramática: {{0}}/{{1}}', st.grammar.done, st.grammar.total) : '');
  $('#sbRate').textContent = tf('Média: {{0}} URL/s. Atual: {{1}} URL/s.', st.rate.toFixed(2), cur.toFixed(2));
  $('#sbDone').textContent = tf('Concluído {{0}} de {{1}} ({{2}}%) {{3}} restantes', st.crawled, st.discovered, p, st.discovered - st.crawled);
  const ss = st.start_status;
  if (st.status !== 'running' && ss != null && (ss === 0 || ss >= 400)) {
    const why = tv(st.start_status_text) || `HTTP ${ss}`;
    const code = ss || t('sem resposta');
    $('#barText').textContent = tf('Página inicial: {{0}}', code);
    $('#sbMode').textContent = tf('Modo {{0}}: {{1}}', t(st.mode === 'list' ? 'Lista' : 'Spider'), tf('página inicial não abriu ({{0}})', why));
    if (st.mode === 'spider' && warnedStart !== st.start_url + st.elapsed) {
      warnedStart = st.start_url + st.elapsed;
      const waf = /WAF/.test(st.start_status_text || '');
      alert(tf('A página inicial ({{0}}) respondeu {{1}} — {{2}}.', st.start_url, code, why) + '\n\n' +
        t(waf ? 'O firewall do site recusou a conexão. O crawler já tenta novamente abrindo a página em um navegador real (Chromium), porque muitos firewalls bloqueiam pela assinatura TLS do cliente HTTP, não pelo seu IP. Se mesmo assim falhar, o site exige login, bloqueia a região ou exige liberação explícita do dono do site.'
          : 'Sem a página inicial o crawler não encontra links para seguir. Confira a URL, o robots.txt ou o User-Agent em Configuração → Geral.'));
    }
  }
}
let warnedStart = null;

async function loadData() {
  const r = await fetch('/api/data');
  if (!r.ok) return;
  DATA = await r.json();
  window.DATA = DATA;   // mesma referencia, lida pelo inspetor da Extração Visual
  PAGE = new Map(DATA.pages.map((p) => [p.url, p]));
  applySegments();
  detailCache.clear();
  renderTabs(); renderTable(); renderRight();
  if (['details', 'psi', 'dups'].includes(S.detail)) renderDetail();
  if (!$('#vizModal').hidden) renderViz();
}

let loadCost = 0;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const st = await fetch('/api/status').then((r) => r.json()).catch(() => null);
      if (!st || st.status === 'empty') { setRunning(false); break; }
      window.onStatus?.(st, lastStatus);
      lastStatus = st;
      renderProgress(st);
      const running = st.status === 'running';
      const busy = running || st.analysis?.running || st.psi?.running || st.grammar?.running || Object.values(st.integrations || {}).some((x) => x.running);
      if (S.rtab === 'api') renderRight();
      setRunning(running);
      // big crawls: reload the full data less often (interval grows with the time a reload takes)
      if (!busy || Date.now() - lastData > Math.max(2500, loadCost * 4)) {
        const t0 = Date.now();
        await loadData();
        loadCost = Date.now() - t0;
        lastData = Date.now();
      }
      if (!busy) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
  } finally { polling = false; }
}

// ---------- config ----------
function parseCustomSearch(text) {
  const yesNo = (v, a, b) => (/^(n|não|nao|not|no)/i.test(v.trim()) ? b : a);
  const caseOn = $('[name=custom_search_case]')?.checked;
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const p = l.split('|');
    if (p.length < 5) return null;
    return { name: p[0].trim(), mode: yesNo(p[1], 'contains', 'not_contains'), type: /regex/i.test(p[2]) ? 'regex' : 'text',
      where: /^(texto|text)/i.test(p[3].trim()) ? 'text' : 'html', query: p.slice(4).join('|').trim(), case: !!caseOn };
  }).filter((x) => x && x.query);
}
function parseExtractors(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const p = l.split('|');
    const name = (p[0] || '').trim();
    const type = (p[1] || '').trim().toLowerCase();
    const rest = p.slice(2);
    const attr = type !== 'regex' && rest.length > 1 ? rest.pop().trim() : '';
    return { name, type: ['css', 'xpath', 'regex'].includes(type) ? type : 'css', expr: rest.join('|').trim(), attr };
  }).filter((e) => e.expr);
}
const formFields = () => $$('#crawlForm [name], #cfgModal [name], #listModal [name], #robotsModal [name]');
function readConfig() {
  const cfg = {};
  for (const el of formFields()) {
    if (el.type === 'checkbox') cfg[el.name] = el.checked;
    else if (el.type === 'number') cfg[el.name] = Number(el.value);
    else if ('json' in el.dataset) { try { cfg[el.name] = JSON.parse(el.value || 'null') ?? (el.name === 'auth_entries' ? [] : {}); } catch { cfg[el.name] = el.name === 'auth_entries' ? [] : {}; } }
    else if ('lines' in el.dataset) cfg[el.name] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else if ('extractors' in el.dataset) cfg[el.name] = parseExtractors(el.value);
    else if ('customsearch' in el.dataset) cfg[el.name] = parseCustomSearch(el.value);
    else cfg[el.name] = el.value.trim();
  }
  cfg.analysis = Object.keys(cfg).filter((k) => k.startsWith('analysis_') && cfg[k]).map((k) => k.slice(9));
  for (const k of Object.keys(cfg)) if (k.startsWith('analysis_')) delete cfg[k];
  cfg.custom_js = SNIPPETS.map(({ name, type, content_type, timeout, code }) => ({ name, type, content_type, timeout: Number(timeout) || 10, code }));
  window.cfgPost?.(cfg);
  return cfg;
}
function saveConfig() {
  const raw = {};
  for (const el of formFields()) if (!('nosave' in el.dataset)) raw[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  store.set('seo-spider-cfg3', raw);
}
function loadConfig() {
  const raw = store.get('seo-spider-cfg3', null);
  if (raw) {
    for (const el of formFields()) {
      if (!(el.name in raw)) continue;
      if (el.type === 'checkbox') el.checked = raw[el.name]; else el.value = raw[el.name];
    }
  }
  window.cfgSync?.();
}
function setMode(mode) {
  $('#mode').value = mode;
  syncMode();
  saveConfig();
}
function syncMode() {
  const list = $('#mode').value === 'list';
  $('#urlBox').hidden = list;
  $('#listBtn').hidden = !list;
  $('#modeSpider').classList.toggle('on', !list);
  $('#modeList').classList.toggle('on', list);
  const n = $('[name=url_list]').value.split('\n').filter((s) => s.trim()).length;
  $('#listCount').textContent = `(${n} URLs)`;
  if (!$('#startBtn').dataset.running) $('#sbMode').textContent = tf('Modo {{0}}: {{1}}', t(list ? 'Lista' : 'Spider'), t('Ocioso'));
}

// ---------- layout ----------
function applyLayout() {
  const l = store.get('seo-spider-layout', {});
  const ws = $('#ws');
  if (l.rightW) ws.style.setProperty('--right-w', l.rightW + 'px'); else ws.style.removeProperty('--right-w');
  if (l.bottomH) ws.style.setProperty('--bottom-h', l.bottomH + 'px'); else ws.style.removeProperty('--bottom-h');
  ws.classList.toggle('noright', !!l.noright);
  ws.classList.toggle('nobottom', !!l.nobottom);
}
function updateLayout(patch) { store.set('seo-spider-layout', { ...store.get('seo-spider-layout', {}), ...patch }); applyLayout(); }
function initSplit(el, axis) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    let val;
    const move = (ev) => {
      if (axis === 'v') {
        val = Math.round(Math.min(Math.max($('#ws').getBoundingClientRect().right - ev.clientX, 260), window.innerWidth - 420));
        $('#ws').style.setProperty('--right-w', val + 'px');
      } else {
        const box = $('.left').getBoundingClientRect();
        val = Math.round(Math.min(Math.max(box.bottom - ev.clientY, 90), box.height - 160));
        $('#ws').style.setProperty('--bottom-h', val + 'px');
      }
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (val) updateLayout(axis === 'v' ? { rightW: val } : { bottomH: val });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ---------- floating menus ----------
function showFloating(id, x, y, html) {
  const m = $(id);
  m.innerHTML = html;
  m.classList.add('show');
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 4) + 'px';
  m.style.top = Math.min(y, window.innerHeight - h - 4) + 'px';
}
function closeFloating() {
  $$('.dropdown.floating, .dropdown.hist').forEach((m) => m.classList.remove('show'));
  $$('.menu.open').forEach((m) => m.classList.remove('open'));
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.dropdown, .menu, .tabmore, [data-addcol], #urlHist')) closeFloating();
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'E' || e.key === 'e') && !e.target.closest('input, textarea, select')) {
    e.preventDefault();
    window.EXTRACT?.open(S.sel || undefined);
    return;
  }
  if (e.key === 'Escape') { closeFloating(); $$('.modal').forEach((m) => { m.hidden = true; }); }
});

function download(url) { const a = document.createElement('a'); a.href = url + (url.includes('?') ? '&' : '?') + 'lang=' + LANG; a.click(); }

function exportCsv(rows, cols, name) {
  const q = (v) => `"${String(Array.isArray(v) ? v.join('; ') : v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map((c) => q(t(c.label))).join(',')].concat(rows.map((r) => cols.map((c) => q(r[c.key])).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
const exportCurrent = () => exportCsv(ROWS, visibleCols(), `seo-spider-${S.tab}-${S.custom ? 'problema' : S.filter}`);

async function runPsi(body) {
  const r = await fetch('/api/psi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '', ...body }) });
  if (!r.ok) { alert(t((await r.json()).detail)); return false; }
  return true;
}

async function clearCrawl() {
  const r = await fetch('/api/clear', { method: 'POST' });
  if (!r.ok) { alert(t((await r.json()).detail)); return; }
  DATA = EMPTY();
  PAGE = new Map();
  rateRef = null;
  Object.assign(S, { sel: null, multi: new Set(), custom: null });
  $('#bar').style.width = '0';
  $('#barText').textContent = tf('Crawl {{0}}%', 0);
  $('#sbRate').textContent = tf('Média: {{0}} URL/s. Atual: {{1}} URL/s.', 0, 0);
  $('#sbDone').textContent = tf('Concluído {{0}} de {{1}} ({{2}}%) {{3}} restantes', 0, 0, 0, 0);
  syncMode();
  renderAll();
}

function openModal(id) { closeFloating(); $(id).hidden = false; }

const ACTIONS = {
  new: clearCrawl,
  extraction: () => window.EXTRACT?.open(S.sel || undefined),
  xlsx: () => download('/api/export.xlsx'),
  csv: exportCurrent,
  'toggle-right': () => updateLayout({ noright: !$('#ws').classList.contains('noright') }),
  'toggle-bottom': () => updateLayout({ nobottom: !$('#ws').classList.contains('nobottom') }),
  'reset-layout': () => { store.set('seo-spider-layout', {}); applyLayout(); },
  'mode-spider': () => setMode('spider'),
  'mode-list': () => setMode('list'),
  config: (el) => CFGW.open(el?.dataset?.section),
  apicfg: (el) => CFGW.open('api:' + el.dataset.api),
  profload: () => $('#profImport').click(),
  profrecent: (el) => { const p = PROFILES[el.dataset.name]; if (p) { applyRawConfig(p); touchRecent(el.dataset.name); alert(tf('Perfil “{{0}}” carregado.', el.dataset.name)); } },
  profsaveas: () => {
    const name = window.prompt(t('Nome do perfil:'), $('#profSel').value || '');
    if (!name || !name.trim()) return;
    PROFILES[name.trim()] = currentRawConfig();
    store.set('seo-spider-profiles', PROFILES);
    touchRecent(name.trim());
    renderProfiles();
    $('#profSel').value = name.trim();
    $('#profExport').click();
  },
  profdefault: () => { store.set('seo-spider-default-cfg', currentRawConfig()); alert(t('Configuração atual salva como padrão. Ela será carregada sempre que o app abrir.')); },
  profcleardefault: () => {
    if (!confirm(t('Limpar a configuração padrão e voltar às configurações de fábrica?'))) return;
    try { localStorage.removeItem('seo-spider-default-cfg'); } catch {}
    applyRawConfig(FACTORY_CFG);
    alert(t('Configuração padrão removida. As configurações de fábrica foram restauradas.'));
  },
  bulk: (el) => download(`/api/bulk/${el.dataset.kind}.csv`),
  report: (el) => download(`/api/report/${el.dataset.kind}.csv`),
  sitemap: () => openModal('#sitemapModal'),
  robots: () => {
    openModal('#robotsModal');
    if (!$('#robotsUrl').value) $('#robotsUrl').value = DATA.progress?.start_url || $('#url').value || '';
    if (!$('#robotsUa').value) $('#robotsUa').value = $('[name=user_agent]').value;
  },
  why: () => { openModal('#whyModal'); $('#whyUrl').focus(); },
  formauth: () => { openModal('#formAuthModal'); refreshFormAuth(); },
  viz: (el) => { S.viz = el.dataset.viz; openModal('#vizModal'); renderViz(); },
  analyze: async () => {
    const groups = readConfig().analysis;
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups }) });
    if (!r.ok) { alert(t((await r.json()).detail)); return; }
    poll();
  },
  about: () => openModal('#aboutModal'),
  schedule: () => { openModal('#schedModal'); openSchedules(); },
  segreport: () => {
    const defs = applySegments();
    const names = [...new Set(DATA.pages.map((p) => p.segment || SEG_NONE))];
    if (!defs.length) { alert(t('Nenhum segmento configurado (Configuração > Segmentos).')); return; }
    const rows = names.map((n) => {
      const ps = DATA.pages.filter((p) => (p.segment || SEG_NONE) === n);
      const html = ps.filter(isHtml);
      const avg = (k) => (html.length ? Math.round(html.reduce((s, p) => s + (p[k] || 0), 0) / html.length) : '');
      return { segment: n, urls: ps.length, html: html.length, idx: html.filter((p) => p.indexability === 'Indexable').length,
        nonidx: ps.filter((p) => p.indexability === 'Non-Indexable').length, err: ps.filter((p) => p.status >= 400 || p.status === 0).length,
        issues: ps.filter((p) => (p.issues || []).length).length, words: avg('word_count'), ms: avg('response_ms'), inl: avg('unique_inlinks') };
    });
    exportCsv(rows, [['segment', 'Segmento'], ['urls', 'URLs'], ['html', 'HTML'], ['idx', 'Indexáveis'], ['nonidx', 'Não indexáveis'],
      ['err', 'Erros (4xx/5xx/sem resposta)'], ['issues', 'URLs com problemas'], ['words', 'Média de palavras'], ['ms', 'Tempo médio de resposta (ms)'],
      ['inl', 'Média de inlinks únicos']].map(([key, label]) => ({ key, label })), 'segmentos');
  },
  crawls: () => { openModal('#crawlsModal'); renderCrawls(); },
  savecrawl: async () => {
    const r = await fetch('/api/crawls/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    alert(r.ok ? t('Crawl salvo.') : t((await r.json().catch(() => ({}))).detail || 'Erro'));
  },
  compare: () => { openModal('#compareModal'); fillCompareSelects(); },
  customjs: () => { openModal('#jsModal'); renderJsModal(); },
  lang: (el) => setLang(el.dataset.lang),
};

// ---------- events ----------
$('#menubar').addEventListener('click', (e) => {
  if (e.target.closest('.has-sub')) return;
  const item = e.target.closest('[data-act]');
  if (item) { closeFloating(); ACTIONS[item.dataset.act]?.(item); return; }
  const menu = e.target.closest('.menu');
  if (!menu) return;
  const wasOpen = menu.classList.contains('open');
  closeFloating();
  if (!wasOpen) menu.classList.add('open');
});
$('#menubar').addEventListener('mouseover', (e) => {
  const menu = e.target.closest('.menu');
  if (menu && $('.menu.open') && !menu.classList.contains('open')) { closeFloating(); menu.classList.add('open'); }
});

$$('.modal').forEach((m) => m.addEventListener('click', (e) => {
  if (e.target === m || e.target.closest('[data-close]')) { m.hidden = true; saveConfig(); syncMode(); applySegments(); renderTable(); renderRight(); }
}));
$('#listBtn').addEventListener('click', () => openModal('#listModal'));
$('#listFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const urls = (await f.text()).match(/https?:\/\/[^\s,;"'<>]+/g) || [];
  $('[name=url_list]').value = [...new Set(urls)].join('\n');
  syncMode();
});
$('[name=url_list]').addEventListener('input', syncMode);

$('#urlClear').addEventListener('click', () => { $('#url').value = ''; $('#url').focus(); });
$('#urlHist').addEventListener('click', () => {
  const m = $('#histMenu');
  if (m.classList.contains('show')) { m.classList.remove('show'); return; }
  const hist = store.get('seo-spider-hist', []);
  m.innerHTML = hist.length ? hist.map((u) => `<a data-hist="${esc(u)}">${esc(u)}</a>`).join('') : '<a class="muted">Sem histórico</a>';
  m.classList.add('show');
});
$('#histMenu').addEventListener('click', (e) => {
  const a = e.target.closest('[data-hist]');
  if (a) { $('#url').value = a.dataset.hist; $('#histMenu').classList.remove('show'); }
});

$('#crawlForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#startBtn').dataset.running) { await fetch('/api/stop', { method: 'POST' }); return; }
  const cfg = readConfig();
  if (cfg.mode === 'spider' && !cfg.start_url) { $('#url').focus(); return; }
  if (cfg.mode === 'list' && !cfg.url_list.length) { openModal('#listModal'); return; }
  saveConfig();
  if (cfg.mode === 'spider') store.set('seo-spider-hist', [cfg.start_url, ...store.get('seo-spider-hist', []).filter((u) => u !== cfg.start_url)].slice(0, 10));
  const r = await fetch('/api/crawl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert(typeof err.detail === 'string' ? t(err.detail) : err.detail ? JSON.stringify(err.detail) : t('Erro ao iniciar'));
    return;
  }
  DATA = EMPTY();
  PAGE = new Map();
  sourceCache.clear();
  rateRef = null;
  Object.assign(S, { sel: null, multi: new Set(), sort: null, custom: null });
  lastData = 0;
  setRunning(true);
  poll();
});
$('#clearBtn').addEventListener('click', clearCrawl);

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setView(b.dataset.tab);
});
$$('.tabmore').forEach((b) => b.addEventListener('click', (e) => {
  const which = b.dataset.more;
  const r = b.getBoundingClientRect();
  const items = which === 'tabs'
    ? visibleTabs().map(([k, t]) => `<a data-more-tab="${k}" class="radio ${k === S.tab ? 'on' : ''}">${t.label}</a>`)
    : which === 'rtabs'
    ? Object.entries(RTABS).map(([k, l]) => `<a data-more-rtab="${k}" class="radio ${k === S.rtab ? 'on' : ''}">${l}</a>`)
    : $$('#dtabs button').map((x) => `<a data-more-dtab="${x.dataset.dtab}" class="radio ${x.dataset.dtab === S.detail ? 'on' : ''}">${x.textContent}</a>`);
  showFloating('#moreMenu', r.left - 200, which !== 'dtabs' ? r.bottom : r.top - 10, items.join(''));
  if (which === 'dtabs') { const m = $('#moreMenu'); m.style.top = Math.max(4, r.top - m.offsetHeight) + 'px'; }
}));
$('#moreMenu').addEventListener('click', (e) => {
  const t = e.target.closest('[data-more-tab]');
  const d = e.target.closest('[data-more-dtab]');
  const rt = e.target.closest('[data-more-rtab]');
  closeFloating();
  if (rt) { S.rtab = rt.dataset.moreRtab; renderRight(); $('#rtabs .active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }
  if (t) setView(t.dataset.moreTab);
  if (d) { S.detail = d.dataset.moreDtab; renderDetail(); }
});

$('#filter').addEventListener('change', (e) => {
  if (e.target.value === '__custom') return;
  S.filter = e.target.value;
  S.custom = null;
  renderTabs(); renderTable(); renderRight();
});
let searchTimer;
$('#search').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.q = e.target.value; renderTable(); syncSearchOpts(); }, 150); });
$('#detailSearch').addEventListener('input', filterDetail);
$$('[data-sopts]').forEach((b) => b.addEventListener('click', () => ADV.open(!b.closest('.bottom'))));   // Advanced Table Search
$('#searchMenu').addEventListener('change', (e) => {
  const k = e.target.dataset.sopt;
  if (!k) return;
  SOPTS[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  store.set('seo-spider-search', SOPTS);
  syncSearchOpts();
  renderTable();
  filterDetail();
});
$$('.viewtoggle button').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.view; renderTable(); }));
$('#csvBtn').addEventListener('click', exportCurrent);
$('#detailExport').addEventListener('click', () => {
  const t = $('#detailBody table');
  if (!t) return;
  const rows = [...t.querySelectorAll('tr')].filter((tr) => !tr.hidden).map((tr) => [...tr.children].map((c) => c.textContent.trim()));
  const head = rows.shift() || [];
  exportCsv(rows.map((r) => Object.fromEntries(r.map((v, i) => [i, v]))), head.map((l, i) => ({ key: i, label: l })), `seo-spider-${S.detail}`);
});

$('#grid thead').addEventListener('click', (e) => {
  if (e.target.closest('[data-addcol]')) {
    const r = e.target.getBoundingClientRect();
    const hid = new Set(S.hidden[S.tab] || []);
    showFloating('#colMenu', r.right - 260, r.bottom, colsOf(TABS[S.tab]).filter((c) => c.key !== 'url')
      .map((c) => `<label><input type="checkbox" data-col="${c.key}" ${hid.has(c.key) ? '' : 'checked'}> ${esc(c.label)}</label>`).join(''));
    return;
  }
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const k = th.dataset.sort;
  S.dir = S.sort === k ? -S.dir : 1;
  S.sort = k;
  renderTable();
});
$('#colMenu').addEventListener('change', (e) => {
  const k = e.target.dataset.col;
  const hid = new Set(S.hidden[S.tab] || []);
  e.target.checked ? hid.delete(k) : hid.add(k);
  S.hidden[S.tab] = [...hid];
  store.set('seo-spider-cols', S.hidden);
  renderTable();
});

$('#grid tbody').addEventListener('mousedown', (e) => {
  const tg = e.target.closest('[data-tnode]');
  if (tg) {
    const k = tg.dataset.tnode;
    const depth = (tg.closest('td').style.paddingLeft.replace('px', '') - 4) / 16;
    S.treeState[k] = !(S.treeState[k] ?? depth < 3);
    renderTable();
    return;
  }
  const tr = e.target.closest('tr[data-key]');
  if (!tr || e.button !== 0) return;
  if (e.shiftKey) e.preventDefault();
  selectRow(tr.dataset.key, e);
});
$('#grid tbody').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  e.preventDefault();
  if (!S.multi.has(tr.dataset.key)) selectRow(tr.dataset.key);
  const isPage = PAGE.has(S.sel);
  showFloating('#ctxMenu', e.clientX, e.clientY, `
    <a data-ctx="copy">Copiar URL${S.multi.size > 1 ? 's' : ''}</a>
    <a data-ctx="open">Abrir no navegador</a>
    <hr><a data-ctx="inlinks">Ver inlinks</a>
    ${isPage ? '<a data-ctx="outlinks">Ver outlinks</a><a data-ctx="source">Ver código-fonte</a><a data-ctx="psi">Analisar PageSpeed (mobile)</a>' : ''}
    <hr><a data-ctx="export">Exportar selecionadas (CSV)</a>`);
});
$('#ctxMenu').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-ctx]');
  if (!a) return;
  closeFloating();
  const urls = ROWS.map((r) => rowKey(r)).filter((k) => S.multi.has(k));
  const act = a.dataset.ctx;
  if (act === 'copy') navigator.clipboard?.writeText(urls.join('\n'));
  else if (act === 'open') urls.slice(0, 10).forEach((u) => window.open(u, '_blank', 'noopener'));
  else if (act === 'export') exportCsv(ROWS.filter((r) => S.multi.has(rowKey(r))), visibleCols(), 'seo-spider-selecao');
  else if (act === 'psi') { S.detail = 'psi'; await renderDetail(); $('#detailBody [data-psi="mobile"]')?.click(); }
  else { S.detail = act; renderDetail(); }
});
$('#gridWrap').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key) || !ROWS.length) return;
  e.preventDefault();
  const i = ROWS.findIndex((r) => (rowKey(r)) === S.sel);
  const next = Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), Math.min(ROWS.length, MAX_ROWS) - 1);
  const key = ROWS[next].url ?? ROWS[next].name;
  selectRow(key, { shiftKey: e.shiftKey });
  $(`#grid tr[data-i="${next}"]`)?.scrollIntoView({ block: 'nearest' });
});
$('#treeView').addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) { e.preventDefault(); S.sel = a.dataset.goto; S.multi = new Set([S.sel]); renderDetail(); }
});

$('#dtabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dtab]');
  if (b) { S.detail = b.dataset.dtab; renderDetail(); }
});
$('#detailBody').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) { gotoUrl(a.dataset.goto); return; }
  const b = e.target.closest('[data-psi]');
  if (b) {
    const url = S.sel;
    b.disabled = true;
    b.textContent = 'Analisando… (até 1 min)';
    if (await runPsi({ url, strategy: b.dataset.psi })) { detailCache.delete(url); await loadData(); }
    renderDetail();
  }
});
$('#tabActions').addEventListener('click', async (e) => {
  const all = e.target.closest('[data-psi-all]');
  if (all && await runPsi({ all: true, strategy: all.dataset.psiAll, limit: 1000 })) poll();
  if (e.target.closest('[data-psi-stop]')) await fetch('/api/psi/stop', { method: 'POST' });
});

$('#rtabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rtab]');
  if (b) { S.rtab = b.dataset.rtab; renderRight(); }
});
const RACTIONS = {
  'segments-config': () => ACTIONS.config({ dataset: { section: 'segments' } }),
  'spell-config': () => ACTIONS.config({ dataset: { section: 'content' } }),
  'psi-key': () => openApiModal('psi'),
  'psi-all': async () => { if (await runPsi({ all: true, strategy: 'mobile', limit: 1000 })) poll(); },
  'psi-stop': () => fetch('/api/psi/stop', { method: 'POST' }),
  grammar: async () => {
    const r = await fetch('/api/grammar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1000 }) });
    if (!r.ok) { alert(t((await r.json()).detail)); return; }
    lastStatus = { ...(lastStatus || {}), grammar: await r.json() };
    renderRight();
    poll();
  },
  'grammar-stop': () => fetch('/api/grammar/stop', { method: 'POST' }),
  'semantic-search': async () => {
    SEM.q = $('#semQuery').value.trim();
    if (!SEM.q) { SEM.results = null; renderRight(); return; }
    const r = await fetch('/api/semantic?q=' + encodeURIComponent(SEM.q));
    if (!r.ok) { alert(t((await r.json()).detail)); return; }
    SEM.results = await r.json();
    renderRight();
  },
};
Object.assign(RACTIONS, {
  'api-run': async () => {
    const segments = segmentDefs().map((d) => ({ name: d.name, regex: d.re.source }));
    const r = await fetch('/api/integrations/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments }) });
    if (!r.ok) { alert(t((await r.json()).detail)); return; }
    lastStatus = { ...(lastStatus || {}), integrations: await r.json() };
    renderRight();
    poll();
  },
  'api-stop': () => fetch('/api/integrations/stop', { method: 'POST' }),
});
$('#rchart').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ract]');
  if (b && !b.disabled) RACTIONS[b.dataset.ract]?.();
});

let API_EDIT = null;
// ---- AI prompts (SF "Prompt Configuration"): several prompts per provider, library, test, segments
let PROMPTS_EDIT = [];
let USER_AILIB = store.get('seo-spider-ailib', []);
const CONTENT_TYPES = [['page_text', 'Texto da página'], ['html', 'HTML'], ['title_meta', 'Title + meta description + H1'], ['custom', 'Extração personalizada']];
function promptsEditor(p) {
  PROMPTS_EDIT = JSON.parse(JSON.stringify(Array.isArray(p.values.prompts) ? p.values.prompts : []));
  return `<div class="prompts"><div class="ptitle"><b>${t('Prompts')}</b> <span class="muted" id="pCount"></span></div>
    <input type="hidden" name="prompts" id="promptsField">
    <div class="jstools"><button type="button" class="tbtn" data-p-add>+ ${t('Adicionar prompt')}</button>
      <button type="button" class="tbtn" data-p-lib>${t('Adicionar da biblioteca')}</button>
      <button type="button" class="tbtn" data-p-export>${t('Exportar JSON')}</button>
      <label class="tbtn">${t('Importar JSON')}<input type="file" accept=".json" data-p-import hidden></label></div>
    <div id="pList" class="plist"></div>
    <div class="jstest"><input id="pTestUrl" type="text" placeholder="${esc(t('URL para testar o prompt'))}" autocomplete="off"></div>
    <pre id="pTestOut" class="jsout" hidden></pre></div>`;
}
function syncPrompts() {
  $('#promptsField').value = JSON.stringify(PROMPTS_EDIT);
  $('#pCount').textContent = `${PROMPTS_EDIT.length}/100`;
}
function renderPrompts() {
  const segs = segmentDefs().map((d) => d.name);
  $('#pList').innerHTML = PROMPTS_EDIT.length ? PROMPTS_EDIT.map((pr, i) => `<div class="pitem" data-pi="${i}">
    <div class="prow">
      <input data-pf="name" value="${esc(pr.name || '')}" placeholder="${esc(t('Nome (vira a coluna na aba IA)'))}">
      <select data-pf="type"><option value="chat" ${pr.type !== 'embeddings' ? 'selected' : ''}>${t('Prompt (texto)')}</option><option value="embeddings" ${pr.type === 'embeddings' ? 'selected' : ''}>Embeddings</option></select>
      <select data-pf="content">${CONTENT_TYPES.map(([v, l]) => `<option value="${v}" ${(pr.content || 'page_text') === v ? 'selected' : ''}>${t(l)}</option>`).join('')}</select>
      <select data-pf="segment"><option value="">${t('Todas as URLs')}</option>${segs.map((s) => `<option value="${esc(s)}" ${pr.segment === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <input data-pf="model" value="${esc(pr.model || '')}" placeholder="${esc(t('Modelo (padrão do provedor)'))}">
    </div>
    <textarea data-pf="prompt" rows="3" translate="no" ${pr.type === 'embeddings' ? 'hidden' : ''} placeholder="${esc(t('Escreva o prompt. O conteúdo escolhido é enviado logo depois dele.'))}">${esc(pr.prompt || '')}</textarea>
    <div class="jstools"><button type="button" class="tbtn" data-p-test>▶ ${t('Testar')}</button>
      <button type="button" class="tbtn" data-p-save>${t('Salvar na biblioteca do usuário')}</button>
      <button type="button" class="tbtn" data-p-del>${t('Remover')}</button></div></div>`).join('')
    : `<div class="empty">${t('Nenhum prompt. Use “Adicionar prompt” ou “Adicionar da biblioteca”.')}</div>`;
  syncPrompts();
}
function addPrompt(pr) {
  if (PROMPTS_EDIT.length >= 100) { alert(t('Limite de 100 prompts atingido.')); return; }
  PROMPTS_EDIT.push({ name: pr.name || `Prompt ${PROMPTS_EDIT.length + 1}`, type: pr.type || 'chat', content: pr.content || 'page_text', segment: pr.segment || '', model: pr.model || '', prompt: pr.prompt || '' });
  renderPrompts();
}
$('#apiForm').addEventListener('input', (e) => {
  const it = e.target.closest('[data-pi]');
  if (!it || !e.target.dataset.pf) return;
  PROMPTS_EDIT[+it.dataset.pi][e.target.dataset.pf] = e.target.value;
  syncPrompts();
});
$('#apiForm').addEventListener('change', (e) => {
  if (e.target.dataset.pf === 'type') renderPrompts();
  if (e.target.matches('[data-p-import]')) {
    const f = e.target.files[0];
    if (f) f.text().then((txt) => { try { (JSON.parse(txt) || []).forEach(addPrompt); } catch { alert(t('Arquivo JSON inválido.')); } });
  }
});
$('#apiForm').addEventListener('click', async (e) => {
  const it = e.target.closest('[data-pi]');
  if (e.target.closest('[data-p-add]')) addPrompt({});
  else if (e.target.closest('[data-p-export]')) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(PROMPTS_EDIT, null, 2)], { type: 'application/json' }));
    a.download = `seo-spider-prompts-${API_EDIT}.json`;
    a.click();
  } else if (e.target.closest('[data-p-lib]')) {
    const r = e.target.getBoundingClientRect();
    const items = AI_PROMPT_LIBRARY.map((p, i) => `<a data-ailib="s${i}">${esc(t(p.name))}</a>`)
      .concat(USER_AILIB.length ? ['<hr>'] : [], USER_AILIB.map((p, i) => `<a data-ailib="u${i}" translate="no">★ ${esc(p.name)}</a>`));
    showFloating('#moreMenu', r.left, r.bottom, items.join(''));
  } else if (it && e.target.closest('[data-p-del]')) { PROMPTS_EDIT.splice(+it.dataset.pi, 1); renderPrompts(); }
  else if (it && e.target.closest('[data-p-save]')) {
    USER_AILIB = USER_AILIB.filter((x) => x.name !== PROMPTS_EDIT[+it.dataset.pi].name).concat([PROMPTS_EDIT[+it.dataset.pi]]);
    store.set('seo-spider-ailib', USER_AILIB);
    $('#apiMsg').textContent = t('Salvo na biblioteca do usuário.');
  } else if (it && e.target.closest('[data-p-test]')) {
    const url = $('#pTestUrl').value.trim();
    const out = $('#pTestOut');
    if (!url) { $('#pTestUrl').focus(); return; }
    out.hidden = false;
    out.className = 'jsout';
    out.textContent = t('Enviando para a IA…');
    const r = await fetch(`/api/integrations/${API_EDIT}/prompt-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, prompt: PROMPTS_EDIT[+it.dataset.pi] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { out.className = 'jsout s4'; out.textContent = t(j.detail || 'Erro'); return; }
    out.textContent = `— ${t('Enviado')} —\n${j.sent}\n\n— ${t('Resposta')} —\n${j.response}`;
  }
});
$('#moreMenu').addEventListener('click', (e) => {
  const a = e.target.closest('[data-ailib]');
  if (!a) return;
  const k = a.dataset.ailib;
  const src = k[0] === 's' ? AI_PROMPT_LIBRARY[+k.slice(1)] : USER_AILIB[+k.slice(1)];
  closeFloating();
  if (src) addPrompt({ ...src, name: k[0] === 's' ? t(src.name) : src.name });
});

function apiFormValues() {
  const v = {};
  $$('#apiForm [name]').forEach((el) => { v[el.name] = el.type === 'number' ? Number(el.value) : el.value; });
  return v;
}
function syncApiForm() {
  const vals = apiFormValues();
  $$('#apiForm [data-show-if]').forEach((row) => {
    const [k, want] = row.dataset.showIf.split('=');
    row.hidden = vals[k] !== want;
  });
  const p = APIS.find((x) => x.id === API_EDIT);
  $('#apiOauth').hidden = !(p?.google && vals.auth === 'oauth');
  $('#apiOptions').hidden = !p?.options;
}
function openApiModal(id) {
  const p = APIS.find((x) => x.id === id);
  if (!p) return;
  API_EDIT = id;
  $('#apiTitle').textContent = p.name;
  $('#apiHelp').textContent = t(p.help || '');
  $('#apiMsg').textContent = '';
  $('#apiMsg').className = 'apimsg';
  const field = (f) => {
    const v = p.values[f.name] ?? '';
    const has = p.values['_has_' + f.name];
    const ph = f.secret && has ? t('(salvo — deixe em branco para manter)') : '';
    let input;
    if (f.type === 'select') input = `<select name="${f.name}">${f.options.map(([val, lab]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
    else if (f.type === 'textarea') input = `<textarea name="${f.name}" rows="${f.secret ? 4 : 6}" placeholder="${esc(ph)}" translate="no">${esc(f.secret ? '' : v)}</textarea>`;
    else input = `<input name="${f.name}" type="${f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}" value="${esc(f.secret ? '' : v)}" placeholder="${esc(ph)}" ${f.options ? `list="opt-${f.name}"` : ''} autocomplete="off"><datalist id="opt-${f.name}"></datalist>`;
    const link = f.link ? `<a class="keylink" href="${esc(f.link.url)}" target="_blank" rel="noopener noreferrer">${esc(f.link.label)} <span>↗</span></a>` : '';
    return `<label class="stack" ${f.show_if ? `data-show-if="${f.show_if}"` : ''}>${esc(f.label)}${input}${link}</label>`;
  };
  $('#apiForm').innerHTML = p.fields.map((f) => (f.type === 'prompts' ? promptsEditor(p) : field(f))).join('');
  if (p.ai) renderPrompts();
  $('#apiOauthState').textContent = p.oauth_ok ? t('Login Google concluído') : '';
  $('#apiOptions').textContent = t(p.options || '');
  openModal('#apiModal');
  syncApiForm();
}
async function apiCall(path, label) {
  const msg = $('#apiMsg');
  msg.className = 'apimsg';
  msg.textContent = t(label);
  const r = await fetch(`/api/integrations/${API_EDIT}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: apiFormValues() }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { msg.className = 'apimsg s4'; msg.textContent = t(j.detail || 'Erro'); return null; }
  return j;
}
$('#apiForm').addEventListener('change', syncApiForm);
$('#apiConnect').addEventListener('click', async () => {
  const j = await apiCall('', 'Testando conexão…');
  if (!j) return;
  await loadApis();
  $('#apiMsg').className = 'apimsg s2';
  $('#apiMsg').textContent = t('Conectado');
  renderTabs(); renderRight();
});
$('#apiDisconnect').addEventListener('click', async () => {
  await fetch(`/api/integrations/${API_EDIT}/disconnect`, { method: 'POST' });
  await loadApis();
  openApiModal(API_EDIT);
  renderTabs(); renderRight();
});
$('#apiOauth').addEventListener('click', async () => {
  const j = await apiCall('/oauth', 'Conclua o login na janela do Google que foi aberta…');
  if (!j) return;
  await loadApis();
  $('#apiOauthState').textContent = t('Login Google concluído');
  $('#apiMsg').textContent = '';
});
$('#apiOptions').addEventListener('click', async () => {
  const opts = await apiCall('/options', 'Carregando…');
  if (!opts) return;
  const f = APIS.find((x) => x.id === API_EDIT).fields.find((x) => x.options === true);
  $('#opt-' + f.name).innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  $('#apiMsg').textContent = tf('{{0}} encontradas — clique no campo para escolher', opts.length);
  $(`#apiForm [name="${f.name}"]`).focus();
});

$('#rtable').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'semQuery') RACTIONS['semantic-search'](); });
Object.assign(RACTIONS, {
  'st-collapse': () => { S.stState = {}; S.stLevel = 1; renderRight(); },
  'st-expand': () => { S.stState = {}; S.stLevel = Math.max(1, treeMaxDepth(ST_TREE || buildTree(DATA.pages)) + 1); renderRight(); },
  'st-less': () => { S.stState = {}; S.stLevel = Math.max(1, S.stLevel - 1); renderRight(); },
  'st-more': () => { S.stState = {}; S.stLevel += 1; renderRight(); },
  'st-export': exportStructure,
});
$('#ws').addEventListener('change', (e) => {
  if (e.target.id === 'stView') { S.stView = e.target.value; renderRight(); }
  if (e.target.id === 'chartView') { S.chartView = e.target.value; renderRight(); }
});
$('#rtable').addEventListener('click', (e) => {
  const cfg = e.target.closest('[data-api-cfg]');
  if (cfg) { openApiModal(cfg.dataset.apiCfg); return; }
  const stg = e.target.closest('[data-stnode]');
  if (stg) {
    const k = stg.dataset.stnode;
    const tr = stg.closest('tr');
    const depth = (tr.querySelector('td').style.paddingLeft.replace('px', '') - 4) / 16;
    S.stState[k] = !(S.stState[k] ?? depth < S.stLevel);
    renderRight();
    return;
  }
  const st = e.target.closest('[data-stpath]');
  if (st && !e.target.closest('[data-ract]')) {
    const prefix = st.dataset.stpath;
    setView('internal', 'all', { label: 'Caminho: ' + prefix, rows: () => DATA.pages, test: (p) => p.url.startsWith(prefix) });
    return;
  }
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    COLLAPSED[tg.dataset.toggle] = !COLLAPSED[tg.dataset.toggle];
    store.set('seo-spider-collapsed', COLLAPSED);
    renderRight();
    return;
  }
  const sum = e.target.closest('[data-sum]');
  if (sum) {
    const want = sum.dataset.sum === 'indexable' ? 'Indexable' : 'Non-Indexable';
    setView('internal', 'all', { label: sum.dataset.sum === 'indexable' ? 'Internas indexáveis' : 'Internas não indexáveis', rows: () => DATA.pages, test: (p) => p.indexability === want });
    return;
  }
  const btn = e.target.closest('[data-ract]');
  if (btn) { RACTIONS[btn.dataset.ract](); return; }
  const tr = e.target.closest('tr');
  if (!tr) return;
  const hp = htmlPages;
  if (tr.dataset.segment != null) {
    const n = tr.dataset.segment;
    setView('internal', 'all', { label: 'Segmento: ' + n, rows: () => DATA.pages, test: (p) => (p.segment || SEG_NONE) === n });
  } else if (tr.dataset.api === 'psi') setView('pagespeed');
  else if (tr.dataset.api === 'grammar' || tr.dataset.sg === 'grammar') setView('content', 'grammar');
  else if (tr.dataset.sg === 'spelling') setView('content', 'spell');
  else if (tr.dataset.word) {
    const t = (DATA.spelling_top || []).find((x) => x.word === tr.dataset.word);
    const urls = new Set(t ? t.urls : []);
    setView('content', 'all', { label: 'Palavra: ' + tr.dataset.word, rows: hp, test: (p) => urls.has(p.url) });
  } else if (tr.dataset.sem === 'similar') setView('content', 'semsim');
  else if (tr.dataset.sem === 'low') setView('content', 'lowrel');
  else if (tr.dataset.gotoUrl) gotoUrl(tr.dataset.gotoUrl);
  else if (tr.dataset.tab) setView(tr.dataset.tab, tr.dataset.filter);
  else if (tr.dataset.issue) applyIssue(tr.dataset.issue);
  else if (tr.dataset.depth) {
    const { html, of } = DEPTH_GROUPS();
    const k = tr.dataset.depth;
    setView('internal', 'all', { label: 'Profundidade ' + k, rows: () => html, test: (p) => of(p) === k });
  } else if (tr.dataset.time) {
    const b = TIME_BUCKETS[+tr.dataset.time];
    setView('internal', 'all', { label: 'Tempo ' + timeLabel(b), rows: htmlPages, test: (p) => p.response_ms / 1000 >= b[0] && p.response_ms / 1000 < b[1] });
  }
});
$('#rchart').addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-seg]');
  const wrap = e.target.closest('.donutwrap');
  if (el && wrap) highlightSeg(wrap, +el.dataset.seg);
});
$('#rchart').addEventListener('mouseleave', () => {
  const wrap = $('#rchart .donutwrap');
  if (wrap) highlightSeg(wrap, null);
});
$('#rchart').addEventListener('click', (e) => {
  const el = e.target.closest('[data-key]');
  if (el && S.rtab === 'overview') setView(S.tab, el.dataset.key);
});
$('#viz').addEventListener('click', (e) => {
  const v = e.target.closest('[data-viz]');
  if (v) { S.viz = v.dataset.viz; renderViz(); return; }
  const node = e.target.closest('circle[data-goto]');
  if (node) { gotoUrl(node.dataset.goto); return; }
  const a = e.target.closest('[data-goto]');
  if (a) { e.preventDefault(); gotoUrl(a.dataset.goto); }
});

function syncUaPreset() {
  const v = $('[name=user_agent]').value;
  const opt = [...$('#uaPreset').options].find((o) => o.value === v);
  $('#uaPreset').value = opt ? v : '';
}
$('#uaPreset').addEventListener('change', (e) => { if (e.target.value) $('[name=user_agent]').value = e.target.value; });
$('[name=user_agent]').addEventListener('input', syncUaPreset);

// ---------- Custom JavaScript (snippets) ----------
let SNIPPETS = store.get('seo-spider-js', []);
let USER_JSLIB = store.get('seo-spider-jslib', []);
let JS_SEL = 0;
let JS_LIB_TAB = 'system';
const saveSnippets = () => store.set('seo-spider-js', SNIPPETS);
const snippetName = (s, i) => s.name || `Snippet ${i + 1}`;

function renderJsList() {
  $('#jsList').innerHTML = SNIPPETS.length ? SNIPPETS.map((s, i) =>
    `<div class="jsitem ${i === JS_SEL ? 'on' : ''}" data-js="${i}"><b translate="no">${esc(snippetName(s, i))}</b>
      <span>${t(s.type === 'action' ? 'Ação' : 'Extração')} · <span translate="no">${esc(s.content_type || 'text/html')}</span></span></div>`).join('')
    : `<div class="empty">${t('Nenhum snippet. Use “Adicionar” ou “Adicionar da biblioteca”.')}</div>`;
  $('#jsCount').textContent = `${SNIPPETS.length}/100`;
}
function renderJsModal() {
  if (JS_SEL >= SNIPPETS.length) JS_SEL = Math.max(0, SNIPPETS.length - 1);
  renderJsList();
  const s = SNIPPETS[JS_SEL];
  $('#jsEditor').hidden = !s;
  $('#jsEmpty').hidden = !!s;
  if (!s) return;
  $('#jsName').value = s.name || '';
  $('#jsType').value = s.type || 'extraction';
  $('#jsCtype').value = s.content_type || 'text/html';
  $('#jsTimeout').value = s.timeout || 10;
  $('#jsCode').value = s.code || '';
  $('#jsTestOut').textContent = '';
}
function addSnippet(sn) {
  if (SNIPPETS.length >= 100) { alert(t('Limite de 100 snippets atingido.')); return; }
  SNIPPETS.push({ name: sn.name, type: sn.type || 'extraction', content_type: sn.content_type || 'text/html', timeout: sn.timeout || 10, code: sn.code || '' });
  JS_SEL = SNIPPETS.length - 1;
  saveSnippets();
  renderJsModal();
}
function renderJsLib() {
  $$('#jsLibTabs button').forEach((b) => b.classList.toggle('active', b.dataset.lib === JS_LIB_TAB));
  const list = JS_LIB_TAB === 'system' ? JS_LIBRARY : USER_JSLIB;
  $('#jsLibList').innerHTML = list.length ? list.map((s, i) =>
    `<div class="libitem"><div><b>${esc(s.name)}</b><div class="muted">${esc(s.description || '')}</div>
      <div class="muted" translate="no">${esc(s.type === 'action' ? 'action' : 'extraction')} · ${esc(s.content_type || 'text/html')}</div></div>
      <div class="libbtns"><button class="tbtn primary" data-lib-add="${i}">${t('Adicionar')}</button>
      ${JS_LIB_TAB === 'user' ? `<button class="tbtn" data-lib-del="${i}">${t('Remover')}</button>` : ''}</div></div>`).join('')
    : `<div class="empty">${t('A biblioteca do usuário está vazia. Salve um snippet com “Salvar na biblioteca do usuário”.')}</div>`;
}
function editSnippet(field, value) {
  const s = SNIPPETS[JS_SEL];
  if (!s) return;
  s[field] = value;
  saveSnippets();
  if (field !== 'code') renderJsList();
}
$('#jsName').addEventListener('input', (e) => editSnippet('name', e.target.value));
$('#jsType').addEventListener('change', (e) => editSnippet('type', e.target.value));
$('#jsCtype').addEventListener('change', (e) => editSnippet('content_type', e.target.value));
$('#jsTimeout').addEventListener('input', (e) => editSnippet('timeout', Number(e.target.value) || 10));
$('#jsCode').addEventListener('input', (e) => editSnippet('code', e.target.value));
$('#jsCode').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const el = e.target;
  const [a, b] = [el.selectionStart, el.selectionEnd];
  el.value = el.value.slice(0, a) + '  ' + el.value.slice(b);
  el.selectionStart = el.selectionEnd = a + 2;
  editSnippet('code', el.value);
});
$('#jsList').addEventListener('click', (e) => {
  const it = e.target.closest('[data-js]');
  if (it) { JS_SEL = +it.dataset.js; renderJsModal(); }
});
$('#jsAdd').addEventListener('click', () => addSnippet({ name: `Snippet ${SNIPPETS.length + 1}`, code: '// Seu código aqui\nreturn seoSpider.data(document.title);' }));
$('#jsLibBtn').addEventListener('click', () => { JS_LIB_TAB = 'system'; openModal('#jsLibModal'); $('#jsModal').hidden = false; renderJsLib(); });
$('#jsLibTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lib]');
  if (b) { JS_LIB_TAB = b.dataset.lib; renderJsLib(); }
});
$('#jsLibList').addEventListener('click', (e) => {
  const add = e.target.closest('[data-lib-add]');
  const del = e.target.closest('[data-lib-del]');
  const list = JS_LIB_TAB === 'system' ? JS_LIBRARY : USER_JSLIB;
  if (add) { addSnippet(list[+add.dataset.libAdd]); $('#jsLibModal').hidden = true; }
  if (del) { USER_JSLIB.splice(+del.dataset.libDel, 1); store.set('seo-spider-jslib', USER_JSLIB); renderJsLib(); }
});
$('#jsSaveUser').addEventListener('click', () => {
  const s = SNIPPETS[JS_SEL];
  if (!s) return;
  const description = window.prompt(t('Descrição do snippet (opcional):'), '') ?? null;
  if (description === null) return;
  USER_JSLIB = USER_JSLIB.filter((x) => x.name !== s.name).concat([{ ...s, description }]);
  store.set('seo-spider-jslib', USER_JSLIB);
  $('#jsTestOut').textContent = t('Salvo na biblioteca do usuário.');
});
$('#jsRemove').addEventListener('click', () => { SNIPPETS.splice(JS_SEL, 1); saveSnippets(); renderJsModal(); });
$('#jsExport').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(SNIPPETS, null, 2)], { type: 'application/json' }));
  a.download = 'seo-spider-snippets.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#jsImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const list = JSON.parse(await f.text());
    for (const sn of (Array.isArray(list) ? list : [list])) if (sn && typeof sn.code === 'string') addSnippet(sn);
  } catch { alert(t('Arquivo JSON inválido.')); }
  e.target.value = '';
});
$('#jsTestBtn').addEventListener('click', async () => {
  const s = SNIPPETS[JS_SEL];
  const url = $('#jsTestUrl').value.trim();
  if (!s || !url) { $('#jsTestUrl').focus(); return; }
  const out = $('#jsTestOut');
  out.className = 'jsout';
  out.textContent = t('Abrindo a página no navegador e executando o snippet…');
  const r = await fetch('/api/customjs/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, snippet: { ...s, timeout: Number(s.timeout) || 10 }, user_agent: $('[name=user_agent]').value }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { out.className = 'jsout s4'; out.textContent = t(j.detail || 'Erro'); return; }
  const lines = [`HTTP ${j.status} · ${j.content_type || '?'}`];
  if (!j.matches) lines.push(tf('Atenção: o tipo de conteúdo desta URL não corresponde ao do snippet ({{0}}); no crawl ele não seria executado aqui.', s.content_type));
  lines.push('', j.error ? tf('Erro: {{0}}', j.error) : j.value);
  if ((j.console || []).length) lines.push('', '— ' + t('Console do snippet') + ' —', ...j.console);
  if ((j.page_console || []).length) lines.push('', '— ' + t('Console da página (carregamento)') + ' —', ...j.page_console.slice(0, 30));
  out.className = 'jsout ' + (j.error ? 's4' : '');
  out.textContent = lines.join('\n');
});

// ---------- robots.txt tester / why-not-crawled / sitemap generator / forms login ----------
function syncRobotsOverride() {
  $('[name=robots_override]').value = $('#robotsUse').checked ? $('#robotsText').value : '';
  saveConfig();
}
$('#robotsLoad').addEventListener('click', async () => {
  const url = $('#robotsUrl').value.trim();
  if (!url) return;
  $('#robotsMsg').textContent = t('Carregando…');
  const r = await fetch(`/api/robots?url=${encodeURIComponent(url)}&user_agent=${encodeURIComponent($('#robotsUa').value)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#robotsMsg').textContent = t(j.detail || 'Erro'); return; }
  $('#robotsText').value = j.text || '';
  $('#robotsMsg').textContent = `${j.robots_url}${j.status && j.status !== 200 ? ' — HTTP ' + j.status : ''}`;
  if (!$('#robotsUrls').value.trim()) $('#robotsUrls').value = url;
});
$('#robotsTest').addEventListener('click', async () => {
  const urls = $('#robotsUrls').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) { $('#robotsUrls').focus(); return; }
  const r = await fetch('/api/robots/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ robots_text: $('#robotsText').value, urls, user_agent: $('#robotsUa').value || 'SEOSpiderClone/1.0' }) });
  const res = await r.json();
  $('#robotsResult').innerHTML = '<table><thead><tr><th>URL</th><th>Resultado</th><th>Linha correspondente</th></tr></thead><tbody>' +
    res.map((x) => `<tr><td class="nt">${esc(x.url)}</td><td class="${x.allowed ? 's2' : 's4'}">${t(x.allowed ? 'Permitida' : 'Bloqueada')}</td><td class="nt">${x.line ? `${t('Linha')} ${x.lineno}: ${esc(x.line)}` : '—'}</td></tr>`).join('') + '</tbody></table>';
});
$('#robotsUse').addEventListener('change', syncRobotsOverride);
$('#robotsText').addEventListener('input', () => { if ($('#robotsUse').checked) syncRobotsOverride(); });

$('#whyBtn').addEventListener('click', async () => {
  const url = $('#whyUrl').value.trim();
  if (!url) return;
  const r = await fetch('/api/why?url=' + encodeURIComponent(url));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#whyOut').innerHTML = empty(t(j.detail || 'Erro')); return; }
  const rows = j.crawled
    ? { [t('Rastreada')]: t('Sim'), [t('Código')]: j.status, Status: tv(j.status_text), [t('Indexabilidade')]: tv(j.indexability), [t('Motivo')]: tv(j.reason),
        [t('Linha do robots.txt')]: j.robots_line || '—', [t('Encontrada via')]: t(VIA[j.found_via] || j.found_via), [t('Encontrada primeiro em')]: j.parent || '—' }
    : { [t('Rastreada')]: t('Não'), [t('Motivo')]: t(j.reason), [t('Encontrada primeiro em')]: j.parent || '—' };
  $('#whyOut').innerHTML = '<table class="kv"><tbody>' + Object.entries(rows).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</tbody></table>';
});
$('#whyUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#whyBtn').click(); });

$('#smGen').addEventListener('click', async () => {
  const opts = {};
  $$('#sitemapModal [data-sm]').forEach((el) => { opts[el.dataset.sm] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; });
  const r = await fetch('/api/sitemap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) });
  if (!r.ok) { alert(t((await r.json().catch(() => ({}))).detail || 'Erro')); return; }
  const zip = (r.headers.get('content-type') || '').includes('zip');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob());
  a.download = zip ? 'sitemaps.zip' : 'sitemap.xml';
  a.click();
});

async function refreshFormAuth() {
  const j = await fetch('/api/formauth').then((r) => r.json()).catch(() => ({}));
  $('#faState').textContent = j.cookies ? tf('Sessão salva: {{0}} cookies ({{1}}).', j.cookies, (j.domains || []).join(', ')) : t('Nenhuma sessão salva.');
  $('#faFinish').disabled = !j.active;
}
$('#faStart').addEventListener('click', async () => {
  const url = $('#faUrl').value.trim();
  if (!url) { $('#faUrl').focus(); return; }
  const r = await fetch('/api/formauth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  if (!r.ok) { alert(t((await r.json().catch(() => ({}))).detail || 'Erro')); return; }
  $('#faState').textContent = t('Faça login na janela do navegador que abriu e depois clique em “Concluí o login”.');
  $('#faFinish').disabled = false;
});
$('#faFinish').addEventListener('click', async () => {
  const r = await fetch('/api/formauth/finish', { method: 'POST' });
  if (!r.ok) { alert(t((await r.json().catch(() => ({}))).detail || 'Erro')); return; }
  $('[name=use_form_auth]').checked = true;
  saveConfig();
  refreshFormAuth();
});
$('#faClear').addEventListener('click', async () => { await fetch('/api/formauth', { method: 'DELETE' }); $('[name=use_form_auth]').checked = false; saveConfig(); refreshFormAuth(); });
$('#faOpen').addEventListener('click', () => ACTIONS.formauth());

$('#tabActions').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-crawl-more]')) return;
  const r = await fetch('/api/crawl-more', { method: 'POST' });
  if (!r.ok) { alert(t((await r.json().catch(() => ({}))).detail || 'Erro')); return; }
  setRunning(true);
  poll();
});

// ---------- saved crawls (File > Crawls) ----------
let CRAWLS = { crawls: [], current: null };
const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
async function loadCrawls() { CRAWLS = await fetch('/api/crawls').then((r) => r.json()).catch(() => ({ crawls: [], current: null })); }
async function renderCrawls() {
  await loadCrawls();
  const projects = [...new Set(CRAWLS.crawls.map((c) => c.project).filter(Boolean))].sort();
  const sel = $('#crProject');
  const cur = sel.value;
  sel.innerHTML = `<option value="">${t('Todos os projetos')}</option>` + projects.map((p) => `<option ${p === cur ? 'selected' : ''}>${esc(p)}</option>`).join('');
  const list = CRAWLS.crawls.filter((c) => !sel.value || c.project === sel.value);
  $('#crList').innerHTML = list.length ? `<table class="crtable"><thead><tr><th></th><th>${t('Nome')}</th><th>${t('Projeto')}</th><th>${t('URL inicial')}</th>
      <th>${t('Salvo em')}</th><th class="num">URLs</th><th class="num">HTML</th><th>Status</th><th></th></tr></thead><tbody>` +
    list.map((c) => `<tr data-crawl="${c.id}"><td>${c.id === CRAWLS.current ? '●' : ''}</td><td class="nt">${esc(c.name)}</td><td class="nt">${esc(c.project || '')}</td>
      <td class="nt">${esc(c.start_url)}</td><td>${fmtDate(c.saved)}</td><td class="num">${c.urls}</td><td class="num">${c.html}</td><td>${esc(t({ finished: 'Concluído', stopped: 'Parado', error: 'Erro' }[c.status] || c.status))}</td>
      <td class="cractions"><button class="tbtn" data-cr="open">${t('Abrir')}</button><button class="tbtn" data-cr="rename">${t('Renomear')}</button>
      <button class="tbtn" data-cr="project">${t('Projeto')}</button><button class="tbtn" data-cr="export">${t('Exportar')}</button><button class="tbtn" data-cr="delete">${t('Excluir')}</button></td></tr>`).join('') + '</tbody></table>'
    : `<div class="empty">${t('Nenhum crawl salvo ainda. Os crawls são salvos ao terminar.')}</div>`;
}
$('#crProject').addEventListener('change', renderCrawls);
$('#crSave').addEventListener('click', async () => { await ACTIONS.savecrawl(); renderCrawls(); });
$('#crImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const r = await fetch('/api/crawls/import', { method: 'POST', body: f });
  if (!r.ok) { alert(t((await r.json().catch(() => ({}))).detail || 'Erro')); return; }
  await afterCrawlLoaded();
  renderCrawls();
});
async function afterCrawlLoaded() {
  Object.assign(S, { sel: null, multi: new Set(), custom: null, sort: null });
  detailCache.clear();
  sourceCache.clear();
  rateRef = null;
  await loadData();
  const st = await fetch('/api/status').then((r) => r.json());
  lastStatus = st;
  renderProgress(st);
  if (DATA.progress?.start_url) $('#url').value = DATA.progress.start_url;
  renderAll();
  window.onCrawlLoaded?.();
}
$('#crList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cr]');
  if (!b) return;
  const id = b.closest('[data-crawl]').dataset.crawl;
  const meta = CRAWLS.crawls.find((c) => c.id === id) || {};
  const act = b.dataset.cr;
  if (act === 'open') {
    b.disabled = true;
    b.textContent = t('Abrindo…');
    const r = await fetch(`/api/crawls/${id}/open`, { method: 'POST' });
    if (!r.ok) { alert(t((await r.json().catch(() => ({}))).detail || 'Erro')); renderCrawls(); return; }
    $('#crawlsModal').hidden = true;
    await afterCrawlLoaded();
  } else if (act === 'rename' || act === 'project') {
    const field = act === 'rename' ? 'name' : 'project';
    const v = window.prompt(t(act === 'rename' ? 'Novo nome do crawl:' : 'Projeto (deixe em branco para nenhum):'), meta[field] || '');
    if (v === null) return;
    await fetch(`/api/crawls/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: v.trim() }) });
    renderCrawls();
  } else if (act === 'export') download(`/api/crawls/${id}/export`);
  else if (act === 'delete') {
    if (!window.confirm(tf('Excluir o crawl “{{0}}”? Esta ação não pode ser desfeita.', meta.name))) return;
    await fetch(`/api/crawls/${id}`, { method: 'DELETE' });
    renderCrawls();
  }
});

// ---------- crawl comparison (Mode > Compare) ----------
let CMP = null;
let CMP_TAB = 'issues';
let CMP_SEL = null;
async function fillCompareSelects() {
  await loadCrawls();
  const opts = CRAWLS.crawls.map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(fmtDate(c.saved))} · ${c.urls} URLs</option>`).join('');
  $('#cmpPrev').innerHTML = opts;
  $('#cmpCurr').innerHTML = opts;
  if (CRAWLS.crawls.length > 1) {
    $('#cmpCurr').value = CRAWLS.current && CRAWLS.crawls.some((c) => c.id === CRAWLS.current) ? CRAWLS.current : CRAWLS.crawls[0].id;
    const prev = CRAWLS.crawls.find((c) => c.id !== $('#cmpCurr').value && c.start_url === CRAWLS.crawls.find((x) => x.id === $('#cmpCurr').value)?.start_url)
      || CRAWLS.crawls.find((c) => c.id !== $('#cmpCurr').value);
    $('#cmpPrev').value = prev.id;
  } else {
    $('#cmpBody').innerHTML = empty(t('São necessários pelo menos dois crawls salvos para comparar.'));
  }
}
$('#cmpRun').addEventListener('click', async () => {
  const prev = $('#cmpPrev').value, curr = $('#cmpCurr').value;
  if (!prev || !curr || prev === curr) { alert(t('Escolha dois crawls diferentes.')); return; }
  $('#cmpBody').innerHTML = empty(t('Comparando…'));
  const r = await fetch(`/api/compare?previous=${prev}&current_id=${curr}`);
  if (!r.ok) { $('#cmpBody').innerHTML = empty(t((await r.json().catch(() => ({}))).detail || 'Erro')); return; }
  CMP = await r.json();
  CMP_SEL = null;
  renderCompare();
});
$('#cmpTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmp]');
  if (!b) return;
  CMP_TAB = b.dataset.cmp;
  CMP_SEL = null;
  $$('#cmpTabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderCompare();
});
const urlTable = (urls) => urls.length ? `<table><tbody>${urls.map((u) => `<tr><td class="nt">${esc(u)}</td></tr>`).join('')}</tbody></table>` : empty(t('Nenhuma URL.'));
const delta = (n) => `<span class="${n > 0 ? 's4' : n < 0 ? 's2' : 'muted'}">${n > 0 ? '+' : ''}${n}</span>`;
function renderCompare() {
  const box = $('#cmpBody');
  if (!CMP) return;
  const head = `<div class="muted">${tf('Anterior: {{0}} ({{1}} URLs) · Atual: {{2}} ({{3}} URLs)', esc(CMP.previous.name), CMP.previous.urls, esc(CMP.current.name), CMP.current.urls)}</div>`;
  if (CMP_TAB === 'issues') {
    const sel = CMP_SEL && CMP.issues.find((i) => i.name === CMP_SEL.name);
    box.innerHTML = head + `<table class="cmptable"><thead><tr><th>${t('Problema')}</th><th>${t('Tipo')}</th><th>${t('Prioridade')}</th><th class="num">${t('Atual')}</th><th class="num">${t('Anterior')}</th>
      <th class="num">${t('Diferença')}</th><th class="num">${t('Adicionadas')}</th><th class="num">${t('Novas')}</th><th class="num">${t('Removidas')}</th><th class="num">${t('Ausentes')}</th></tr></thead><tbody>` +
      CMP.issues.map((i) => `<tr class="${sel === i ? 'on' : ''}" data-cmpi="${esc(i.name)}"><td>${esc(i.name)}</td><td><span class="pill ${i.type}">${i.type}</span></td><td>${i.priority}</td>
        <td class="num">${i.current}</td><td class="num">${i.previous}</td><td class="num">${delta(i.change)}</td>
        ${['added', 'new', 'removed', 'missing'].map((k) => `<td class="num"><a class="cmpk" data-k="${k}">${i[k].length}</a></td>`).join('')}</tr>`).join('') + '</tbody></table>' +
      (sel ? `<h4 class="sec">${esc(sel.name)} — ${t({ added: 'Adicionadas', new: 'Novas', removed: 'Removidas', missing: 'Ausentes' }[CMP_SEL.k])}</h4>` + urlTable(sel[CMP_SEL.k]) : '') +
      `<p class="muted">${t('Adicionadas: URLs que já existiam e passaram a ter o problema. Novas: URLs que não existiam no crawl anterior. Removidas: URLs que deixaram de ter o problema. Ausentes: URLs que tinham o problema e sumiram do crawl.')}</p>`;
  } else if (CMP_TAB === 'changes') {
    const sel = CMP.changes.find((c) => c.field === CMP_SEL) || CMP.changes.find((c) => c.count) || CMP.changes[0];
    CMP_SEL = sel.field;
    const fmt = (v) => esc(Array.isArray(v) ? v.join(', ') : v ?? '');
    box.innerHTML = head + `<div class="cmpsplit"><div class="cmplist">${CMP.changes.map((c) => `<div class="row ${c.field === sel.field ? 'active' : ''} ${c.count ? 'bad' : ''}" data-cmpf="${c.field}"><span>${esc(c.label)}</span><span class="n">${c.count}</span></div>`).join('')}</div>
      <div class="cmprows">${sel.rows.length ? `<table><thead><tr><th>URL</th><th>${t('Antes')}</th><th>${t('Depois')}</th>${sel.field === 'content' ? `<th class="num">${t('Similaridade')}</th>` : ''}</tr></thead><tbody>` +
        sel.rows.map((r) => `<tr><td class="nt">${esc(r.url)}</td><td class="nt">${fmt(r.before)}</td><td class="nt">${fmt(r.after)}</td>${sel.field === 'content' ? `<td class="num">${r.similarity ?? ''}${r.similarity != null ? '%' : ''}</td>` : ''}</tr>`).join('') + '</tbody></table>'
        : empty(t('Nenhuma mudança.'))}</div></div>`;
  } else {
    box.innerHTML = head + urlTable(CMP_TAB === 'new' ? CMP.new_urls : CMP.missing_urls);
  }
}
$('#cmpBody').addEventListener('click', (e) => {
  const k = e.target.closest('.cmpk');
  const row = e.target.closest('[data-cmpi]');
  const f = e.target.closest('[data-cmpf]');
  if (k && row) { CMP_SEL = { name: row.dataset.cmpi, k: k.dataset.k }; renderCompare(); }
  else if (f) { CMP_SEL = f.dataset.cmpf; renderCompare(); }
});
$('#cmpMain').addEventListener('click', async () => {
  if (!CMP) { alert(t('Clique em Comparar primeiro.')); return; }
  if (CRAWLS.current !== CMP.current.id) {
    if (!confirm(t('O crawl “atual” da comparação não está aberto na tela principal. Abrir agora?'))) return;
    const r = await fetch(`/api/crawls/${CMP.current.id}/open`, { method: 'POST' });
    if (!r.ok) { alert(t((await r.json().catch(() => ({}))).detail || 'Erro')); return; }
    await afterCrawlLoaded();
  }
  MAIN_CMP = CMP;
  const pd = await fetch(`/api/crawls/${CMP.previous.id}/data`);
  PREV = pd.ok ? buildPrev(await pd.json()) : null;
  syncCmpUi();
  $('#compareModal').hidden = true;
  setView('changes', 'all');
});
$('#cmpExport').addEventListener('click', () => {
  if (!CMP) return;
  if (CMP_TAB === 'issues') {
    exportCsv(CMP.issues.map((i) => ({ ...i, added: i.added.length, new: i.new.length, removed: i.removed.length, missing: i.missing.length })),
      [['name', 'Problema'], ['type', 'Tipo'], ['priority', 'Prioridade'], ['current', 'Atual'], ['previous', 'Anterior'], ['change', 'Diferença'],
        ['added', 'Adicionadas'], ['new', 'Novas'], ['removed', 'Removidas'], ['missing', 'Ausentes']].map(([key, label]) => ({ key, label })), 'comparacao-problemas');
  } else if (CMP_TAB === 'changes') {
    const sel = CMP.changes.find((c) => c.field === CMP_SEL);
    exportCsv(sel.rows, [{ key: 'url', label: 'URL' }, { key: 'before', label: 'Antes' }, { key: 'after', label: 'Depois' }], 'comparacao-' + sel.field);
  } else {
    exportCsv((CMP_TAB === 'new' ? CMP.new_urls : CMP.missing_urls).map((url) => ({ url })), [{ key: 'url', label: 'URL' }], 'comparacao-' + CMP_TAB);
  }
});

// ---------- configuration profiles (File > Configuration > Save/Load) ----------
let PROFILES = store.get('seo-spider-profiles', {});
function currentRawConfig() {
  const raw = {};
  for (const el of formFields()) if (!('nosave' in el.dataset)) raw[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  raw._snippets = SNIPPETS;
  return raw;
}
function applyRawConfig(raw) {
  for (const el of formFields()) {
    if (!(el.name in raw)) continue;
    if (el.type === 'checkbox') el.checked = raw[el.name]; else el.value = raw[el.name];
  }
  if (Array.isArray(raw._snippets)) { SNIPPETS = raw._snippets; saveSnippets(); }
  window.cfgSync?.();
  syncMode();
  syncUaPreset();
  saveConfig();
}
const touchRecent = (name) => store.set('seo-spider-profiles-recent', [name, ...store.get('seo-spider-profiles-recent', []).filter((n) => n !== name)].slice(0, 10));
function renderRecent() {
  const names = store.get('seo-spider-profiles-recent', []).filter((n) => PROFILES[n]);
  for (const n of Object.keys(PROFILES).sort()) if (!names.includes(n)) names.push(n);
  $('#recentProfiles').innerHTML = names.length ? names.slice(0, 10).map((n) => `<a data-act="profrecent" data-name="${esc(n)}">${esc(n)}</a>`).join('')
    : `<a class="muted">${t('Nenhum perfil salvo')}</a>`;
}
function renderProfiles() {
  renderRecent();
  $('#profSel').innerHTML = `<option value="">—</option>` + Object.keys(PROFILES).sort().map((n) => `<option>${esc(n)}</option>`).join('');
}
$('#profSave').addEventListener('click', () => {
  const name = window.prompt(t('Nome do perfil:'), $('#profSel').value || '');
  if (!name) return;
  PROFILES[name.trim()] = currentRawConfig();
  store.set('seo-spider-profiles', PROFILES);
  renderProfiles();
  $('#profSel').value = name.trim();
});
$('#profLoad').addEventListener('click', () => {
  const p = PROFILES[$('#profSel').value];
  if (p) applyRawConfig(p);
});
$('#profDel').addEventListener('click', () => {
  const n = $('#profSel').value;
  if (!n || !window.confirm(tf('Excluir o perfil “{{0}}”?', n))) return;
  delete PROFILES[n];
  store.set('seo-spider-profiles', PROFILES);
  renderProfiles();
});
$('#profExport').addEventListener('click', () => {
  const n = $('#profSel').value;
  const data = { format: 'seo-spider-config', name: n || 'config', config: n ? PROFILES[n] : currentRawConfig() };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `${(n || 'config').replace(/[^\w.-]+/g, '-')}.seospiderconfig.json`;
  a.click();
});
$('#profImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.format !== 'seo-spider-config' || typeof data.config !== 'object') throw new Error();
    PROFILES[data.name || f.name] = data.config;
    store.set('seo-spider-profiles', PROFILES);
    touchRecent(data.name || f.name);
    renderProfiles();
    $('#profSel').value = data.name || f.name;
    applyRawConfig(data.config);
  } catch { alert(t('Arquivo de configuração inválido.')); }
});
renderProfiles();
function cliConfig() {
  const cfg = readConfig();
  cfg.auth_pass = '';
  return cfg;
}
$('#profCli').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ format: 'seo-spider-crawl-config', config: cliConfig() }, null, 2)], { type: 'application/json' }));
  a.download = `${($('#profSel').value || 'crawl').replace(/[^\w.-]+/g, '-')}.cli.json`;
  a.click();
});

// ---------- scheduling (File > Scheduling) ----------
const FREQ = { once: 'Uma vez', daily: 'Diária', weekly: 'Semanal', monthly: 'Mensal' };
let SCHEDS = [];
let APP_DIR = '';
const fmtTs = (s) => (s ? new Date(s * 1000).toLocaleString() : '—');
function syncSchedForm() {
  const f = $('#schedForm').frequency.value;
  $$('#schedForm [data-f]').forEach((el) => { el.hidden = el.dataset.f !== f; });
  const url = $('#schedForm').url.value || 'https://www.exemplo.com';
  const exps = $$('#schedForm .schedexp input:checked').map((x) => x.value).join(',');
  const out = $('#schedForm').output_dir.value;
  const fm = $('#schedForm');
  const extra = (fm.project.value ? ` --project "${fm.project.value}"` : '') + (fm.auto_compare.checked ? ' --compare-previous' : '') + (fm.skip_empty.checked ? ' --skip-empty' : '');
  const cmd = `"${APP_DIR}\\cli.bat" ${url}${exps ? ' --export ' + exps : ''}${out ? ` --output "${out}"` : ''}${extra}`;
  const sc = { once: 'ONCE', daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' }[f];
  $('#schedCli').textContent = `${cmd}\n\nschtasks /Create /TN "SEO Spider - ${$('#schedForm').name.value}" /SC ${sc} /ST ${$('#schedForm').time.value} /TR "${cmd.replace(/"/g, '\\"')}"`;
}
function resetSchedForm() {
  const f = $('#schedForm');
  f.reset();
  f.id.value = '';
  f.url.value = $('#url').value;
  f.profile.innerHTML = `<option value="">${t('Configuração atual')}</option>` + Object.keys(PROFILES).sort().map((n) => `<option>${esc(n)}</option>`).join('');
  syncSchedForm();
}
async function openSchedules() {
  const r = await fetch('/api/schedules').then((x) => x.json());
  SCHEDS = r.items;
  APP_DIR = r.app_dir;
  $('#schedForm').output_dir.placeholder = r.export_dir;
  $('#schedList').innerHTML = SCHEDS.length ? `<table><thead><tr><th>${t('Nome')}</th><th>URL</th><th>${t('Frequência')}</th><th>${t('Próxima execução')}</th><th>${t('Última execução')}</th><th>${t('Status')}</th><th></th></tr></thead><tbody>` +
    SCHEDS.map((s) => `<tr><td class="nt">${esc(s.name)}${s.enabled ? '' : ` <span class="muted">(${t('inativo')})</span>`}</td><td class="nt">${esc(s.config.start_url || tf('{{0}} URLs (lista)', s.config.url_list.length))}</td>
      <td>${t(FREQ[s.frequency])} ${esc(s.time)}</td><td>${fmtTs(s.next_run)}</td><td>${fmtTs(s.last_run)}</td>
      <td>${r.running === s.id ? t('Em execução…') : esc(s.last_status ? t(STATUS_TXT[s.last_status] || s.last_status) : '')}${s.last_error ? ` <span class="s4" title="${esc(s.last_error)}">⚠</span>` : ''}${s.last_compare ? `<div class="muted">${esc(tf('Comparado com "{{0}}": {{1}} problemas pioraram, {{2}} melhoraram', s.last_compare.previous_name, s.last_compare.worse, s.last_compare.better))}</div>` : ''}${s.last_output ? `<div class="muted">${esc(s.last_output)}</div>` : ''}</td>
      <td class="nowrap"><button class="tbtn" data-srun="${s.id}">${t('Executar agora')}</button> <button class="tbtn" data-sedit="${s.id}">${t('Editar')}</button> <button class="tbtn" data-sdel="${s.id}">✕</button></td></tr>`).join('') + '</tbody></table>'
    : empty(t('Nenhum agendamento.'));
  if (!$('#schedForm').id.value) resetSchedForm();
}
const STATUS_TXT = { finished: 'Concluído', stopped: 'Parado', error: 'Erro', running: 'Em execução…' };
$('#schedForm').addEventListener('input', syncSchedForm);
$('#schedNew').addEventListener('click', resetSchedForm);
$('#schedList').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.srun) {
    const r = await fetch(`/api/schedules/${b.dataset.srun}/run`, { method: 'POST' });
    if (!r.ok) alert(t((await r.json()).detail));
    setTimeout(openSchedules, 500);
  } else if (b.dataset.sdel) {
    if (!confirm(t('Excluir este agendamento?'))) return;
    await fetch(`/api/schedules/${b.dataset.sdel}`, { method: 'DELETE' });
    openSchedules();
  } else if (b.dataset.sedit) {
    const s = SCHEDS.find((x) => x.id === b.dataset.sedit);
    const f = $('#schedForm');
    resetSchedForm();
    for (const k of ['id', 'name', 'project', 'frequency', 'date', 'time', 'weekday', 'day', 'output_dir']) f[k].value = s[k] ?? '';
    f.enabled.checked = s.enabled;
    f.auto_compare.checked = !!s.auto_compare;
    f.skip_empty.checked = !!s.skip_empty;
    f.url.value = s.config.start_url;
    $$('#schedForm .schedexp input').forEach((x) => { x.checked = s.exports.includes(x.value); });
    f.dataset.config = JSON.stringify(s.config);
    syncSchedForm();
  }
});
$('#schedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  let config;
  if (f.profile.value && PROFILES[f.profile.value]) {
    const saved = currentRawConfig();
    applyRawConfig(PROFILES[f.profile.value]);
    config = cliConfig();
    applyRawConfig(saved);
  } else if (f.id.value && f.dataset.config) {
    config = JSON.parse(f.dataset.config);
  } else {
    config = cliConfig();
  }
  if (f.url.value.trim()) { config.start_url = f.url.value.trim(); config.mode = 'spider'; }
  const body = { id: f.id.value, name: f.name.value, enabled: f.enabled.checked, frequency: f.frequency.value, date: f.date.value,
    time: f.time.value, weekday: +f.weekday.value, day: +f.day.value || 1, project: f.project.value, output_dir: f.output_dir.value.trim(),
    exports: $$('#schedForm .schedexp input:checked').map((x) => x.value), lang: LANG, config,
    auto_compare: f.auto_compare.checked, skip_empty: f.skip_empty.checked };
  const r = await fetch('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json(); alert(typeof j.detail === 'string' ? t(j.detail) : JSON.stringify(j.detail)); return; }
  delete f.dataset.config;
  f.id.value = '';
  openSchedules();
});

let FACTORY_CFG = {};
// ---------- boot ----------
I18N_READY.then(async () => {
  await loadApis();
  $$('[data-act="lang"]').forEach((a) => a.classList.toggle('on', a.dataset.lang === LANG));
  syncUaPreset();
  FACTORY_CFG = currentRawConfig();
  loadConfig();
  const def = store.get('seo-spider-default-cfg', null);
  if (def) applyRawConfig(def);
  applyLayout();
  initSplit($('#vsplit'), 'v');
  initSplit($('#hsplit'), 'h');
  syncMode();
  syncSearchOpts();
  renderAll();
  poll();
});
