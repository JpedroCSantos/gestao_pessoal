'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, comAbas, lerDumpLocal, temDumps } = require('./harness');
const { criarPasta, criarArquivo } = require('../mock/apps-script');

/**
 * Os dumps reais de `data/input/`, contra o código que vai carregá-los.
 *
 * Estes testes valem por dois motivos: provam que a migração roda antes de rodar de
 * verdade, e travam as contagens do `00` — se alguém refizer um dump e o número mudar, o
 * plano descobre aqui, não na reconciliação.
 *
 * **Só rodam na máquina de quem migrou.** Os dumps carregam feedback nominal sobre gente
 * real e ficam fora do repositório público — ver README.
 */

if (!temDumps()) {
  test('dumps do Notion', { skip: 'data/input/ não está neste clone' }, () => {});
  return;
}

const PESSOAS = lerDumpLocal('pessoas.json');
const KANBAN = lerDumpLocal('kanban.json');
const ANOTACOES = lerDumpLocal('anotacoes.json');

test('os dumps têm a contagem que o 00 declara', () => {
  assert.strictEqual(PESSOAS.pessoas.length, 7);
  assert.strictEqual(ANOTACOES.anotacoes.length, 60);
  // 38: os 2 fantasmas foram excluídos no Notion antes do dump ser refeito.
  assert.strictEqual(KANBAN.cards.length, 38);
  assert.strictEqual(KANBAN.cards.filter((c) => !c.titulo).length, 0);
});

test('os dumps trazem last_edited_time em todo registro', () => {
  // Sem ele o import degrada atualizado_em para a data de criação — comportamento correto,
  // mas que faria o resumo-semanal ver como parado um card mexido ontem. Se um dump for
  // refeito sem o campo, é aqui que isso aparece, e não no board três semanas depois.
  KANBAN.cards.forEach((c) => assert.ok(c.last_edited_time, `card sem last_edited_time: ${c.titulo}`));
  ANOTACOES.anotacoes.forEach((a) => assert.ok(a.last_edited_time, `anotação sem last_edited_time: ${a.id}`));
});

test('nenhuma FK órfã nos dumps', () => {
  const ids = new Set(PESSOAS.pessoas.map((p) => p.id));

  ANOTACOES.anotacoes.forEach((a) => {
    assert.ok(ids.has(a.pessoa_id), `anotação ${a.id} aponta para pessoa inexistente`);
  });
  KANBAN.cards.forEach((c) => {
    c.delegado_para.forEach((d) => {
      assert.ok(ids.has(d.id), `card ${c.id} delega para pessoa inexistente`);
    });
  });
});

test('os níveis do dump cabem na lista fechada', () => {
  const ctx = carregarProjeto();
  PESSOAS.pessoas.forEach((p) => {
    assert.ok(ctx.NIVEL_OPCOES.includes(p.nivel), `nível fora da lista: ${p.nivel}`);
  });
});

test('os status e prioridades do dump cabem nas listas', () => {
  const ctx = carregarProjeto();
  KANBAN.cards.filter((c) => c.status).forEach((c) => {
    assert.ok(ctx.STATUS_OPCOES.includes(c.status), `status fora da lista: ${c.status}`);
  });
  KANBAN.cards.filter((c) => c.prioridade).forEach((c) => {
    assert.ok(ctx.PRIORIDADE_OPCOES.includes(c.prioridade), `prioridade: ${c.prioridade}`);
  });
});

test('o vocabulário LEVTY do dump é exatamente o do código', () => {
  const ctx = carregarProjeto();
  const noDump = new Set();
  ANOTACOES.anotacoes.forEach((a) => (a.valores || []).forEach((v) => noDump.add(v)));

  assert.deepStrictEqual([...noDump].sort(), Object.keys(ctx.VALORES_LEVTY).sort());
});

test('as 7 pessoas convertem, com criado_em vindo da origem', () => {
  const ctx = comAbas();
  const agora = new Date();
  const convertidas = PESSOAS.pessoas.map((r) => ctx.pessoaDoDump_(r, agora));

  assert.strictEqual(convertidas.length, 7);
  assert.strictEqual(new Set(convertidas.map((p) => p.id)).size, 7, 'ids únicos');

  convertidas.forEach((p, i) => {
    assert.strictEqual(p.notion_id, PESSOAS.pessoas[i].id);
    assert.ok(p.criado_em < agora, 'criado_em precisa vir do Notion, não do relógio da migração');
    assert.strictEqual(+p.atualizado_em, +p.criado_em);
  });
});

test('importPessoas insere as 7 e é idempotente na segunda rodada', () => {
  const ctx = comAbas();

  const primeira = ctx.importPessoas(PESSOAS.pessoas);
  assert.deepStrictEqual(
    { inseridos: primeira.inseridos, atualizados: primeira.atualizados, erros: primeira.erros },
    { inseridos: 7, atualizados: 0, erros: [] });
  assert.strictEqual(ctx.listPessoas().length, 7);

  const segunda = ctx.importPessoas(PESSOAS.pessoas);
  assert.strictEqual(segunda.inseridos, 0);
  assert.strictEqual(segunda.atualizados, 7);
  assert.strictEqual(ctx.listPessoas().length, 7, 'reimportar não pode duplicar');
});

test('reimportar preserva o id local e o criado_em', () => {
  // Trocar a PK quebraria toda FK que aponta para ela.
  const ctx = comAbas();
  ctx.importPessoas(PESSOAS.pessoas);
  const antes = ctx.listPessoas();

  ctx.importPessoas(PESSOAS.pessoas);
  const depois = ctx.listPessoas();

  antes.forEach((p, i) => {
    assert.strictEqual(depois[i].id, p.id);
    assert.strictEqual(depois[i].criado_em, p.criado_em);
  });
});

test('registro inválido vai para erros[] e não impede os outros', () => {
  const ctx = comAbas();
  const rows = PESSOAS.pessoas.concat([{ id: 'x', nome: '', nivel: 'SE' }]);

  const r = ctx.importPessoas(rows);
  assert.strictEqual(r.inseridos, 7);
  assert.strictEqual(r.erros.length, 1);
  assert.match(r.erros[0], /nome/);
});

test('as 60 anotações atravessam envelope → schema → linha → leitura', () => {
  const ctx = comAbas();
  const idsPorNotion = {};
  ctx.importPessoas(PESSOAS.pessoas);
  ctx.listPessoas().forEach((p) => { idsPorNotion[p.notion_id] = p.id; });

  ANOTACOES.anotacoes.forEach((a) => {
    const payload = ctx.traduzirEnvelopeDeAnotacao_({
      pessoa_id: idsPorNotion[a.pessoa_id],
      nota: a.nota,
      tipo_nota: a.tipo,
      valores: a.valores,
      contexto: a.contexto || '',
      data: a.data,
    });
    const criada = ctx.createAnotacao(payload);

    assert.strictEqual(criada.nota, a.nota.trim());
    assert.strictEqual(criada.tipo, a.tipo);
    assert.strictEqual(criada.data, a.data);

    const marcados = Object.keys(ctx.VALORES_LEVTY)
      .filter((r) => criada[ctx.VALORES_LEVTY[r]] === true).length;
    assert.strictEqual(marcados, a.valores.length, `valores de ${a.id}`);
  });
});

test('contexto começando com "-" sobrevive à ida e volta', () => {
  // Sete campos do dump começam com "- ". Sem o formato de texto, virariam fórmula.
  const ctx = comAbas();
  const [pessoa] = require('./harness').semearPessoas(ctx, ['Lucas']);
  const contexto = '- Não soube fazer um Patch - Nos desenvolvimentos mais complexos';

  const criada = ctx.createAnotacao({
    pessoa_id: pessoa, nota: 'n', tipo: 'melhoria', contexto,
  });
  assert.strictEqual(criada.contexto, contexto);
});

test('um envelope de anotação de verdade atravessa o inbox inteiro', () => {
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
  ctx.setupKanban(); ctx.setupPessoas(); ctx.setupAnotacoes(); ctx.setupLog();
  ctx.importPessoas(PESSOAS.pessoas);

  const original = ANOTACOES.anotacoes[0];
  const pessoa = ctx.listPessoas().filter((p) => p.notion_id === original.pessoa_id)[0];

  criarArquivo('nota.json', JSON.stringify({
    tipo: 'anotacao',
    payload: {
      pessoa_id: pessoa.id, nota: original.nota, tipo_nota: original.tipo,
      valores: original.valores, contexto: original.contexto, data: original.data,
    },
  }), inbox);

  const r = ctx.processarInbox();
  assert.strictEqual(r.processados, 1);
  assert.strictEqual(r.erros, 0);
  assert.strictEqual(erros._arquivos.length, 0);
});
