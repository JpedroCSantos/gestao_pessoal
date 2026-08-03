'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { comAbas, lerDumpLocal, classeDoErroLancado, temDumps } = require('./harness');

/**
 * A carga histórica, contra os dumps reais.
 *
 * Migração roda uma vez e é difícil de desfazer — estes testes existem para que ela rode
 * certo na primeira. O que mais importa aqui: `criado_em` vem da origem, a FK resolve por
 * page ID e nunca por nome, e reimportar não duplica nem troca a PK.
 *
 * **Só rodam na máquina de quem migrou** — ver a nota em `dumps.test.js`.
 */

if (!temDumps()) {
  test('carga histórica', { skip: 'data/input/ não está neste clone' }, () => {});
  return;
}

const PESSOAS = lerDumpLocal('pessoas.json').pessoas;
const CARDS = lerDumpLocal('kanban.json').cards;
const ANOTACOES = lerDumpLocal('anotacoes.json').anotacoes;

function migrado() {
  const ctx = comAbas();
  ctx.importPessoas(PESSOAS);
  return ctx;
}

/* ------------------------------- cards ----------------------------------- */

test('os 38 cards válidos entram', () => {
  const ctx = migrado();
  const r = ctx.importCards(CARDS);

  assert.deepStrictEqual(
    { inseridos: r.inseridos, atualizados: r.atualizados, erros: r.erros },
    { inseridos: 38, atualizados: 0, erros: [] });
  assert.strictEqual(ctx.listCards().cards.length, 38);
});

test('o import barra card sem título, mas aceita card sem status', () => {
  // Os dois fantasmas do Notion mostraram que o import só reprova um deles: sem título é
  // inválido, sem status é legítimo (o board tem a coluna "Sem status"). Eles morreram na
  // origem, então o cenário virou sintético — mas a regra continua valendo para o que
  // vier pelo inbox depois, e é ela que o teste guarda.
  const ctx = migrado();
  const semTitulo = Object.assign({}, CARDS[0], { id: 'fantasma-1', titulo: null });
  const semStatus = Object.assign({}, CARDS[0], { id: 'fantasma-2', status: null });

  const r = ctx.importCards([semTitulo, semStatus]);

  assert.strictEqual(r.erros.length, 1, 'só o sem título é inválido para o import');
  assert.match(r.erros[0], /titulo/);
  assert.strictEqual(r.inseridos, 1);
  assert.strictEqual(ctx.listCards().cards.filter((c) => !c.status).length, 1);
});

test('criado_em vem do Notion, não do relógio da migração', () => {
  // É o que o resumo-semanal usa para julgar "o que carrego há semanas".
  const ctx = migrado();
  ctx.importCards(CARDS);

  const porNotion = {};
  ctx.listCards().cards.forEach((c) => { porNotion[c.notion_id] = c; });

  CARDS.forEach((origem) => {
    const criado = porNotion[origem.id].criado_em;
    assert.match(criado, /^2026-07/, `${origem.titulo}: criado_em deveria ser de julho`);
  });
});

test('atualizado_em vem do last_edited_time da origem', () => {
  // É o que separa "parado há três semanas" de "mexido ontem" no resumo-semanal. O dump
  // atual traz o campo em todos os 38, então aqui basta afirmar que ele foi respeitado.
  const ctx = migrado();
  ctx.importCards(CARDS);

  const porNotion = {};
  ctx.listCards().cards.forEach((c) => { porNotion[c.notion_id] = c; });

  // Compara o *intervalo* criação→edição, não a data crua: o dump vem em UTC e a aba
  // devolve no fuso da planilha, então a data pode legitimamente cair um dia antes. O
  // offset é o mesmo nas duas pontas e some na subtração.
  const instante = (s) => new Date(s.replace(' ', 'T')).getTime();
  const mexidos = CARDS.filter((o) => instante(o.last_edited_time) !== instante(o.created_time));
  assert.ok(mexidos.length, 'o dump precisa ter card editado depois de criado');

  mexidos.forEach((origem) => {
    const card = porNotion[origem.id];
    assert.strictEqual(
      instante(card.atualizado_em) - instante(card.criado_em),
      instante(origem.last_edited_time) - instante(origem.created_time),
      origem.titulo);
  });
});

test('sem last_edited_time, atualizado_em cai para criado_em', () => {
  // O campo é metadado de página, não propriedade configurada: um dump gerado sem ele não
  // é erro, e o import precisa degradar para a data de criação em vez de carimbar "agora".
  const ctx = migrado();
  const row = Object.assign({}, CARDS[0]);
  delete row.last_edited_time;
  ctx.importCards([row]);

  const card = ctx.listCards().cards[0];
  assert.strictEqual(card.atualizado_em, card.criado_em);
});

test('delegado_para vira ids locais, resolvidos por page ID', () => {
  const ctx = migrado();
  ctx.importCards(CARDS);

  const idLocalPorNotion = {};
  ctx.listPessoas().forEach((p) => { idLocalPorNotion[p.notion_id] = p.id; });

  const porNotion = {};
  ctx.listCards().cards.forEach((c) => { porNotion[c.notion_id] = c; });

  CARDS.filter((c) => c.delegado_para.length).forEach((origem) => {
    const esperado = origem.delegado_para.map((d) => idLocalPorNotion[d.id]).join(',');
    assert.strictEqual(porNotion[origem.id].delegado_para, esperado, origem.titulo);
  });
});

test('o card com três delegados sobrevive', () => {
  // "Verificar e-mail Canabis Mylena" — o caso que matou a ideia de FK escalar.
  const ctx = migrado();
  ctx.importCards(CARDS);

  const origem = CARDS.filter((c) => c.delegado_para.length === 3)[0];
  const card = ctx.listCards().cards.filter((c) => c.notion_id === origem.id)[0];
  assert.strictEqual(card.delegado_para.split(',').length, 3);
});

test('delegado fora de Pessoas é erro naquele card, não delegação perdida', () => {
  const ctx = migrado();
  const row = Object.assign({}, CARDS[0], {
    delegado_para: [{ id: 'page-fantasma', nome: 'Ninguém', nivel: 'SE' }],
  });

  const r = ctx.importCards([row]);
  assert.strictEqual(r.inseridos, 0);
  assert.strictEqual(r.erros.length, 1);
  assert.match(r.erros[0], /Ninguém/);
});

test('card sem status entra com status vazio, e o board o mostra em "Sem status"', () => {
  const ctx = migrado();
  const row = Object.assign({}, CARDS[0], { status: null });

  const r = ctx.importCards([row]);
  assert.strictEqual(r.inseridos, 1);
  assert.strictEqual(ctx.listCards().cards[0].status, '');
});

test('as três colunas de data chegam preenchidas, e a migração não carimba por cima', () => {
  // O import não passa por createCard, então CARIMBO_DE_STATUS não roda aqui — as datas são
  // as do Notion, inclusive as ausentes. Os 3 delegados sem `data_delegacao` continuam sem:
  // inventar "delegado hoje" para um card de julho faria o lembrete de 7 dias mentir.
  const ctx = migrado();
  ctx.importCards(CARDS);
  const cards = ctx.listCards().cards;

  assert.strictEqual(cards.filter((c) => c.data_inicio).length, 20);
  assert.strictEqual(cards.filter((c) => c.data_conclusao).length, 17);
  assert.strictEqual(cards.filter((c) => c.data_delegacao).length, 2);
});

test('origem_id fica vazio — a linha não veio do inbox', () => {
  const ctx = migrado();
  ctx.importCards(CARDS);
  ctx.listCards().cards.forEach((c) => assert.strictEqual(c.origem_id, ''));
});

test('importCards antes de Pessoas falha com mensagem útil', () => {
  const ctx = comAbas();
  assert.throws(() => ctx.importCards(CARDS), /rodarImportPessoas/);
});

/* ----------------------------- anotações --------------------------------- */

test('as 60 anotações entram com a FK resolvida', () => {
  const ctx = migrado();
  const r = ctx.importAnotacoes(ANOTACOES);

  assert.strictEqual(r.inseridos, 60);
  assert.deepStrictEqual(r.erros, []);

  const idsValidos = new Set(ctx.listPessoas().map((p) => p.id));
  ctx.lerAnotacoes_().forEach((a) => assert.ok(idsValidos.has(a.pessoa_id)));
});

test('os valores LEVTY viram os booleanos certos, nas 60', () => {
  const ctx = migrado();
  ctx.importAnotacoes(ANOTACOES);

  const porNotion = {};
  ctx.lerAnotacoes_().forEach((a) => { porNotion[a.notion_id] = a; });

  ANOTACOES.forEach((origem) => {
    const destino = porNotion[origem.id];
    const marcados = Object.keys(ctx.VALORES_LEVTY)
      .filter((r) => destino[ctx.VALORES_LEVTY[r]] === true);
    assert.strictEqual(marcados.length, origem.valores.length, origem.id);
    origem.valores.forEach((rotulo) => {
      assert.strictEqual(destino[ctx.VALORES_LEVTY[rotulo]], true, `${origem.id} / ${rotulo}`);
    });
  });
});

test('contexto começando com "-" sobrevive à carga', () => {
  const ctx = migrado();
  ctx.importAnotacoes(ANOTACOES);

  const comTraco = ANOTACOES.filter((a) => a.contexto && a.contexto.startsWith('- '));
  assert.ok(comTraco.length >= 7, 'o dump tem esses casos');

  const porNotion = {};
  ctx.lerAnotacoes_().forEach((a) => { porNotion[a.notion_id] = a; });
  comTraco.forEach((o) => assert.strictEqual(porNotion[o.id].contexto, o.contexto));
});

test('anotação com pessoa fora do mapa é erro, não entra órfã', () => {
  const ctx = migrado();
  const row = Object.assign({}, ANOTACOES[0], { pessoa_id: 'page-fantasma' });

  const r = ctx.importAnotacoes([row]);
  assert.strictEqual(r.inseridos, 0);
  assert.strictEqual(r.erros.length, 1);
});

/* --------------------------- idempotência -------------------------------- */

test('reimportar tudo não duplica e preserva id e criado_em', () => {
  const ctx = migrado();
  ctx.importCards(CARDS);
  ctx.importAnotacoes(ANOTACOES);

  const cardsAntes = ctx.listCards().cards;
  const notasAntes = ctx.lerAnotacoes_();

  const rc = ctx.importCards(CARDS);
  const ra = ctx.importAnotacoes(ANOTACOES);

  assert.strictEqual(rc.inseridos, 0);
  assert.strictEqual(rc.atualizados, 38);
  assert.strictEqual(ra.inseridos, 0);
  assert.strictEqual(ra.atualizados, 60);

  const porNotion = {};
  ctx.listCards().cards.forEach((c) => { porNotion[c.notion_id] = c; });
  cardsAntes.forEach((antes) => {
    assert.strictEqual(porNotion[antes.notion_id].id, antes.id, 'a PK não pode mudar');
    assert.strictEqual(porNotion[antes.notion_id].criado_em, antes.criado_em);
  });
  assert.strictEqual(ctx.lerAnotacoes_().length, notasAntes.length);
});

/* --------------------------- reconciliação ------------------------------- */

test('reconciliarMigracao passa depois da carga completa', () => {
  // Usa os mesmos dumps que a carga usou, então precisa fechar em contagem, FK e campos.
  const ctx = comAbas({ dumps: true });
  ctx.importPessoas(PESSOAS);
  ctx.importCards(CARDS);
  ctx.importAnotacoes(ANOTACOES);

  assert.strictEqual(ctx.reconciliarMigracao(), true, ctx._logs.join('\n'));
});

test('reconciliarMigracao acusa registro que está na aba e não no dump', () => {
  // A outra direção da contagem, e a mais silenciosa: sobrou linha na aba. Acontece se um
  // card for excluído no Notion depois de migrado, ou se um dump antigo for reimportado
  // junto com um novo. Só o dump é a referência; a aba não pode ter inventado registro.
  const ctx = comAbas({ dumps: true });
  ctx.importPessoas(PESSOAS);
  ctx.importCards(CARDS.concat([Object.assign({}, CARDS[0], { id: 'nao-esta-no-dump' })]));
  ctx.importAnotacoes(ANOTACOES);

  assert.strictEqual(ctx.reconciliarMigracao(), false);
  assert.ok(ctx._logs.some((l) => /na aba e NÃO no dump/.test(l)), ctx._logs.join('\n'));
});

test('reconciliarMigracao acusa registro que ficou de fora', () => {
  const ctx = comAbas({ dumps: true });
  ctx.importPessoas(PESSOAS);
  ctx.importCards(CARDS.slice(0, 30));   // faltam 8
  ctx.importAnotacoes(ANOTACOES);

  assert.strictEqual(ctx.reconciliarMigracao(), false);
  assert.ok(ctx._logs.some((l) => /NÃO na aba/.test(l)), 'precisa dizer quais faltaram');
});

test('reconciliarMigracao acusa campo que se perdeu na transformação', () => {
  const ctx = comAbas({ dumps: true });
  ctx.importPessoas(PESSOAS);
  ctx.importCards(CARDS);
  ctx.importAnotacoes(ANOTACOES);

  // Simula um bug de transformação: alguém apagou a descrição de um card.
  const card = ctx.listCards().cards.filter((c) => c.descricao)[0];
  ctx.updateCard(card.id, { descricao: '' });

  assert.strictEqual(ctx.reconciliarMigracao(), false);
  assert.ok(ctx._logs.some((l) => /descricao/.test(l)));
});
