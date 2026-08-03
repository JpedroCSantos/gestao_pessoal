'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto } = require('./harness');

const ctx = carregarProjeto();

/**
 * Os schemas são a fonte única de tudo que depende de coluna. Estes testes travam o que o
 * `01` promete: ordem, tipos e a coerência entre schema e as constantes que ele referencia.
 */

test('Kanban tem as 17 colunas do contrato, na ordem', () => {
  assert.deepStrictEqual(
    ctx.COLUNAS.map((c) => c.campo),
    ['id', 'notion_id', 'titulo', 'status', 'prioridade', 'prazo', 'descricao',
     'criado_em', 'atualizado_em', 'aguardando_cliente', 'prazo_cliente',
     'pendencia_cliente', 'delegado_para', 'origem_id',
     'data_inicio', 'data_conclusao', 'data_delegacao']
  );
});

test('Pessoas e Anotações batem com o contrato', () => {
  assert.deepStrictEqual(
    ctx.COLUNAS_PESSOAS.map((c) => c.campo),
    ['id', 'notion_id', 'nome', 'nivel', 'data_ultimo_1a1', 'criado_em', 'atualizado_em',
     'ativo']
  );
  assert.deepStrictEqual(
    ctx.COLUNAS_ANOTACOES.map((c) => c.campo),
    ['id', 'notion_id', 'pessoa_id', 'nota', 'tipo', 'contexto', 'data',
     'criado_em', 'atualizado_em', 'valor_autogestao', 'valor_colaboracao',
     'valor_qualidade', 'valor_transparencia', 'origem_id']
  );
});

test('as colunas novas do Kanban ficam no fim, onde a guarda aceita', () => {
  // Inserir no meio realinharia rótulo sobre dado numa aba com cards. Ver `01`.
  const nomes = ctx.COLUNAS.map((c) => c.campo);
  ['data_inicio', 'data_conclusao', 'data_delegacao'].forEach((campo) => {
    assert.ok(nomes.indexOf(campo) >= 14, `${campo} deveria estar depois de origem_id`);
  });
});

test('todo tipo declarado é conhecido pelos formatadores', () => {
  const validos = ['texto', 'lista', 'data', 'data_hora', 'booleano'];
  [ctx.COLUNAS, ctx.COLUNAS_PESSOAS, ctx.COLUNAS_ANOTACOES, ctx.COLUNAS_LOG].forEach((schema) => {
    schema.forEach((c) => assert.ok(validos.includes(c.tipo), `tipo estranho: ${c.campo}=${c.tipo}`));
  });
});

test('toda coluna de lista declara opcoes, e só elas', () => {
  [ctx.COLUNAS, ctx.COLUNAS_PESSOAS, ctx.COLUNAS_ANOTACOES, ctx.COLUNAS_LOG].forEach((schema) => {
    schema.forEach((c) => {
      if (c.tipo === 'lista') {
        assert.ok(Array.isArray(c.opcoes) && c.opcoes.length, `${c.campo} é lista sem opcoes`);
      } else {
        assert.strictEqual(c.opcoes, undefined, `${c.campo} não é lista mas tem opcoes`);
      }
    });
  });
});

test('VALORES_LEVTY aponta para colunas que existem em Anotações', () => {
  // O mapa é a fonte da tradução do envelope; se ele e o schema divergirem, a nota entra
  // com valor perdido em silêncio.
  Object.values(ctx.VALORES_LEVTY).forEach((campo) => {
    assert.ok(ctx.colunaPorCampo_(ctx.COLUNAS_ANOTACOES, campo), `${campo} não existe no schema`);
  });
  const noSchema = ctx.COLUNAS_ANOTACOES
    .filter((c) => c.campo.startsWith('valor_')).map((c) => c.campo).sort();
  assert.deepStrictEqual(Object.values(ctx.VALORES_LEVTY).sort(), noSchema);
});

test('todo schema tem id, e as abas de dados têm os carimbos', () => {
  [ctx.COLUNAS, ctx.COLUNAS_PESSOAS, ctx.COLUNAS_ANOTACOES].forEach((schema) => {
    ctx.CAMPOS_GERADOS.forEach((campo) => {
      assert.ok(ctx.colunaPorCampo_(schema, campo), `falta ${campo}`);
    });
  });
});

test('colunaDe_ é 1-based e reclama de campo inexistente', () => {
  assert.strictEqual(ctx.colunaDe_(ctx.COLUNAS, 'id'), 1);
  assert.strictEqual(ctx.colunaDe_(ctx.COLUNAS, 'origem_id'), 14);
  assert.throws(() => ctx.colunaDe_(ctx.COLUNAS, 'inexistente'));
});

test('as listas fechadas são as do contrato', () => {
  assert.deepStrictEqual(ctx.STATUS_OPCOES, ['Not started', 'In progress', 'Done', 'Delegado']);
  assert.deepStrictEqual(ctx.PRIORIDADE_OPCOES, ['Alta', 'Média', 'Baixa']);
  assert.deepStrictEqual(ctx.NIVEL_OPCOES, ['Trainee SE', 'SE', 'TTL']);
  assert.deepStrictEqual(ctx.TIPO_NOTA_OPCOES, ['melhoria', 'positivo']);
  assert.ok(ctx.STATUS_OPCOES.includes(ctx.STATUS_PADRAO), 'o default precisa estar na lista');
});
