'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { comAbas, semearPessoas, classeDoErroLancado } = require('./harness');

/**
 * O apoio às skills.
 *
 * O que importa aqui é que a referência colada nas instruções continue casando com a aba:
 * um id errado no markdown vira anotação recusada na captura, que é o pior momento para
 * descobrir qualquer coisa.
 */

test('a referência traz nome, id e nível de cada pessoa', () => {
  const ctx = comAbas();
  const ids = semearPessoas(ctx, ['Gabriel', 'Lucas']);
  const md = ctx.gerarReferenciaDePessoas();

  ids.forEach((id) => assert.ok(md.includes(id), `id ausente: ${id}`));
  assert.ok(md.includes('| Gabriel |'));
  assert.ok(md.includes('| Lucas |'));
  assert.ok(md.includes('SE'));
});

test('a referência sai na mesma ordem do listPessoas', () => {
  // A skill lê de cima para baixo; ordem instável faria o diff da referência mentir sobre
  // o que mudou quando alguém entra no time.
  const ctx = comAbas();
  semearPessoas(ctx, ['Viviane', 'Gabriel', 'Lucas']);
  const md = ctx.gerarReferenciaDePessoas();

  assert.ok(md.indexOf('| Gabriel |') < md.indexOf('| Lucas |'));
  assert.ok(md.indexOf('| Lucas |') < md.indexOf('| Viviane |'));
});

test('a referência ensina o caminho lento para quem não está nela', () => {
  // Sem esta linha, a skill desatualizada chuta um id — e a camada recusa a captura inteira.
  const ctx = comAbas();
  semearPessoas(ctx, ['Lucas']);
  const md = ctx.gerarReferenciaDePessoas();

  assert.match(md, /Pessoas/);
  assert.match(md, /Nunca invente um id/);
});

test('gerar referência com a aba vazia é erro, não um arquivo vazio', () => {
  // Markdown sem ninguém jogaria toda captura no caminho lento em silêncio.
  const ctx = comAbas();
  assert.throws(() => ctx.gerarReferenciaDePessoas(), /Nenhuma pessoa ativa/);
});

test('a referência não oferece quem saiu do time', () => {
  /* Oferecer seria produzir uma captura que a camada recusa — o erro apareceria no meio
     da anotação, que é o único lugar onde ele custa desistência. */
  const ctx = comAbas();
  semearPessoas(ctx, ['Gabriel', { nome: 'Luiz Gustavo', ativo: false }]);
  const md = ctx.gerarReferenciaDePessoas();

  assert.match(md, /Gabriel/);
  assert.ok(!md.includes('Luiz Gustavo'), 'inativo não deveria estar na referência');
});

test('aba só com inativos é erro, e o erro diz quantos existem', () => {
  /* É o estado logo depois de criar a coluna, com as caixas ainda desmarcadas. "Aba vazia"
     mandaria procurar o problema no lugar errado. */
  const ctx = comAbas();
  semearPessoas(ctx, [{ nome: 'Gabriel', ativo: false }]);

  assert.throws(() => ctx.gerarReferenciaDePessoas(), /1 linha\(s\) no total/);
});

test('todo id da referência é aceito pela camada', () => {
  // O teste que fecha o ciclo: o que a referência promete, o createAnotacao precisa aceitar.
  const ctx = comAbas();
  const ids = semearPessoas(ctx, ['Gabriel', 'Lucas']);
  const md = ctx.gerarReferenciaDePessoas();

  ids.forEach((id) => {
    assert.ok(md.includes(id));
    assert.strictEqual(
      classeDoErroLancado(ctx, () =>
        ctx.createAnotacao({ pessoa_id: id, nota: 'n', tipo: 'positivo' })),
      null);
  });
});
