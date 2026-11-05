# Security Policy / Politica de seguranca

## Versoes suportadas

Correcoes de seguranca sao aplicadas na branch `main` (ultima versao). Nao mantemos
branches antigas.

## Como reportar uma vulnerabilidade

**Nao abra uma issue publica.** Use o canal privado do GitHub:

Advisory de seguranca: https://github.com/PChiovatto/seo-spider/security/advisories/new

Inclua, se possivel:

- versao / commit afetado;
- passos para reproduzir (idealmente com um site de teste local ou HTML minimo);
- impacto esperado (por exemplo: execucao de codigo, leitura de ficheiros fora de `data/`, vazamento de chaves de API, acesso pela rede).

Respondemos assim que possivel e daremos credito no advisory, se quiser.

## Modelo de seguranca do app

O SEO Spider foi desenhado para rodar **apenas na sua maquina**:

- O servidor escuta so em `127.0.0.1` (app principal, por padrao na porta 8765, e o servidor MCP, na porta 11435).
- Chaves de API, cookies, crawls salvos e agendamentos ficam em `data/`, que esta no `.gitignore` e nunca e versionado.
- O endpoint MCP valida a origem (`localhost`/`127.0.0.1`) para travar ataques de DNS-rebinding.
- O inspetor da Extracao Visual abre a pagina de destino num `iframe` com `sandbox="allow-same-origin"` (sem scripts).
- A renderizacao JavaScript usa um Chromium isolado e so acontece quando essa opcao e ativada.

## Boas praticas para quem usa

- Nao exponha a porta 8765 na rede (nem com reverso proxy): o app nao tem autenticacao de usuarios.
- Trate `data/integrations.json` e `data/form_auth.json` como credenciais.
- Rastreie so sites que voce tem permissao para analisar.

## Dependencias

O repositorio usa Dependabot para atualizacoes de `pip` e de GitHub Actions. A suite de
testes roda em cada push e pull request.
