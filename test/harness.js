'use strict';

/**
 * O que os testes precisam além do emulador.
 *
 * O carregamento do projeto mora em `mock/emulador.js`, porque o servidor local usa o
 * mesmo. Aqui ficam só os atalhos de teste: abas provisionadas, gente semeada, dumps do
 * Notion e a classe do erro lançado.
 */

const fs = require('fs');
const path = require('path');

const { carregarProjeto: carregar, RAIZ } = require('../mock/emulador');
const { criarPasta, criarArquivo } = require('../mock/apps-script');

const DUMPS = path.join(RAIZ, 'data', 'input');

/**
 * Os dumps do Notion existem só na máquina de quem migrou — eles carregam feedback nominal
 * sobre gente real e ficam fora do repositório público. Quem clona sem eles pula os testes
 * que dependem deles, em vez de ver falha vermelha por um arquivo que nunca teve.
 */
function temDumps() {
  return fs.existsSync(path.join(DUMPS, 'kanban.json'));
}

/** Como o `carregarProjeto` do emulador, com o atalho `dumps` que só os testes usam. */
function carregarProjeto(opcoes = {}) {
  return carregar(opcoes.dumps ? comPastaDeDumps(opcoes) : opcoes);
}

/**
 * A classe do erro que `fn` lança, ou null se ela não lançar.
 *
 * Devolve a classe, e não um booleano, para o teste afirmar *qual* erro veio — um
 * `ErroLock` passando por onde se esperava `ErroValidacao` seria um teste verde mentindo.
 */
function classeDoErroLancado(contexto, fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return contexto.classeDoErro_(err) || '(sem classe)';
  }
}

/** Projeto carregado com as abas já provisionadas. */
function comAbas(opcoes = {}) {
  const ctx = carregarProjeto(opcoes);
  ctx.setupKanban();
  ctx.setupPessoas();
  ctx.setupAnotacoes();
  ctx.setupNotas();
  ctx.setupLog();
  return ctx;
}

/**
 * Insere pessoas direto na aba, sem passar pelo import. Devolve os ids gerados.
 *
 * Cada item é um nome, ou `{ nome, ativo }` quando o teste precisa de alguém desativado.
 * O default é ativo: fora dos testes de inatividade, gente inativa só criaria ruído.
 */
function semearPessoas(ctx, nomes) {
  const sheet = ctx._ss.getSheetByName(ctx.PESSOAS_TAB_NAME);
  return nomes.map((item, i) => {
    const pessoa = typeof item === 'string' ? { nome: item } : item;
    const id = `pessoa-${i + 1}`;
    const linha = ctx.objetoParaLinha_({
      id, notion_id: `notion-${i + 1}`, nome: pessoa.nome, nivel: 'SE',
      data_ultimo_1a1: '', criado_em: new Date(2026, 0, 1), atualizado_em: new Date(2026, 0, 1),
      ativo: pessoa.ativo !== false,
    }, ctx.COLUNAS_PESSOAS);
    sheet.getRange(2 + i, 1, 1, ctx.COLUNAS_PESSOAS.length).setValues([linha]);
    return id;
  });
}

/** Um dump de `data/input/`, já parseado. */
function lerDumpLocal(nome) {
  return JSON.parse(fs.readFileSync(path.join(DUMPS, nome), 'utf8'));
}

/**
 * Serve os dumps por um Drive fake, para o que os lê de lá (reconciliação e os
 * `rodarImportXxx`) poder ser testado sem mock de leitura.
 *
 * `dumps: true` serve os arquivos de `data/input/` como estão. `dumps: {'kanban.json': obj}`
 * substitui o conteúdo de um deles — é como se testa contra o dump *refeito*, sem precisar
 * mexer no arquivo do repositório.
 */
function comPastaDeDumps(opcoes) {
  const substitutos = typeof opcoes.dumps === 'object' ? opcoes.dumps : {};
  const pasta = criarPasta('dumps');

  ['pessoas.json', 'kanban.json', 'anotacoes.json'].forEach((nome) => {
    const conteudo = nome in substitutos
      ? JSON.stringify(substitutos[nome])
      : fs.readFileSync(path.join(DUMPS, nome), 'utf8');
    criarArquivo(nome, conteudo, pasta);
  });

  return Object.assign({}, opcoes, {
    pastas: Object.assign({ dumps: pasta }, opcoes.pastas),
    propriedades: Object.assign({ DUMPS_FOLDER_ID: pasta.getId() }, opcoes.propriedades),
  });
}

module.exports = {
  carregarProjeto, comAbas, semearPessoas, lerDumpLocal, classeDoErroLancado, temDumps, RAIZ,
};
