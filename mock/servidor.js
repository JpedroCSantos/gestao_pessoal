'use strict';

/**
 * O app rodando na sua máquina, sem Google nenhum.
 *
 * **Não é uma cópia do projeto — é o projeto.** Os arquivos de `src/` são carregados como
 * estão, sobre os mesmos dublês que os testes usam. Uma correção no `CamadaDeAcesso.js`
 * aparece aqui na próxima execução, sem ninguém copiar nada.
 *
 * O que este arquivo faz é só o encanamento que o Google faria:
 *
 *   navegador ──> GET /            ──> doGet() do WebApp.js, com os scriptlets resolvidos
 *             ──> GET /mock/ponte  ──> o shim de google.script.run
 *             ──> POST /api        ──> a função do projeto, pelo nome
 *
 * Sem dependência nenhuma: `http` e `fs` do próprio Node.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { carregarProjeto, SRC } = require('./emulador');
const { criarPasta, criarArquivo } = require('./apps-script');
const { semear, RESUMOS, isoDe } = require('./semente');

const PORTA = Number(process.env.PORTA || 8080);
const INBOX_LOCAL = path.join(__dirname, 'inbox');

/* ==========================================================================
   MONTAGEM
   ========================================================================== */

/**
 * Sobe o projeto: pastas do Drive, Script Properties, abas provisionadas e dados.
 *
 * A ordem é a mesma que você seguiria numa instalação de verdade — e é de propósito: se
 * um `setupXxx` quebrar, quebra aqui antes de quebrar na conta do Google.
 */
function montar() {
  const pastas = {
    inbox: criarPasta('inbox'),
    processados: criarPasta('processados'),
    erros: criarPasta('erros'),
    painel: criarPasta('painel'),
    resumos: criarPasta('Resumos'),
  };

  const projeto = carregarProjeto({
    pastas: pastas,
    propriedades: {
      INBOX_FOLDER_ID: pastas.inbox.getId(),
      PROCESSADOS_FOLDER_ID: pastas.processados.getId(),
      ERROS_FOLDER_ID: pastas.erros.getId(),
      PAINEL_FOLDER_ID: pastas.painel.getId(),
      RESUMOS_FOLDER_ID: pastas.resumos.getId(),
    },
  });

  projeto.setupKanban();
  projeto.setupPessoas();
  projeto.setupAnotacoes();
  projeto.setupLog();

  const contagens = semear(projeto);
  semearResumos(pastas.resumos);
  semearPaineis(pastas.painel);
  ensinarHtmlService(projeto);

  return { projeto, pastas, contagens };
}

/** Um Doc por compilação, dentro da pasta da pessoa — a estrutura que o `Resumos.js` lê. */
function semearResumos(raiz) {
  Object.keys(RESUMOS).forEach((nome) => {
    const pasta = criarPasta(nome, raiz);
    Object.keys(RESUMOS[nome]).forEach((desloc) => {
      criarArquivo(isoDe(Number(desloc)), RESUMOS[nome][desloc], pasta);
    });
  });
}

/**
 * Os painéis que a `rotina-semanal` escreveria.
 *
 * Existem para a rota `?view=` não ser uma tela de aviso na demonstração — mas o conteúdo
 * é propositalmente magro: quem escreve prosa ali é uma skill, no claude.ai, e ela não
 * roda fora de lá.
 */
function semearPaineis(pasta) {
  const pagina = (titulo, corpo) =>
    '<!doctype html><meta charset="utf-8"><title>' + titulo + '</title>' +
    '<body style="font:15px/1.6 system-ui;max-width:52rem;margin:3rem auto;padding:0 1.5rem;color:#111827">' +
    '<h1 style="font-size:20px">' + titulo + '</h1>' + corpo +
    '<p style="margin-top:2rem;padding:12px 14px;background:#eef2ff;border-radius:10px;font-size:13.5px">' +
    'Painel de exemplo. No sistema real quem escreve este arquivo é a skill ' +
    '<code>rotina-semanal</code>, que roda no claude.ai e não faz parte da execução local.' +
    '</p></body>';

  criarArquivo('semana.html', pagina('Semana',
    '<p>O que travou, o que virou urgente e o que atravessou a semana sem sair do lugar.</p>'), pasta);
  criarArquivo('mes.html', pagina('Mês',
    '<p>O arco do mês: volume de delegação, o que mudou de estado e o que ficou parado.</p>'), pasta);
}

/**
 * Ensina o `HtmlService` fake a servir o arquivo de verdade.
 *
 * O dublê dos testes devolve um marcador (`<template:Index>`) porque lá o que importa é
 * *qual* arquivo foi escolhido. Aqui precisa ser o HTML real, com os scriptlets resolvidos —
 * é a única diferença entre o ambiente de teste e o de demonstração.
 *
 * Funciona por mutação porque o projeto fechou sobre o objeto `HtmlService`, e não sobre
 * os métodos dele.
 */
function ensinarHtmlService(projeto) {
  projeto.HtmlService.createTemplateFromFile = function (nome) {
    const fonte = fs.readFileSync(path.join(SRC, nome + '.html'), 'utf8');
    return {
      evaluate: () => projeto.HtmlService.createHtmlOutput(resolverScriptlets(fonte, projeto)),
    };
  };
}

/**
 * Resolve os `<?!= ... ?>` do template.
 *
 * Só entende `JSON.stringify(CONSTANTE)`, que é a única forma que o `Index.html` usa.
 * Qualquer outra coisa levanta erro em vez de sair como texto na página — scriptlet que
 * vaza para o HTML é um bug que só aparece quando alguém olha o fonte da tela.
 */
function resolverScriptlets(fonte, projeto) {
  return fonte.replace(/<\?!=\s*([\s\S]*?)\s*\?>/g, (todo, expressao) => {
    const achado = expressao.match(/^JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*\)$/);
    if (!achado) {
      throw new Error('mock: scriptlet não suportado — ' + todo);
    }
    const nome = achado[1];
    if (!(nome in projeto)) {
      throw new Error('mock: o scriptlet pede "' + nome + '", que o projeto não declara.');
    }
    return JSON.stringify(projeto[nome]);
  });
}

/* ==========================================================================
   A SUPERFÍCIE CHAMÁVEL
   ========================================================================== */

/**
 * As funções que o `POST /api` aceita.
 *
 * A regra é a mesma do Apps Script de verdade: **toda função global sem sufixo `_` é
 * chamável pelo cliente.** Reproduzir isso aqui é o ponto — se um dia alguém expuser sem
 * querer uma função que não devia, o comportamento local é o mesmo do publicado.
 */
function funcoesPublicas(projeto) {
  return Object.keys(projeto)
    .filter((nome) => typeof projeto[nome] === 'function')
    .filter((nome) => !nome.startsWith('_') && !nome.endsWith('_'))
    .sort();
}

/* ==========================================================================
   O INBOX DE VERDADE, EM DISCO
   ========================================================================== */

/**
 * Copia o que estiver em `mock/inbox/` para a pasta fake antes de processar.
 *
 * É o que torna a metade invisível do sistema demonstrável: largar um `.json` naquela
 * pasta e clicar Sincronizar é exatamente o que uma skill faz pelo conector do Drive.
 *
 * Roda a cada `processarInbox`, e não no boot, para o arquivo largado com o servidor no ar
 * ser visto sem reiniciar. Arquivo já copiado não volta — o inbox fake é esvaziado pelo
 * próprio processamento, e a marca fica aqui.
 */
const jaCopiados = new Set();

function sincronizarInboxLocal(pastaInbox) {
  if (!fs.existsSync(INBOX_LOCAL)) return 0;

  const novos = fs.readdirSync(INBOX_LOCAL)
    .filter((nome) => nome.endsWith('.json') && !jaCopiados.has(nome));

  novos.forEach((nome) => {
    criarArquivo(nome, fs.readFileSync(path.join(INBOX_LOCAL, nome), 'utf8'), pastaInbox);
    jaCopiados.add(nome);
  });

  return novos.length;
}

/* ==========================================================================
   HTTP
   ========================================================================== */

function iniciar() {
  const { projeto, pastas, contagens } = montar();
  const publicas = funcoesPublicas(projeto);

  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/mock/ponte.js') {
      return responder(res, 200, 'application/javascript',
        fs.readFileSync(path.join(__dirname, 'ponte.js')));
    }

    if (req.method === 'POST' && url.pathname === '/api') {
      return lerCorpo(req, (corpo) => despachar(projeto, pastas, publicas, corpo, res));
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/exec')) {
      return servirPagina(projeto, publicas, url, res);
    }

    responder(res, 404, 'text/plain; charset=utf-8', 'Não existe aqui.');
  });

  servidor.listen(PORTA, () => {
    console.log('');
    console.log('  Gestão — execução local');
    console.log('  ' + '-'.repeat(46));
    console.log('  http://localhost:' + PORTA);
    console.log('');
    console.log('  ' + contagens.cards + ' cards · ' + contagens.pessoas + ' pessoas · ' +
      contagens.anotacoes + ' anotações (tudo fictício)');
    console.log('  ' + publicas.length + ' funções expostas ao navegador');
    console.log('');
    console.log('  Painéis:   /?view=semana   /?view=mes');
    console.log('  Inbox:     largue um .json em mock/inbox/ e clique Sincronizar');
    console.log('');
    console.log('  Ctrl+C para parar.');
    console.log('');
  });
}

/** A página, pelo `doGet` de verdade — inclusive as rotas `?view=`. */
function servirPagina(projeto, publicas, url, res) {
  const evento = { parameter: {} };
  url.searchParams.forEach((valor, chave) => { evento.parameter[chave] = valor; });

  let html;
  try {
    html = projeto.doGet(evento).getContent();
  } catch (err) {
    return responder(res, 500, 'text/plain; charset=utf-8',
      'Erro no doGet:\n\n' + (err && err.stack ? err.stack : err));
  }

  responder(res, 200, 'text/html; charset=utf-8', injetarPonte(html, publicas));
}

/**
 * Injeta a ponte antes do primeiro `<script>` da página.
 *
 * Antes, e não depois: o script do `Index.html` chama `google.script.run` já no carregamento
 * (`carregarCards()`, `carregarPessoas()`), então a ponte precisa existir antes dele.
 *
 * Página sem `<script>` — os painéis `?view=` — passa direto: ela não fala com o servidor.
 */
function injetarPonte(html, publicas) {
  const marca = '<script>';
  const onde = html.indexOf(marca);
  if (onde < 0) return html;

  const injecao =
    '<script>window.__FUNCOES_DO_SERVIDOR__ = ' + JSON.stringify(publicas) + ';</script>\n' +
    '<script src="/mock/ponte.js"></script>\n';

  return html.slice(0, onde) + injecao + html.slice(onde);
}

/** `{funcao, args}` → a função do projeto. */
function despachar(projeto, pastas, publicas, corpo, res) {
  let pedido;
  try {
    pedido = JSON.parse(corpo || '{}');
  } catch (err) {
    return json(res, 400, { ok: false, erro: 'corpo não é JSON.' });
  }

  const funcao = String(pedido.funcao || '');
  if (publicas.indexOf(funcao) < 0) {
    return json(res, 404, { ok: false, erro: 'O projeto não expõe "' + funcao + '".' });
  }

  if (funcao === 'processarInbox') {
    const copiados = sincronizarInboxLocal(pastas.inbox);
    if (copiados) console.log('  [inbox] ' + copiados + ' arquivo(s) de mock/inbox/');
  }

  try {
    const valor = projeto[funcao].apply(null, pedido.args || []);
    json(res, 200, { ok: true, valor: valor === undefined ? null : valor });
  } catch (err) {
    /* Erro de negócio não é falha do servidor: o front discrimina pelo prefixo da mensagem
       (ErroValidacao, ErroDuplicado…), então ele precisa chegar inteiro. */
    const mensagem = err && err.message ? err.message : String(err);
    console.log('  [erro] ' + funcao + ': ' + mensagem);
    json(res, 200, { ok: false, erro: mensagem });
  }
}

function lerCorpo(req, pronto) {
  let dados = '';
  req.on('data', (pedaco) => { dados += pedaco; });
  req.on('end', () => pronto(dados));
}

function responder(res, status, tipo, corpo) {
  res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(corpo);
}

function json(res, status, obj) {
  responder(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}

iniciar();
