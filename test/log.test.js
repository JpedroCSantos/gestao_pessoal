'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto } = require('./harness');
const { criarPasta, criarArquivo } = require('../mock/apps-script');

/**
 * Leitura do log da ingestão.
 *
 * O que se testa aqui é o que a tela depende: a âncora (a aba `Log` **não tem `id`**, e o
 * padrão do `lerAba_` descartaria tudo em silêncio), a janela, o teto, e as contagens serem
 * da janela e não da aba inteira — o contador do menu significa "falhou nos últimos 7 dias",
 * e somar o histórico faria um erro de junho pedir atenção para sempre.
 */

function montar() {
  const inbox = criarPasta('inbox');
  const processados = criarPasta('processados');
  const erros = criarPasta('erros');

  const ctx = carregarProjeto({
    pastas: { inbox, processados, erros },
    propriedades: {
      INBOX_FOLDER_ID: inbox.getId(),
      PROCESSADOS_FOLDER_ID: processados.getId(),
      ERROS_FOLDER_ID: erros.getId(),
    },
  });

  ctx.setupKanban();
  ctx.setupPessoas();
  ctx.setupAnotacoes();
  ctx.setupNotas();
  ctx.setupLog();

  return { ctx, inbox, processados, erros };
}

/** Escreve linhas direto na aba Log, como o `gravarLog_` faria. */
function semearLog(ctx, linhas) {
  const sheet = ctx.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Log');
  const valores = linhas.map((l) =>
    ctx.COLUNAS_LOG.map((c) => (c.campo in l ? l[c.campo] : '')));
  sheet.getRange(2, 1, valores.length, ctx.COLUNAS_LOG.length).setValues(valores);
}

const diasAtras = (n) => new Date(Date.now() - n * 86400000);

/* ------------------------------- a âncora -------------------------------- */

test('lê a aba Log, que não tem coluna id', () => {
  // O `lerAba_` descarta linha sem o campo-âncora, e o padrão dele é `id`. Sem a âncora em
  // `quando` esta chamada devolveria zero linhas sem erro nenhum.
  const { ctx } = montar();
  semearLog(ctx, [
    { quando: diasAtras(1), arquivo: 'a.json', resultado: 'ok', tipo: 'card' },
  ]);

  const r = ctx.listLog();
  assert.strictEqual(r.linhas.length, 1);
  assert.strictEqual(r.linhas[0].arquivo, 'a.json');
});

test('aba vazia devolve estrutura completa, e não erro', () => {
  const { ctx } = montar();
  const r = ctx.listLog();

  assert.deepStrictEqual(
    { linhas: r.linhas, total: r.total, naJanela: r.naJanela, erros: r.erros },
    { linhas: [], total: 0, naJanela: 0, erros: 0 });
});

/* ------------------------------ o transporte ----------------------------- */

test('`quando` atravessa como string, nunca como Date', () => {
  const { ctx } = montar();
  semearLog(ctx, [{ quando: diasAtras(0), arquivo: 'a.json', resultado: 'ok' }]);

  const l = ctx.listLog().linhas[0];
  assert.strictEqual(typeof l.quando, 'string');
  assert.ok(!(l.quando instanceof Date));
  assert.match(l.quando, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

/* -------------------------------- a janela ------------------------------- */

test('fora da janela não entra, mas continua no total', () => {
  const { ctx } = montar();
  semearLog(ctx, [
    { quando: diasAtras(1),  arquivo: 'dentro.json', resultado: 'ok' },
    { quando: diasAtras(40), arquivo: 'fora.json',   resultado: 'erro' },
  ]);

  const r = ctx.listLog();
  assert.strictEqual(r.linhas.length, 1);
  assert.strictEqual(r.linhas[0].arquivo, 'dentro.json');
  assert.strictEqual(r.total, 2, 'o total é da aba inteira — é o que revela o histórico');
  assert.strictEqual(r.naJanela, 1);
});

test('erro antigo não conta no contador', () => {
  // O número ao lado do menu é "falhou nos últimos 7 dias". Se o histórico entrasse, um
  // erro de junho pediria atenção para sempre.
  const { ctx } = montar();
  semearLog(ctx, [{ quando: diasAtras(40), arquivo: 'velho.json', resultado: 'erro' }]);

  assert.strictEqual(ctx.listLog().erros, 0);
});

test('a janela é parametrizável', () => {
  const { ctx } = montar();
  semearLog(ctx, [{ quando: diasAtras(20), arquivo: 'a.json', resultado: 'erro' }]);

  assert.strictEqual(ctx.listLog().naJanela, 0);
  assert.strictEqual(ctx.listLog(30).naJanela, 1);
  assert.strictEqual(ctx.listLog(30).erros, 1);
});

test('janela inválida cai no padrão em vez de zerar tudo', () => {
  const { ctx } = montar();
  semearLog(ctx, [{ quando: diasAtras(1), arquivo: 'a.json', resultado: 'ok' }]);

  [0, -5, 'abc', null, undefined].forEach((entrada) => {
    assert.strictEqual(ctx.listLog(entrada).dias, ctx.LOG_DIAS_JANELA,
      'janela ' + JSON.stringify(entrada) + ' deveria cair no padrão');
    assert.strictEqual(ctx.listLog(entrada).naJanela, 1);
  });
});

/* -------------------------------- a ordem -------------------------------- */

test('mais recente primeiro', () => {
  const { ctx } = montar();
  semearLog(ctx, [
    { quando: diasAtras(3), arquivo: 'velho.json',  resultado: 'ok' },
    { quando: diasAtras(0), arquivo: 'novo.json',   resultado: 'ok' },
    { quando: diasAtras(1), arquivo: 'meio.json',   resultado: 'ok' },
  ]);

  assert.deepStrictEqual(
    ctx.listLog().linhas.map((l) => l.arquivo),
    ['novo.json', 'meio.json', 'velho.json']);
});

/* --------------------------------- o teto -------------------------------- */

test('o teto corta, e o que foi cortado é declarado', () => {
  const { ctx } = montar();
  const total = ctx.LOG_MAX_LINHAS + 15;

  semearLog(ctx, Array.from({ length: total }, (_, i) => ({
    quando: diasAtras(0), arquivo: 'a' + i + '.json', resultado: 'ok',
  })));

  const r = ctx.listLog();
  assert.strictEqual(r.linhas.length, ctx.LOG_MAX_LINHAS);
  assert.strictEqual(r.naJanela, total);
  assert.strictEqual(r.cortadas, 15, 'silêncio aqui leria como "isto é tudo"');
});

test('sem corte, `cortadas` é zero e não um número negativo', () => {
  const { ctx } = montar();
  semearLog(ctx, [{ quando: diasAtras(1), arquivo: 'a.json', resultado: 'ok' }]);
  assert.strictEqual(ctx.listLog().cortadas, 0);
});

/* ------------------------------ as contagens ----------------------------- */

test('conta por resultado, dentro da janela', () => {
  const { ctx } = montar();
  semearLog(ctx, [
    { quando: diasAtras(1), arquivo: 'a.json', resultado: 'ok' },
    { quando: diasAtras(1), arquivo: 'b.json', resultado: 'ok' },
    { quando: diasAtras(2), arquivo: 'c.json', resultado: 'erro' },
    { quando: diasAtras(2), arquivo: 'd.json', resultado: 'ignorado' },
  ]);

  const r = ctx.listLog();
  assert.deepStrictEqual(
    { ok: r.ok, erros: r.erros, ignorados: r.ignorados },
    { ok: 2, erros: 1, ignorados: 1 });
});

/* ------------------------- o ciclo real da ingestão ---------------------- */

test('a falha que o processarInbox grava chega inteira na tela', () => {
  // O caso que motivou a aba: a skill mandou um `tipo_nota` que não existe, confirmou para
  // o usuário, e o fracasso ficou só na aba Log. A mensagem tem que sobreviver íntegra —
  // é ela que diz qual campo corrigir.
  const { ctx, inbox } = montar();
  criarArquivo('nota-ruim.json', JSON.stringify({
    tipo: 'anotacao',
    payload: { pessoa_id: 'p1', nota: 'n', tipo_nota: 'ponto_forte' },
  }), inbox);

  ctx.processarInbox();

  const r = ctx.listLog();
  assert.strictEqual(r.erros, 1);

  const falha = r.linhas.filter((l) => l.resultado === 'erro')[0];
  assert.strictEqual(falha.arquivo, 'nota-ruim.json');
  assert.match(falha.mensagem, /ponto_forte/);
  assert.match(falha.mensagem, /melhoria/, 'a mensagem diz os valores aceitos');
});

/* ------------------------- o marcador de "já vi" ------------------------- */

test('naoVistos começa igual a erros, sem marcador nenhum', () => {
  const { ctx } = montar();
  semearLog(ctx, [
    { quando: diasAtras(1), arquivo: 'a.json', resultado: 'erro' },
    { quando: diasAtras(2), arquivo: 'b.json', resultado: 'erro' },
  ]);

  const r = ctx.listLog();
  assert.strictEqual(r.erros, 2);
  assert.strictEqual(r.naoVistos, 2);
  assert.strictEqual(r.vistoAte, '');
});

test('marcar como visto zera o contador e NÃO esconde a falha', () => {
  /*
   * A regra que não pode quebrar. O caso real: os arquivos foram corrigidos e
   * reprocessados, a pasta `erros/` está vazia, e as linhas antigas do Log continuam
   * marcando 4. O contador tem que zerar; a lista, não — se limpar escondesse dado, seria
   * a mesma perda silenciosa que esta tela existe para consertar.
   */
  const { ctx } = montar();
  semearLog(ctx, [{ quando: diasAtras(1), arquivo: 'a.json', resultado: 'erro' }]);

  ctx.marcarLogVisto();
  const r = ctx.listLog();

  assert.strictEqual(r.naoVistos, 0, 'o contador zera');
  assert.strictEqual(r.erros, 1, 'o total da janela não muda');
  assert.strictEqual(r.linhas.length, 1, 'a linha continua na lista');
});

test('erro novo depois de marcar levanta o contador de novo', () => {
  // É por isso que o marcador é um instante e não um booleano: flag exigiria alguém
  // lembrar de limpá-la, e ela seria esquecida no dia em que importasse.
  const { ctx } = montar();
  semearLog(ctx, [{ quando: diasAtras(2), arquivo: 'velho.json', resultado: 'erro' }]);
  ctx.marcarLogVisto();
  assert.strictEqual(ctx.listLog().naoVistos, 0);

  // Uma falha com timestamp posterior ao marcador.
  semearLog(ctx, [
    { quando: diasAtras(2), arquivo: 'velho.json', resultado: 'erro' },
    { quando: new Date(Date.now() + 60000), arquivo: 'novo.json', resultado: 'erro' },
  ]);

  const r = ctx.listLog();
  assert.strictEqual(r.naoVistos, 1, 'só o novo conta');
  assert.strictEqual(r.erros, 2);
});

test('marcar como visto não mexe em ok nem em ignorado', () => {
  const { ctx } = montar();
  semearLog(ctx, [
    { quando: diasAtras(1), arquivo: 'a.json', resultado: 'ok' },
    { quando: diasAtras(1), arquivo: 'b.json', resultado: 'ignorado' },
  ]);

  ctx.marcarLogVisto();
  const r = ctx.listLog();
  assert.deepStrictEqual({ ok: r.ok, ignorados: r.ignorados, naoVistos: r.naoVistos },
    { ok: 1, ignorados: 1, naoVistos: 0 });
});

test('marcarLogVisto devolve o estado já marcado', () => {
  const { ctx } = montar();
  semearLog(ctx, [{ quando: diasAtras(1), arquivo: 'a.json', resultado: 'erro' }]);

  const r = ctx.marcarLogVisto();
  assert.strictEqual(r.naoVistos, 0);
  assert.match(r.vistoAte, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.strictEqual(ctx.listLog().vistoAte, r.vistoAte, 'persistiu');
});
