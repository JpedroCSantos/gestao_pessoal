'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, classeDoErroLancado } = require('./harness');

const ctx = carregarProjeto();
const classe = (fn) => classeDoErroLancado(ctx, fn);

/**
 * Validação de entrada e o contrato de erro do `02`.
 *
 * Cada caso afirma **qual** classe de erro veio, não só que algo falhou: a ingestão decide
 * o destino do arquivo pela classe, então `ErroLock` no lugar de `ErroValidacao` mandaria
 * para `erros/` algo que deveria ser retentado.
 */

test('createCard: título é obrigatório', () => {
  assert.strictEqual(classe(() => ctx.validarPayload_({ titulo: '   ' })), 'ErroValidacao');
  assert.strictEqual(classe(() => ctx.validarPayload_({})), 'ErroValidacao');
});

test('createCard: status ganha default, prioridade não', () => {
  const card = ctx.validarPayload_({ titulo: 'x' });
  assert.strictEqual(card.status, ctx.STATUS_PADRAO);
  assert.strictEqual(card.prioridade, '');
});

test('campo fora do schema é erro, não é ignorado', () => {
  assert.strictEqual(
    classe(() => ctx.validarPayload_({ titulo: 'x', titluo: 'typo' })), 'ErroValidacao');
});

test('campos gerados pela camada não podem vir no payload', () => {
  ctx.CAMPOS_GERADOS.forEach((campo) => {
    const payload = { titulo: 'x' };
    payload[campo] = 'valor';
    assert.strictEqual(classe(() => ctx.validarPayload_(payload)), 'ErroValidacao', campo);
  });
});

test('valor fora da lista fechada é recusado, com as opções na mensagem', () => {
  assert.strictEqual(
    classe(() => ctx.validarPayload_({ titulo: 'x', status: 'Fazendo' })), 'ErroValidacao');
  try {
    ctx.validarPayload_({ titulo: 'x', status: 'Fazendo' });
  } catch (err) {
    assert.match(err.message, /Not started/, 'a mensagem precisa listar o que é aceito');
  }
});

test('lista é sensível a caixa — o front popula do servidor, não há por que tolerar', () => {
  assert.strictEqual(
    classe(() => ctx.validarPayload_({ titulo: 'x', status: 'done' })), 'ErroValidacao');
});

test('createAnotacao: nota, pessoa_id e tipo são obrigatórios', () => {
  const base = { pessoa_id: 'p1', nota: 'n', tipo: 'melhoria' };
  assert.ok(ctx.validarPayloadAnotacao_(base));

  ['pessoa_id', 'nota', 'tipo'].forEach((campo) => {
    const payload = Object.assign({}, base);
    delete payload[campo];
    assert.strictEqual(classe(() => ctx.validarPayloadAnotacao_(payload)), 'ErroValidacao', campo);
  });
});

test('createAnotacao: tipo não tem default', () => {
  // melhoria e positivo são opostos; escolher um por omissão seria inventar julgamento.
  try {
    ctx.validarPayloadAnotacao_({ pessoa_id: 'p', nota: 'n' });
    assert.fail('deveria ter lançado');
  } catch (err) {
    assert.match(err.message, /melhoria/);
  }
});

test('createAnotacao: data ausente cai para hoje, à meia-noite', () => {
  const anotacao = ctx.validarPayloadAnotacao_({ pessoa_id: 'p', nota: 'n', tipo: 'positivo' });
  const hoje = new Date();
  assert.strictEqual(anotacao.data.getFullYear(), hoje.getFullYear());
  assert.strictEqual(anotacao.data.getDate(), hoje.getDate());
  assert.strictEqual(anotacao.data.getHours(), 0);
});

test('createAnotacao: data informada é respeitada', () => {
  const anotacao = ctx.validarPayloadAnotacao_(
    { pessoa_id: 'p', nota: 'n', tipo: 'positivo', data: '2026-06-15' });
  assert.strictEqual(anotacao.data.getMonth(), 5);
  assert.strictEqual(anotacao.data.getDate(), 15);
});

test('classeDoErro_ acha a classe mesmo com prefixo do Apps Script', () => {
  // O runtime às vezes entrega "Exception: ErroValidacao: ...". Ancorar no início da
  // string faria a classe sumir justamente do lado do cliente.
  assert.strictEqual(ctx.classeDoErro_(new Error('Exception: ErroLock: ocupado')), 'ErroLock');
  assert.strictEqual(ctx.classeDoErro_(new Error('ErroDuplicado: já entrou')), 'ErroDuplicado');
  assert.strictEqual(ctx.classeDoErro_(new Error('falha genérica')), '');
});
