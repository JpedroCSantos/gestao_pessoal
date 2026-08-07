'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { comAbas, semearPessoas, classeDoErroLancado } = require('./harness');

/**
 * A aba `Notas` — o recado solto.
 *
 * O que estes testes protegem é a **fronteira com Anotações**: nota não tem `tipo` nem
 * `valor_*` porque não julga nada, e as duas FKs são opcionais e independentes. Se alguém
 * um dia tentar fundir as duas abas, é aqui que quebra primeiro.
 */

function montar() {
  const ctx = comAbas();
  const pessoas = semearPessoas(ctx, [
    { nome: 'Ana', ativo: true },
    { nome: 'Saiu', ativo: false },
  ]);
  return { ctx, ana: pessoas[0], saiu: pessoas[1] };
}

/* ------------------------------ o essencial ------------------------------ */

test('nota só precisa de texto', () => {
  const { ctx } = montar();
  const nota = ctx.createNota({ texto: 'lembrar de revisar o processo de deploy' });

  assert.ok(nota.id);
  assert.strictEqual(nota.texto, 'lembrar de revisar o processo de deploy');
  assert.strictEqual(nota.pessoa_id, '', 'sem pessoa é o caso normal, não uma falta');
  assert.strictEqual(nota.card_id, '');
  assert.strictEqual(nota.arquivada, false);
});

test('texto vazio é recusado', () => {
  const { ctx } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createNota({ texto: '' })), 'ErroValidacao');
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createNota({})), 'ErroValidacao');
});

test('data ausente cai para hoje', () => {
  const { ctx } = montar();
  const nota = ctx.createNota({ texto: 'n' });
  assert.match(nota.data, /^\d{4}-\d{2}-\d{2}$/);
});

test('campo gerado não pode vir do cliente', () => {
  const { ctx } = montar();
  ['id', 'criado_em', 'atualizado_em'].forEach((campo) => {
    const payload = { texto: 'n' };
    payload[campo] = 'x';
    assert.strictEqual(classeDoErroLancado(ctx, () => ctx.createNota(payload)),
      'ErroValidacao', campo + ' deveria ser recusado');
  });
});

test('campo que não existe no schema é recusado', () => {
  // A fronteira com Anotações, em teste: `tipo` e `valor_*` não existem aqui.
  const { ctx } = montar();
  ['tipo', 'valor_qualidade', 'nota', 'contexto'].forEach((campo) => {
    const payload = { texto: 'n' };
    payload[campo] = 'x';
    assert.strictEqual(classeDoErroLancado(ctx, () => ctx.createNota(payload)),
      'ErroValidacao', campo + ' não pertence a Notas');
  });
});

/* --------------------------------- as FKs -------------------------------- */

test('pessoa_id aceita quem existe, mesmo INATIVO', () => {
  // Diferença deliberada em relação ao createAnotacao: nota sobre quem saiu do time é
  // informação legítima ("X pediu demissão") e não vai para fila de 1:1 nenhuma.
  const { ctx, saiu } = montar();
  const nota = ctx.createNota({ texto: 'pediu demissão', pessoa_id: saiu });
  assert.strictEqual(nota.pessoa_id, saiu);
});

test('mas createAnotacao continua recusando inativo', () => {
  // O par do teste acima: se os dois passassem a aceitar, a distinção teria se perdido.
  const { ctx, saiu } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () =>
      ctx.createAnotacao({ pessoa_id: saiu, nota: 'n', tipo: 'positivo' })),
    'ErroValidacao');
});

test('pessoa_id inexistente é ErroNaoEncontrado', () => {
  const { ctx } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createNota({ texto: 'n', pessoa_id: 'fantasma' })),
    'ErroNaoEncontrado');
});

test('card_id inexistente é ErroNaoEncontrado', () => {
  const { ctx } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createNota({ texto: 'n', card_id: 'fantasma' })),
    'ErroNaoEncontrado');
});

test('as duas FKs juntas: o caso "X quer participar da demanda A"', () => {
  const { ctx, ana } = montar();
  const card = ctx.createCard({ titulo: 'demanda A' });

  const nota = ctx.createNota({
    texto: 'Ana gostaria de participar da demanda A', pessoa_id: ana, card_id: card.id,
  });

  assert.strictEqual(nota.pessoa_id, ana);
  assert.strictEqual(nota.card_id, card.id);
});

/* -------------------------------- a leitura ------------------------------ */

test('listNotas devolve mais recentes primeiro', () => {
  const { ctx } = montar();
  ctx.createNota({ texto: 'velha', data: '2026-01-01' });
  ctx.createNota({ texto: 'nova', data: '2026-08-01' });
  ctx.createNota({ texto: 'meio', data: '2026-04-01' });

  assert.deepStrictEqual(
    ctx.listNotas().map((n) => n.texto), ['nova', 'meio', 'velha']);
});

test('empate de data e de segundo desempata pela posição na aba', () => {
  /*
   * Várias notas do mesmo dia é o caso comum. E como `criado_em` atravessa com precisão de
   * SEGUNDO, duas notas escritas no mesmo segundo empatam nele também — foi o mock que
   * mostrou isso, escrevendo as duas no mesmo milissegundo. O desempate final é a posição
   * na aba, que nunca empata porque a inserção é append.
   */
  const { ctx } = montar();
  ctx.createNota({ texto: 'primeira', data: '2026-08-01' });
  ctx.createNota({ texto: 'segunda', data: '2026-08-01' });
  ctx.createNota({ texto: 'terceira', data: '2026-08-01' });

  assert.deepStrictEqual(
    ctx.listNotas().map((n) => n.texto),
    ['terceira', 'segunda', 'primeira'],
    'a última escrita vem primeiro, mesmo com criado_em idêntico');
});

test('listNotas inclui arquivadas, com a flag', () => {
  // Filtrar aqui tornaria a arquivada inalcançável pelo front sem uma segunda função.
  const { ctx } = montar();
  const nota = ctx.createNota({ texto: 'resolvida' });
  ctx.arquivarNota(nota.id, true);

  const lista = ctx.listNotas();
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].arquivada, true);
});

/* ------------------------------- o arquivar ------------------------------ */

test('arquiva e desarquiva', () => {
  const { ctx } = montar();
  const nota = ctx.createNota({ texto: 'n' });

  assert.strictEqual(ctx.arquivarNota(nota.id, true).arquivada, true);
  assert.strictEqual(ctx.arquivarNota(nota.id, false).arquivada, false);
});

test('arquivar carimba atualizado_em', () => {
  const { ctx } = montar();
  const nota = ctx.createNota({ texto: 'n' });
  const depois = ctx.arquivarNota(nota.id, true);

  assert.ok(depois.atualizado_em);
  assert.strictEqual(depois.criado_em, nota.criado_em, 'criado_em não se mexe');
});

test('arquivar id inexistente é ErroNaoEncontrado', () => {
  const { ctx } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.arquivarNota('fantasma', true)), 'ErroNaoEncontrado');
});

test('arquivar sem id é ErroValidacao', () => {
  const { ctx } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.arquivarNota('', true)), 'ErroValidacao');
});

test('só booleano verdadeiro arquiva — string não conta', () => {
  // Mesma regra do mapeador em todo o projeto: booleano é `=== true`, e não "coisa que
  // parece verdadeira". Aqui importa porque o valor chega do cliente.
  const { ctx } = montar();
  const nota = ctx.createNota({ texto: 'n' });
  assert.strictEqual(ctx.arquivarNota(nota.id, 'sim').arquivada, false);
});

/* --------------------------------- o lock -------------------------------- */

test('lock ocupado vira ErroLock', () => {
  const ctx = comAbas({ lockOcupado: true });
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createNota({ texto: 'n' })), 'ErroLock');
});
