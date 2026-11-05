// System library of Custom JavaScript snippets (Configuração → JavaScript personalizado → Adicionar da biblioteca).
// Snippets run inside the crawled page (Chromium) as the body of an async function, with `seoSpider` in scope:
//   seoSpider.data(value)            → returns the value to the crawl (string, number, list or object)
//   seoSpider.error(message)         → marks the snippet as failed for this URL
//   seoSpider.openai(prompt, content, { model, image, system, temperature, max_tokens })
//                                    → calls the OpenAI chat API with the key from the API tab (never exposed to the page)
const JS_LIBRARY = [
  {
    name: '(ChatGPT) Template',
    description: 'Modelo para criar seus próprios prompts: edite o prompt e o conteúdo da página enviado.',
    type: 'extraction', content_type: 'text/html', timeout: 60,
    code: `// Prompt enviado ao ChatGPT
const prompt = 'O que você acha do texto a seguir?:';

// Conteúdo da página enviado junto com o prompt (escolha uma opção)
const content = document.body.innerText;
// const content = document.documentElement.outerHTML;
// const content = document.title;
// const content = document.querySelector('meta[name="description"]')?.content || '';
// const content = [...document.querySelectorAll('h1, h2')].map((h) => h.innerText).join('\\n');

const answer = await seoSpider.openai(prompt, content.slice(0, 12000), { model: 'gpt-4o-mini' });
return seoSpider.data(answer);`,
  },
  {
    name: '(ChatGPT) Gerar texto alt para imagens',
    description: 'Envia cada imagem rastreada para um modelo com visão e gera um texto alternativo. Tipo de conteúdo: image/.',
    type: 'extraction', content_type: 'image/', timeout: 60,
    code: `const prompt = 'Escreva um texto alternativo (alt) conciso e descritivo para esta imagem, com no máximo 125 caracteres. Responda apenas com o texto.';
const answer = await seoSpider.openai(prompt, '', { model: 'gpt-4o-mini', image: location.href });
return seoSpider.data(answer.trim());`,
  },
  {
    name: '(ChatGPT) Gerar meta description',
    description: 'Cria uma meta description de até 155 caracteres a partir do conteúdo da página.',
    type: 'extraction', content_type: 'text/html', timeout: 60,
    code: `const prompt = 'Escreva uma meta description atraente, com no máximo 155 caracteres, no idioma da página, para o conteúdo abaixo. Responda apenas com a meta description.';
const content = document.title + '\\n\\n' + document.body.innerText.slice(0, 8000);
return seoSpider.data((await seoSpider.openai(prompt, content, { model: 'gpt-4o-mini' })).trim());`,
  },
  {
    name: '(ChatGPT) Sugerir title otimizado',
    description: 'Sugere um title de até 60 caracteres com base no conteúdo e no title atual.',
    type: 'extraction', content_type: 'text/html', timeout: 60,
    code: `const prompt = 'Sugira um title de SEO com no máximo 60 caracteres, no idioma da página. Title atual: "' + document.title + '". Responda apenas com o novo title.';
return seoSpider.data((await seoSpider.openai(prompt, document.body.innerText.slice(0, 8000), { model: 'gpt-4o-mini' })).trim());`,
  },
  {
    name: '(ChatGPT) Classificar intenção de busca',
    description: 'Classifica a intenção da página: informacional, navegacional, comercial ou transacional.',
    type: 'extraction', content_type: 'text/html', timeout: 60,
    code: `const prompt = 'Classifique a intenção de busca desta página em uma única palavra: informacional, navegacional, comercial ou transacional.';
const content = document.title + '\\n' + document.body.innerText.slice(0, 6000);
return seoSpider.data((await seoSpider.openai(prompt, content, { model: 'gpt-4o-mini', temperature: 0 })).trim().toLowerCase());`,
  },
  {
    name: '(ChatGPT) Análise de sentimento',
    description: 'Classifica o tom do conteúdo como positivo, neutro ou negativo.',
    type: 'extraction', content_type: 'text/html', timeout: 60,
    code: `const prompt = 'Classifique o sentimento do texto em uma única palavra: positivo, neutro ou negativo.';
return seoSpider.data((await seoSpider.openai(prompt, document.body.innerText.slice(0, 6000), { model: 'gpt-4o-mini', temperature: 0 })).trim().toLowerCase());`,
  },
  {
    name: '(ChatGPT) Extrair entidades',
    description: 'Lista as principais entidades (pessoas, empresas, lugares, produtos) citadas na página.',
    type: 'extraction', content_type: 'text/html', timeout: 60,
    code: `const prompt = 'Liste as 10 principais entidades (pessoas, organizações, lugares, produtos) citadas no texto, separadas por vírgula. Responda apenas com a lista.';
return seoSpider.data((await seoSpider.openai(prompt, document.body.innerText.slice(0, 10000), { model: 'gpt-4o-mini', temperature: 0 })).trim());`,
  },
  {
    name: '(ChatGPT) Detectar idioma',
    description: 'Identifica o idioma principal do conteúdo (código ISO, ex.: pt-BR).',
    type: 'extraction', content_type: 'text/html', timeout: 60,
    code: `const prompt = 'Qual é o idioma principal deste texto? Responda apenas com o código BCP 47 (ex.: pt-BR, en-US, es).';
return seoSpider.data((await seoSpider.openai(prompt, document.body.innerText.slice(0, 2000), { model: 'gpt-4o-mini', temperature: 0 })).trim());`,
  },
  {
    name: 'Rolar até o fim da página (ação)',
    description: 'Rola a página até o fim para carregar conteúdo com lazy-load antes da extração.',
    type: 'action', content_type: 'text/html', timeout: 20,
    code: `for (let i = 0; i < 10; i++) {
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 500));
}
window.scrollTo(0, 0);
return seoSpider.data('ok');`,
  },
  {
    name: 'Aceitar banner de cookies (ação)',
    description: 'Clica no botão de aceitar cookies, se existir, antes da extração.',
    type: 'action', content_type: 'text/html', timeout: 10,
    code: `const re = /^(aceitar|aceito|accept|accept all|agree|i agree|ok|entendi|got it|aceptar)/i;
const btn = [...document.querySelectorAll('button, a, [role="button"]')].find((b) => re.test(b.innerText.trim()));
if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 800)); }
return seoSpider.data(btn ? 'clicado' : 'não encontrado');`,
  },
  {
    name: 'Contar palavras renderizadas',
    description: 'Conta as palavras do texto visível depois da renderização do JavaScript.',
    type: 'extraction', content_type: 'text/html', timeout: 10,
    code: `const words = document.body.innerText.trim().split(/\\s+/).filter(Boolean);
return seoSpider.data(words.length);`,
  },
  {
    name: 'Extrair H2 renderizados',
    description: 'Lista os H2 presentes no DOM renderizado.',
    type: 'extraction', content_type: 'text/html', timeout: 10,
    code: `return seoSpider.data([...document.querySelectorAll('h2')].map((h) => h.innerText.trim()).filter(Boolean));`,
  },
  {
    name: 'Detectar texto lorem ipsum',
    description: 'Indica páginas que ainda contêm texto de exemplo (lorem ipsum).',
    type: 'extraction', content_type: 'text/html', timeout: 10,
    code: `return seoSpider.data(/lorem ipsum/i.test(document.body.innerText) ? 'lorem ipsum encontrado' : '');`,
  },
  {
    name: 'Listar scripts de terceiros',
    description: 'Lista os domínios externos de onde a página carrega scripts.',
    type: 'extraction', content_type: 'text/html', timeout: 10,
    code: `const hosts = new Set([...document.scripts].map((s) => s.src).filter(Boolean)
  .map((u) => new URL(u, location.href).host).filter((h) => h !== location.host));
return seoSpider.data([...hosts]);`,
  },
  {
    name: 'Detectar Google Tag Manager / gtag',
    description: 'Verifica se o GTM ou o gtag (GA4) estão instalados na página.',
    type: 'extraction', content_type: 'text/html', timeout: 10,
    code: `const found = [];
if (window.google_tag_manager || document.querySelector('script[src*="googletagmanager.com/gtm.js"]')) found.push('GTM');
if (typeof window.gtag === 'function' || document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) found.push('gtag');
return seoSpider.data(found.join(', ') || 'nenhum');`,
  },
  {
    name: 'Tipos de JSON-LD renderizado',
    description: 'Lista os @type de JSON-LD presentes no DOM renderizado (inclui os injetados por JavaScript).',
    type: 'extraction', content_type: 'text/html', timeout: 10,
    code: `const types = [];
for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
  try {
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o['@type']) types.push([].concat(o['@type']).join('/')); Object.values(o).forEach(walk); } };
    walk(JSON.parse(s.textContent));
  } catch (e) { types.push('JSON inválido'); }
}
return seoSpider.data(types);`,
  },
];

// AI prompt presets (API tab → OpenAI / Gemini / Ollama / Anthropic → Prompts → Adicionar da biblioteca)
const AI_PROMPT_LIBRARY = [
  { name: 'Gerar meta description', type: 'chat', content: 'page_text', prompt: 'Escreva uma meta description atraente, com no máximo 155 caracteres e no idioma da página, para o conteúdo abaixo. Responda apenas com a meta description.' },
  { name: 'Sugerir title otimizado', type: 'chat', content: 'page_text', prompt: 'Sugira um title de SEO com no máximo 60 caracteres, no idioma da página, para o conteúdo abaixo. Responda apenas com o title.' },
  { name: 'Classificar intenção de busca', type: 'chat', content: 'page_text', prompt: 'Classifique a intenção de busca desta página em uma única palavra: informacional, navegacional, comercial ou transacional.' },
  { name: 'Detectar idioma', type: 'chat', content: 'page_text', prompt: 'Qual é o idioma principal deste texto? Responda apenas com o código BCP 47 (ex.: pt-BR, en-US, es).' },
  { name: 'Análise de sentimento', type: 'chat', content: 'page_text', prompt: 'Classifique o sentimento do texto em uma única palavra: positivo, neutro ou negativo.' },
  { name: 'Detectar conteúdo impróprio', type: 'chat', content: 'page_text', prompt: 'O texto abaixo contém conteúdo impróprio, ofensivo, adulto ou ilegal? Responda "sim" ou "não" e, se sim, o motivo em até 10 palavras.' },
  { name: 'Extrair entidades', type: 'chat', content: 'page_text', prompt: 'Liste as 10 principais entidades (pessoas, organizações, lugares, produtos) citadas no texto, separadas por vírgula. Responda apenas com a lista.' },
  { name: 'Resumir a página', type: 'chat', content: 'page_text', prompt: 'Resuma em uma frase o assunto principal desta página.' },
  { name: 'Avaliar title e meta description', type: 'chat', content: 'title_meta', prompt: 'Avalie o title, a meta description e o H1 abaixo para SEO (nota de 0 a 10) e sugira uma melhoria em uma frase.' },
  { name: 'Embeddings da página', type: 'embeddings', content: 'page_text', prompt: '' },
];
