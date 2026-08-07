'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto } = require('./harness');

/**
 * Provisionamento das abas e a guarda de cabeçalho.
 *
 * A guarda é a peça que decide entre "evolução de schema" e "corrupção silenciosa". Estes
 * testes fixam os dois lados: o que ela precisa deixar passar e o que precisa barrar.
 */

test('setupKanban cria a aba com o cabeçalho do schema, congelado', () => {
  const ctx = carregarProjeto();
  ctx.setupKanban();

  const sheet = ctx._ss.getSheetByName(ctx.TAB_NAME);
  assert.deepStrictEqual(
    sheet.getRange(1, 1, 1, ctx.COLUNAS.length).getValues()[0],
    ctx.COLUNAS.map((c) => c.campo)
  );
  assert.strictEqual(sheet._congeladas(), 1);
});

test('os três setups criam três abas e não apagam nada', () => {
  const ctx = carregarProjeto();
  ctx._ss.insertSheet('Página1');   // a aba que o Sheets cria sozinho

  ctx.setupKanban();
  ctx.setupPessoas();
  ctx.setupAnotacoes();
  ctx.setupNotas();
  ctx.setupLog();

  const nomes = ctx._ss.getSheets().map((s) => s.getName());
  assert.ok(nomes.includes('Página1'), 'nenhum setup pode apagar aba');
  [ctx.TAB_NAME, ctx.PESSOAS_TAB_NAME, ctx.ANOTACOES_TAB_NAME, ctx.LOG_TAB_NAME]
    .forEach((n) => assert.ok(nomes.includes(n), `faltou ${n}`));
});

test('rodar duas vezes converge no mesmo estado', () => {
  const ctx = carregarProjeto();
  ctx.setupKanban();
  const primeira = JSON.stringify(ctx._ss.getSheetByName(ctx.TAB_NAME)._celulas);

  ctx.setupKanban();
  assert.strictEqual(
    JSON.stringify(ctx._ss.getSheetByName(ctx.TAB_NAME)._celulas), primeira);
});

test('setup preserva os dados existentes', () => {
  const ctx = carregarProjeto();
  ctx.setupKanban();
  const card = ctx.createCard({ titulo: 'não me perca', prazo: '2026-08-08' });

  ctx.setupKanban();

  const depois = ctx.listCards().cards;
  assert.strictEqual(depois.length, 1);
  assert.strictEqual(depois[0].id, card.id);
  assert.strictEqual(depois[0].titulo, 'não me perca');
});

test('dropdown e checkbox nascem no corpo inteiro, não só nas linhas com dado', () => {
  // É o que faz a linha criada depois já nascer configurada, sem a camada reconfigurar a aba.
  const ctx = carregarProjeto();
  ctx.setupKanban();

  const sheet = ctx._ss.getSheetByName(ctx.TAB_NAME);
  const colStatus = ctx.colunaDe_(ctx.COLUNAS, 'status');
  const colCheck = ctx.colunaDe_(ctx.COLUNAS, 'aguardando_cliente');

  assert.strictEqual(sheet._validacoes[`2,${colStatus}`].tipo, 'lista');
  assert.strictEqual(sheet._validacoes[`900,${colStatus}`].tipo, 'lista', 'até o fim da grade');
  assert.strictEqual(sheet._validacoes[`2,${colCheck}`].tipo, 'checkbox');
  assert.strictEqual(sheet._validacoes[`2,${colStatus}`].permiteInvalido, false);
});

test('coluna de texto recebe formato @, contra o texto virar fórmula', () => {
  // Sete campos `contexto` do dump começam com "- ". Sem o formato, viram fórmula.
  const ctx = carregarProjeto();
  ctx.setupAnotacoes();

  const sheet = ctx._ss.getSheetByName(ctx.ANOTACOES_TAB_NAME);
  const colContexto = ctx.colunaDe_(ctx.COLUNAS_ANOTACOES, 'contexto');
  assert.strictEqual(sheet._formatos[`2,${colContexto}`], ctx.FORMATO_TEXTO);
});

test('a guarda aceita coluna nova à direita numa aba com dados', () => {
  // Foi assim que `origem_id` e as quatro colunas de data entraram sem migração manual.
  const ctx = carregarProjeto();
  const sheet = ctx._ss.insertSheet(ctx.TAB_NAME);

  // Simula a aba na versão anterior do schema: menos colunas, e com um card dentro.
  const antigo = ctx.COLUNAS.slice(0, ctx.COLUNAS.length - 4).map((c) => c.campo);
  sheet.getRange(1, 1, 1, antigo.length).setValues([antigo]);
  sheet.getRange(2, 1, 1, 3).setValues([['id-1', '', 'card antigo']]);

  assert.doesNotThrow(() => ctx.setupKanban());

  assert.deepStrictEqual(
    sheet.getRange(1, 1, 1, ctx.COLUNAS.length).getValues()[0],
    ctx.COLUNAS.map((c) => c.campo)
  );
  assert.strictEqual(sheet.getRange(2, 3).getValue(), 'card antigo', 'o dado não se moveu');
});

test('a coluna ativo entra numa aba com gente, e todo mundo nasce inativo', () => {
  /* Os dois lados desta afirmação importam. O primeiro é que a migração é de graça: a
     guarda aceita o acréscimo à direita e ninguém precisa digitar cabeçalho à mão. O
     segundo é a armadilha — `requireCheckbox` não escreve nada nas células, então a
     leitura devolve `false` e o time inteiro some das telas até as caixas serem marcadas.
     Está aqui como teste porque é a única coisa desta mudança que não dá para descobrir
     lendo o código. Ver `01`. */
  const ctx = carregarProjeto();
  const sheet = ctx._ss.insertSheet(ctx.PESSOAS_TAB_NAME);

  const antigo = ctx.COLUNAS_PESSOAS.slice(0, ctx.COLUNAS_PESSOAS.length - 1).map((c) => c.campo);
  sheet.getRange(1, 1, 1, antigo.length).setValues([antigo]);
  sheet.getRange(2, 1, 1, 3).setValues([['id-1', '', 'Gabriel']]);

  assert.doesNotThrow(() => ctx.setupPessoas());

  assert.deepStrictEqual(
    sheet.getRange(1, 1, 1, ctx.COLUNAS_PESSOAS.length).getValues()[0],
    ctx.COLUNAS_PESSOAS.map((c) => c.campo)
  );
  assert.strictEqual(sheet.getRange(2, 3).getValue(), 'Gabriel', 'o dado não se moveu');
  assert.strictEqual(ctx.listPessoas()[0].ativo, false, 'caixa em branco é inativo');
});

test('a guarda barra cabeçalho trocado numa aba com dados', () => {
  const ctx = carregarProjeto();
  const sheet = ctx._ss.insertSheet(ctx.TAB_NAME);

  const trocado = ctx.COLUNAS.map((c) => c.campo);
  [trocado[2], trocado[3]] = [trocado[3], trocado[2]];   // titulo <-> status
  sheet.getRange(1, 1, 1, trocado.length).setValues([trocado]);
  sheet.getRange(2, 1, 1, 3).setValues([['id-1', '', 'dado']]);

  assert.throws(() => ctx.setupKanban(), /não bate com o contrato/);
});

test('a guarda barra coluna sem rótulo mas COM dado embaixo', () => {
  // Escrever o rótulo por cima daria àquele dado um significado que ele não tem.
  const ctx = carregarProjeto();
  const sheet = ctx._ss.insertSheet(ctx.TAB_NAME);

  const antigo = ctx.COLUNAS.slice(0, ctx.COLUNAS.length - 1).map((c) => c.campo);
  sheet.getRange(1, 1, 1, antigo.length).setValues([antigo]);
  sheet.getRange(2, 1, 1, 3).setValues([['id-1', '', 'card']]);
  sheet.getRange(2, ctx.COLUNAS.length).setValues([['sobra misteriosa']]);

  assert.throws(() => ctx.setupKanban(), /não bate com o contrato/);
});

test('aba vazia com cabeçalho errado é corrigida sem drama', () => {
  const ctx = carregarProjeto();
  const sheet = ctx._ss.insertSheet(ctx.TAB_NAME);
  sheet.getRange(1, 1, 1, 3).setValues([['qualquer', 'coisa', 'aqui']]);

  assert.doesNotThrow(() => ctx.setupKanban());
  assert.strictEqual(sheet.getRange(1, 1).getValue(), 'id');
});

test('a camada avisa quando o setup não rodou', () => {
  const ctx = carregarProjeto();
  assert.throws(() => ctx.listCards(), /setupKanban/);
  assert.throws(() => ctx.listPessoas(), /setupPessoas/);
});
