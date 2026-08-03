'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto } = require('./harness');

const ctx = carregarProjeto();
const TZ = 'America/Sao_Paulo';

/**
 * O mapeador linha↔objeto e a serialização do `01`. É o par de funções por onde passa toda
 * leitura e toda escrita do projeto — um erro aqui corrompe em silêncio.
 */

test('round-trip preserva os campos de todos os tipos', () => {
  const card = ctx.validarPayload_({
    titulo: 'Migrar cluster', status: 'In progress', prioridade: 'Alta',
    prazo: '2026-08-08', descricao: 'texto', aguardando_cliente: true,
    prazo_cliente: '2026-08-21', pendencia_cliente: 'aguardando retorno',
    delegado_para: 'p1,p2', origem_id: 'file-1',
    data_inicio: '2026-07-20', data_conclusao: '2026-07-30',
    data_delegacao: '2026-07-29',
  });
  const volta = ctx.linhaParaObjeto_(ctx.objetoParaLinha_(card, ctx.COLUNAS), ctx.COLUNAS, TZ);

  assert.strictEqual(volta.titulo, 'Migrar cluster');
  assert.strictEqual(volta.prazo, '2026-08-08');
  assert.strictEqual(volta.data_conclusao, '2026-07-30');
  assert.strictEqual(volta.aguardando_cliente, true);
  assert.strictEqual(volta.delegado_para, 'p1,p2');
});

test('data vazia atravessa como string vazia, nunca como null', () => {
  const card = ctx.validarPayload_({ titulo: 'sem prazo' });
  const volta = ctx.linhaParaObjeto_(ctx.objetoParaLinha_(card, ctx.COLUNAS), ctx.COLUNAS, TZ);
  assert.strictEqual(volta.prazo, '');
  assert.strictEqual(volta.data_conclusao, '');
});

test('booleano não tocado lê como false, e não como ""', () => {
  // requireCheckbox() não escreve nas células vazias, então elas voltam '' do getValues.
  const linha = ctx.COLUNAS.map(() => '');
  const obj = ctx.linhaParaObjeto_(linha, ctx.COLUNAS, TZ);
  assert.strictEqual(obj.aguardando_cliente, false);
});

test('texto é trimado na leitura', () => {
  const linha = ctx.COLUNAS.map((c) => (c.campo === 'titulo' ? '  com espaços  ' : ''));
  assert.strictEqual(ctx.linhaParaObjeto_(linha, ctx.COLUNAS, TZ).titulo, 'com espaços');
});

test('data/hora sai no ISO com T, data sai só com o dia', () => {
  const linha = ctx.COLUNAS.map((c) => {
    if (c.campo === 'criado_em') return new Date(2026, 7, 2, 14, 30, 5);
    if (c.campo === 'prazo') return new Date(2026, 7, 2);
    return '';
  });
  const obj = ctx.linhaParaObjeto_(linha, ctx.COLUNAS, TZ);
  assert.strictEqual(obj.criado_em, '2026-08-02T14:30:05');
  assert.strictEqual(obj.prazo, '2026-08-02');
});

test('célula com texto onde deveria haver data devolve "", não lixo', () => {
  const linha = ctx.COLUNAS.map((c) => (c.campo === 'prazo' ? 'amanhã' : ''));
  assert.strictEqual(ctx.linhaParaObjeto_(linha, ctx.COLUNAS, TZ).prazo, '');
});

test('objetoParaLinha_ reclama de campo faltando, em vez de gravar undefined', () => {
  // Rede contra "adicionei coluna no schema e esqueci da montagem do objeto".
  assert.throws(
    () => ctx.objetoParaLinha_({ id: 'x' }, ctx.COLUNAS),
    /ausente/
  );
});

test('o mesmo mapeador serve às três abas', () => {
  const pessoa = { id: 'p1', notion_id: 'n1', nome: 'Lucas', nivel: 'SE',
    data_ultimo_1a1: '', criado_em: new Date(2026, 0, 1), atualizado_em: new Date(2026, 0, 1),
    ativo: true };
  const volta = ctx.linhaParaObjeto_(
    ctx.objetoParaLinha_(pessoa, ctx.COLUNAS_PESSOAS), ctx.COLUNAS_PESSOAS, TZ);
  assert.strictEqual(volta.nome, 'Lucas');
  assert.strictEqual(volta.criado_em, '2026-01-01T00:00:00');
});

test('dataDeIso_ recusa data impossível e formato errado', () => {
  assert.throws(() => ctx.dataDeIso_('2026-02-31', 'prazo'), /não é uma data válida/);
  assert.throws(() => ctx.dataDeIso_('02/08/2026', 'prazo'), /fora do formato/);
  assert.strictEqual(ctx.dataDeIso_('', 'prazo'), '');
});

test('dataDeIso_ não desloca o dia (a armadilha do UTC)', () => {
  // new Date('2026-08-02') seria UTC e, em fuso negativo, voltaria para 01/08.
  const d = ctx.dataDeIso_('2026-08-02', 'prazo');
  assert.strictEqual(d.getDate(), 2);
  assert.strictEqual(d.getMonth(), 7);
});
