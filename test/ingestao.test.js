'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, semearPessoas, classeDoErroLancado } = require('./harness');
const { criarPasta, criarArquivo } = require('../mock/apps-script');

/**
 * A borda de entrada: envelope, tradução e o ciclo do processarInbox.
 *
 * O que importa aqui é o roteamento — arquivo bom vai para `processados/`, arquivo ruim vai
 * para `erros/`, e um ruim no meio da leva não derruba os outros.
 */

/** @param {boolean} opcoes.comPainel registra também a PAINEL_FOLDER_ID. */
function montarIngestao(opcoes = {}) {
  const inbox = criarPasta('inbox');
  const processados = criarPasta('processados');
  const erros = criarPasta('erros');
  const painel = criarPasta('painel');
  const resumos = criarPasta('resumos');

  const propriedades = {
    INBOX_FOLDER_ID: inbox.getId(),
    PROCESSADOS_FOLDER_ID: processados.getId(),
    ERROS_FOLDER_ID: erros.getId(),
  };
  if (opcoes.comPainel) {
    propriedades.PAINEL_FOLDER_ID = painel.getId();
    propriedades.RESUMOS_FOLDER_ID = resumos.getId();
  }

  const ctx = carregarProjeto(Object.assign({}, opcoes, {
    pastas: { inbox, processados, erros, painel, resumos },
    propriedades: Object.assign(propriedades, opcoes.propriedades),
  }));

  ctx.setupKanban();
  ctx.setupPessoas();
  ctx.setupAnotacoes();
  ctx.setupLog();

  return { ctx, inbox, processados, erros, painel, resumos };
}

const largar = (pasta, nome, obj) =>
  criarArquivo(nome, typeof obj === 'string' ? obj : JSON.stringify(obj), pasta);

/* ------------------------------- tradução -------------------------------- */

test('envelope de anotação: tipo_nota vira tipo, valores viram booleanos', () => {
  const { ctx } = montarIngestao();
  const t = ctx.traduzirEnvelopeDeAnotacao_({
    pessoa_id: 'p1', nota: 'n', tipo_nota: 'positivo',
    valores: ['Transparência', 'Autogestão'],
  });

  assert.strictEqual(t.tipo, 'positivo');
  assert.ok(!('tipo_nota' in t));
  assert.strictEqual(t.valor_transparencia, true);
  assert.strictEqual(t.valor_autogestao, true);
  assert.strictEqual(t.valor_qualidade, false, 'o que não veio é false, não indefinido');
});

test('rótulo de valor tolera falta de acento e caixa', () => {
  // Ditado por voz não garante o acento de "Autogestão".
  const { ctx } = montarIngestao();
  const t = ctx.traduzirEnvelopeDeAnotacao_({ valores: ['autogestao', 'TRANSPARENCIA'] });
  assert.strictEqual(t.valor_autogestao, true);
  assert.strictEqual(t.valor_transparencia, true);
});

test('rótulo de valor inventado é recusado', () => {
  const { ctx } = montarIngestao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () =>
      ctx.traduzirEnvelopeDeAnotacao_({ valores: ['Pontualidade'] })), 'ErroValidacao');
});

test('campo desconhecido no envelope de anotação é recusado', () => {
  const { ctx } = montarIngestao();
  ['pessoa', 'tipo', 'valor_qualidade'].forEach((chave) => {
    const payload = {};
    payload[chave] = 'x';
    assert.strictEqual(
      classeDoErroLancado(ctx, () => ctx.traduzirEnvelopeDeAnotacao_(payload)),
      'ErroValidacao', chave);
  });
});

/* ---------------------------- ciclo do inbox ----------------------------- */

test('card válido entra, e o arquivo vai para processados/', () => {
  const { ctx, inbox, processados } = montarIngestao();
  largar(inbox, 'card.json', { tipo: 'card', payload: { titulo: 'do inbox' } });

  const r = ctx.processarInbox();

  assert.deepStrictEqual(
    { processados: r.processados, ignorados: r.ignorados, erros: r.erros },
    { processados: 1, ignorados: 0, erros: 0 });
  assert.strictEqual(ctx.listCards().cards[0].titulo, 'do inbox');
  assert.strictEqual(inbox._arquivos.length, 0);
  assert.strictEqual(processados._arquivos.length, 1);
});

test('origem_id gravado é o file ID', () => {
  const { ctx, inbox } = montarIngestao();
  const file = largar(inbox, 'card.json', { tipo: 'card', payload: { titulo: 'x' } });

  ctx.processarInbox();
  assert.strictEqual(ctx.listCards().cards[0].origem_id, file.getId());
});

test('anotação entra pelo inbox com os valores marcados', () => {
  const { ctx, inbox } = montarIngestao();
  const [pessoa] = semearPessoas(ctx, ['Lucas']);
  largar(inbox, 'nota.json', {
    tipo: 'anotacao',
    payload: { pessoa_id: pessoa, nota: 'mandou bem', tipo_nota: 'positivo',
               valores: ['Qualidade'] },
  });

  const r = ctx.processarInbox();
  assert.strictEqual(r.processados, 1);

  const sheet = ctx._ss.getSheetByName(ctx.ANOTACOES_TAB_NAME);
  const linha = sheet.getRange(2, 1, 1, ctx.COLUNAS_ANOTACOES.length).getValues()[0];
  const obj = ctx.linhaParaObjeto_(linha, ctx.COLUNAS_ANOTACOES, 'tz');
  assert.strictEqual(obj.nota, 'mandou bem');
  assert.strictEqual(obj.valor_qualidade, true);
  assert.strictEqual(obj.pessoa_id, pessoa);
});

test('reprocessar o mesmo arquivo não duplica — conta como ignorado', () => {
  // Cobre a execução que morre entre gravar a linha e mover o arquivo.
  const { ctx, inbox, processados } = montarIngestao();
  const file = largar(inbox, 'card.json', { tipo: 'card', payload: { titulo: 'único' } });

  ctx.processarInbox();
  file.moveTo(inbox);                       // como se o move tivesse falhado
  const r = ctx.processarInbox();

  assert.strictEqual(r.processados, 0);
  assert.strictEqual(r.ignorados, 1);
  assert.strictEqual(ctx.listCards().cards.length, 1, 'nada de card duplicado');
  assert.strictEqual(processados._arquivos.length, 1, 'duplicata também vai para processados');
});

test('um arquivo ruim não derruba a leva', () => {
  const { ctx, inbox, processados, erros } = montarIngestao();
  largar(inbox, 'bom-1.json', { tipo: 'card', payload: { titulo: 'bom 1' } });
  largar(inbox, 'quebrado.json', '{ isso não é json');
  largar(inbox, 'bom-2.json', { tipo: 'card', payload: { titulo: 'bom 2' } });

  const r = ctx.processarInbox();

  assert.strictEqual(r.processados, 2);
  assert.strictEqual(r.erros, 1);
  assert.strictEqual(processados._arquivos.length, 2);
  assert.strictEqual(erros._arquivos.length, 1);
  assert.strictEqual(erros._arquivos[0].getName(), 'quebrado.json');
});

test('payload inválido vai para erros/, com a mensagem no Log', () => {
  const { ctx, inbox, erros } = montarIngestao();
  largar(inbox, 'sem-titulo.json', { tipo: 'card', payload: { prioridade: 'Alta' } });

  ctx.processarInbox();

  assert.strictEqual(erros._arquivos.length, 1);
  const log = ctx._ss.getSheetByName(ctx.LOG_TAB_NAME);
  const linha = log.getRange(2, 1, 1, ctx.COLUNAS_LOG.length).getValues()[0];
  const obj = ctx.linhaParaObjeto_(linha, ctx.COLUNAS_LOG, 'tz');
  assert.strictEqual(obj.resultado, 'erro');
  assert.match(obj.mensagem, /titulo/);
});

test('anotação com pessoa_id inexistente vai para erros/', () => {
  const { ctx, inbox, erros } = montarIngestao();
  largar(inbox, 'orfa.json', {
    tipo: 'anotacao',
    payload: { pessoa_id: 'nao-existe', nota: 'n', tipo_nota: 'positivo' },
  });

  ctx.processarInbox();
  assert.strictEqual(erros._arquivos.length, 1);
});

test('tipo desconhecido no envelope vai para erros/', () => {
  const { ctx, inbox, erros } = montarIngestao();
  largar(inbox, 'x.json', { tipo: 'lembrete', payload: { titulo: 'x' } });

  ctx.processarInbox();
  assert.strictEqual(erros._arquivos.length, 1);
});

test('origem_id vindo no payload é recusado', () => {
  // Quem preenche é a ingestão, com o file ID. Aceitar de fora abriria duas procedências.
  const { ctx, inbox, erros } = montarIngestao();
  largar(inbox, 'x.json', { tipo: 'card', payload: { titulo: 'x', origem_id: 'meu' } });

  ctx.processarInbox();
  assert.strictEqual(erros._arquivos.length, 1);
});

test('inbox vazio sai sem escrever nada', () => {
  const { ctx } = montarIngestao();
  const r = ctx.processarInbox();
  assert.deepStrictEqual(r, { processados: 0, ignorados: 0, erros: 0 });
});

test('o Log registra uma linha por arquivo', () => {
  const { ctx, inbox } = montarIngestao();
  largar(inbox, 'a.json', { tipo: 'card', payload: { titulo: 'a' } });
  largar(inbox, 'b.json', { tipo: 'card', payload: { titulo: 'b' } });
  largar(inbox, 'c.json', '{quebrado');

  ctx.processarInbox();

  const log = ctx._ss.getSheetByName(ctx.LOG_TAB_NAME);
  const col = ctx.colunaDe_(ctx.COLUNAS_LOG, 'arquivo');
  const nomes = log.getRange(2, col, 3, 1).getValues().map((l) => l[0]);
  assert.deepStrictEqual(nomes.sort(), ['a.json', 'b.json', 'c.json']);
});

test('teto por rodada é respeitado e o resto é sinalizado', () => {
  // Sem o aviso, "50 criados" passaria a impressão de que o inbox esvaziou.
  const { ctx, inbox } = montarIngestao();
  for (let i = 0; i < ctx.MAX_ARQUIVOS_POR_RODADA + 3; i++) {
    largar(inbox, `c${i}.json`, { tipo: 'card', payload: { titulo: 'c' + i } });
  }

  const r = ctx.processarInbox();

  assert.strictEqual(r.processados, ctx.MAX_ARQUIVOS_POR_RODADA);
  assert.strictEqual(r.restantes, true);
  assert.strictEqual(inbox._arquivos.length, 3);
});

test('lock ocupado desiste sem processar', () => {
  const { ctx, inbox } = montarIngestao({ lockOcupado: true });
  largar(inbox, 'card.json', { tipo: 'card', payload: { titulo: 'x' } });

  const r = ctx.processarInbox();

  assert.strictEqual(r.ocupado, true);
  assert.strictEqual(inbox._arquivos.length, 1, 'o arquivo fica para a próxima rodada');
});

/* ------------------------------ envelope 1a1 ------------------------------ */

test('envelope 1a1 carimba a data na pessoa e vai para processados/', () => {
  const { ctx, inbox, processados } = montarIngestao();
  const [lucas] = semearPessoas(ctx, ['Lucas']);
  largar(inbox, '1a1.json', {
    tipo: '1a1',
    payload: { pessoa_id: lucas, data: '2026-09-01' },
  });

  const r = ctx.processarInbox();

  assert.strictEqual(r.processados, 1);
  assert.strictEqual(ctx.listPessoas()[0].data_ultimo_1a1, '2026-09-01');
  assert.strictEqual(processados._arquivos.length, 1);
});

test('o 1a1 não vira linha nova em lugar nenhum', () => {
  // É o único envelope que só atualiza. Se um dia ele passar a inserir, é aqui que aparece.
  const { ctx, inbox } = montarIngestao();
  const [lucas] = semearPessoas(ctx, ['Lucas']);
  largar(inbox, '1a1.json', { tipo: '1a1', payload: { pessoa_id: lucas } });

  ctx.processarInbox();

  assert.strictEqual(ctx.listPessoas().length, 1);
  assert.strictEqual(ctx.listCards().cards.length, 0);
  assert.strictEqual(ctx.lerAnotacoes_().length, 0);
});

test('reprocessar o mesmo 1a1 é ok, e não vira duplicata', () => {
  // Pessoas não tem origem_id, então a dedupe não roda. O desfecho continua sendo 'ok' —
  // regravar a mesma data é inofensivo, e mentir "ignorado" esconderia uma escrita que houve.
  const { ctx, inbox, processados } = montarIngestao();
  const [lucas] = semearPessoas(ctx, ['Lucas']);
  const arquivo = largar(inbox, '1a1.json', {
    tipo: '1a1', payload: { pessoa_id: lucas, data: '2026-09-01' },
  });

  ctx.processarInbox();
  arquivo.moveTo(inbox);
  const segunda = ctx.processarInbox();

  assert.strictEqual(segunda.processados, 1);
  assert.strictEqual(segunda.ignorados, 0);
  assert.strictEqual(ctx.listPessoas()[0].data_ultimo_1a1, '2026-09-01');
});

test('1a1 apontando para pessoa inexistente vai para erros/', () => {
  const { ctx, inbox, erros } = montarIngestao();
  semearPessoas(ctx, ['Lucas']);
  largar(inbox, '1a1.json', { tipo: '1a1', payload: { pessoa_id: 'fantasma' } });

  const r = ctx.processarInbox();

  assert.strictEqual(r.erros, 1);
  assert.strictEqual(erros._arquivos.length, 1);
});

test('campo desconhecido no envelope de 1a1 é recusado', () => {
  const ctx = carregarProjeto();
  assert.strictEqual(
    classeDoErroLancado(ctx, () =>
      ctx.traduzirEnvelopeDe1a1_({ pessoa_id: 'p1', nivel: 'TTL' })),
    'ErroValidacao');
});

test('a tradução do 1a1 descarta o origem_id que a ingestão carimbou', () => {
  // Pessoas não tem essa coluna: deixar passar faria o registrar1a1 recusar todo arquivo
  // vindo do inbox — que é o único jeito de ele ser chamado.
  const ctx = carregarProjeto();
  const traduzido = ctx.traduzirEnvelopeDe1a1_({ pessoa_id: 'p1', origem_id: 'file-1' });
  assert.deepStrictEqual(traduzido, { pessoa_id: 'p1' });
});

/* --------------------------- verificarConfiguracao ------------------------ */

test('verificarConfiguracao aprova quando tudo está no lugar', () => {
  const { ctx } = montarIngestao({ comPainel: true });
  ctx.instalarTriggers();
  semearPessoas(ctx, ['Gabriel']);
  assert.strictEqual(ctx.verificarConfiguracao(), true, ctx._logs.join('\n'));
});

test('a pasta de painéis é conferida só na leitura', () => {
  // Quem escreve ali é a skill, pelo conector. Exigir escrita do Apps Script reprovaria
  // uma configuração correta.
  const { ctx, painel } = montarIngestao({ comPainel: true });
  ctx.instalarTriggers();
  semearPessoas(ctx, ['Gabriel']);
  painel.createFile = () => { throw new Error('sem permissão de escrita'); };

  assert.strictEqual(ctx.verificarConfiguracao(), true, ctx._logs.join('\n'));
});

test('verificarConfiguracao reprova aba de gente sem ninguém ativo', () => {
  /* É o estado logo depois de criar a coluna `ativo`: nada dá erro, e o app inteiro fica
     sem gente. Sem esta checagem, a descoberta seria abrir a tela e achar que quebrou. */
  const { ctx } = montarIngestao({ comPainel: true });
  ctx.instalarTriggers();
  semearPessoas(ctx, [{ nome: 'Gabriel', ativo: false }]);

  assert.strictEqual(ctx.verificarConfiguracao(), false);
  assert.ok(ctx._logs.some((l) => /marcada como ativa/.test(l)), ctx._logs.join('\n'));
});

test('verificarConfiguracao acusa a pasta de painéis faltando', () => {
  // Ela entrou depois das três da ingestão, e sem ela o ?view= do board serve um aviso.
  const { ctx } = montarIngestao();
  assert.strictEqual(ctx.verificarConfiguracao(), false);
  assert.ok(ctx._logs.some((l) => /PAINEL_FOLDER_ID: FALTANDO/.test(l)), ctx._logs.join('\n'));
});

test('verificarConfiguracao confere as quatro abas, não só duas', () => {
  const { ctx } = montarIngestao();
  ctx._ss.getSheetByName(ctx.ANOTACOES_TAB_NAME).getName = () => 'outro-nome';

  ctx.verificarConfiguracao();
  assert.ok(
    ctx._logs.some((l) => /Anotações.*FALTANDO|FALTANDO.*setupAnotacoes/.test(l)),
    ctx._logs.join('\n'));
});

test('instalarTriggers é idempotente — roda duas vezes e sobra um', () => {
  // Ele remove os do próprio handler antes de criar. Sem isso, cada execução somaria um
  // trigger e o inbox passaria a ser processado em paralelo consigo mesmo.
  const { ctx } = montarIngestao();
  ctx.instalarTriggers();
  ctx.instalarTriggers();

  const meus = ctx.ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'processarInbox');
  assert.strictEqual(meus.length, 1);
});

test('instalarTriggers não apaga trigger de outro handler', () => {
  const { ctx } = montarIngestao();
  ctx.ScriptApp.newTrigger('outraCoisa').timeBased().everyMinutes(30).create();
  ctx.instalarTriggers();

  assert.strictEqual(ctx.ScriptApp.getProjectTriggers().length, 2);
});
