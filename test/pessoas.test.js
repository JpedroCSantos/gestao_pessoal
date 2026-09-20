'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, comAbas, semearPessoas, classeDoErroLancado } = require('./harness');

/**
 * Cadastro e edição de pessoas.
 *
 * Até estas duas funções existirem, a aba `Pessoas` só mudava por migração ou à mão, e
 * digitar a linha direto tinha três armadilhas: `id` que precisa ser UUID porque é o alvo de
 * todas as FKs, `ativo` em branco que lê como `false` e faz a pessoa nascer invisível, e
 * `nivel` fora da lista fechada. Os testes daqui são, na maior parte, essas três.
 *
 * O resto cobre o que a camada recusa de propósito — `notion_id` e `data_ultimo_1a1` são
 * editáveis pelo schema e proibidos por decisão, e uma recusa dessas só existe enquanto
 * alguém a testa.
 */

/* ==========================================================================
   createPessoa
   ========================================================================== */

test('createPessoa devolve exatamente o que o listPessoas devolveria', () => {
  const ctx = comAbas();
  const criada = ctx.createPessoa({ nome: 'Ana Prado', nivel: 'SE' });
  const lida = ctx.listPessoas().filter((p) => p.id === criada.id)[0];
  assert.deepStrictEqual(criada, lida);
});

test('quem entra no time entra ATIVO', () => {
  // A armadilha nº 1 da digitação à mão: booleano vazio lê como false, e a pessoa nasce
  // invisível em todas as telas sem nenhum erro aparecer.
  const ctx = comAbas();
  assert.strictEqual(ctx.createPessoa({ nome: 'Bruno' }).ativo, true);
});

test('pessoa criada aqui nasce com notion_id vazio — é o endereço do rollback', () => {
  const ctx = comAbas();
  assert.strictEqual(ctx.createPessoa({ nome: 'Carla' }).notion_id, '');
});

test('a primeira pessoa cai na linha 2, não no fim da grade', () => {
  // Mesma regressão do card que foi parar na linha 1001: a validação aplicada no corpo
  // inteiro infla o getLastRow(), e appendRow escreveria depois dela.
  const ctx = comAbas();
  const pessoa = ctx.createPessoa({ nome: 'Diana' });

  const sheet = ctx._ss.getSheetByName(ctx.PESSOAS_TAB_NAME);
  const linha2 = sheet.getRange(2, 1, 1, ctx.COLUNAS_PESSOAS.length).getValues()[0];
  assert.strictEqual(linha2[ctx.colunaDe_(ctx.COLUNAS_PESSOAS, 'id') - 1], pessoa.id);
});

test('pessoas seguintes empilham sem buraco', () => {
  const ctx = comAbas();
  ['Ana', 'Bruno', 'Carla'].forEach((nome) => ctx.createPessoa({ nome }));

  const sheet = ctx._ss.getSheetByName(ctx.PESSOAS_TAB_NAME);
  const col = ctx.colunaDe_(ctx.COLUNAS_PESSOAS, 'nome');
  assert.deepStrictEqual(
    sheet.getRange(2, col, 3, 1).getValues().map((l) => l[0]),
    ['Ana', 'Bruno', 'Carla']
  );
});

test('o id é gerado pela camada, e é único', () => {
  // Não afirma o FORMATO do id: quem o produz é o `Utilities.getUuid()`, e o dublê devolve
  // um contador. Afirmar "parece um uuid" aqui testaria o dublê, não o projeto. O que
  // importa — e o que a digitação à mão erra — é que ele existe, é único e não vem de fora.
  const ctx = comAbas();
  const a = ctx.createPessoa({ nome: 'Elisa' });
  const b = ctx.createPessoa({ nome: 'Fernando' });

  assert.ok(a.id, 'pessoa sem id é linha que o listPessoas descarta');
  assert.notStrictEqual(a.id, b.id);
  assert.notStrictEqual(a.id, a.nome, 'id derivado do nome quebraria ao renomear');
});

test('createPessoa sem nome é ErroValidacao', () => {
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nivel: 'SE' })),
    'ErroValidacao'
  );
  assert.strictEqual(ctx.listPessoas().length, 0);
});

test('createPessoa com nível fora da lista é ErroValidacao', () => {
  // A armadilha nº 3: o dropdown da aba barra a digitação, mas não o texto colado.
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nome: 'Fábio', nivel: 'Estagiário' })),
    'ErroValidacao'
  );
  assert.strictEqual(ctx.listPessoas().length, 0);
});

test('nível vazio é aceito — nem todo cadastro sabe o nível no dia', () => {
  const ctx = comAbas();
  assert.strictEqual(ctx.createPessoa({ nome: 'Gabriel' }).nivel, '');
});

test('createPessoa recusa "ativo" no payload e manda usar o updatePessoa', () => {
  const ctx = comAbas();
  let mensagem = '';
  try {
    ctx.createPessoa({ nome: 'Helena', ativo: false });
  } catch (err) {
    mensagem = err.message;
  }
  assert.match(mensagem, /ErroValidacao/);
  assert.match(mensagem, /updatePessoa/, 'a recusa precisa dizer por onde se desativa alguém');
});

test('createPessoa recusa notion_id — vazio significa "nasceu aqui"', () => {
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nome: 'Igor', notion_id: 'abc-123' })),
    'ErroValidacao'
  );
});

test('createPessoa recusa data_ultimo_1a1 — quem carimba é o registrar1a1', () => {
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nome: 'Julia', data_ultimo_1a1: '2026-09-01' })),
    'ErroValidacao'
  );
});

test('createPessoa recusa campo gerado pela camada', () => {
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nome: 'Lia', id: 'eu-escolhi' })),
    'ErroValidacao'
  );
});

test('createPessoa recusa campo que não existe no schema', () => {
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nome: 'Marco', email: 'm@x.com' })),
    'ErroValidacao'
  );
});

test('nome repetido entre ativos é recusado, e nada é escrito', () => {
  // Não é preciosismo: a skill de captura resolve "a Ana" para um id pela lista de ativos.
  // Duas Anas ativas fazem a anotação ir para a pessoa errada sem erro nenhum aparecer.
  const ctx = comAbas();
  ctx.createPessoa({ nome: 'Ana Prado' });

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nome: 'Ana Prado' })),
    'ErroValidacao'
  );
  assert.strictEqual(ctx.listPessoas().length, 1, 'a segunda não pode ter entrado');
});

test('a recusa de nome repetido ignora maiúsculas', () => {
  const ctx = comAbas();
  ctx.createPessoa({ nome: 'Ana Prado' });
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nome: 'ana prado' })),
    'ErroValidacao'
  );
});

test('nome repetido de quem está INATIVO passa — ele não entra na referência das skills', () => {
  const ctx = comAbas();
  const [saiu] = semearPessoas(ctx, [{ nome: 'Ana Prado', ativo: false }]);

  const nova = ctx.createPessoa({ nome: 'Ana Prado' });
  assert.strictEqual(nova.ativo, true);
  assert.strictEqual(ctx.listPessoas().length, 2);
  assert.notStrictEqual(nova.id, saiu);
});

test('createPessoa com o lock ocupado é ErroLock, e nada é escrito', () => {
  const ctx = carregarProjeto({ lockOcupado: true });
  ctx.setupPessoas();

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createPessoa({ nome: 'Nina' })),
    'ErroLock'
  );
  assert.strictEqual(ctx.listPessoas().length, 0);
});

test('a pessoa recém-criada já serve de FK para uma anotação', () => {
  // O teste que prova que o cadastro é completo: id de verdade e `ativo` marcado. Com
  // qualquer um dos dois errado, o createAnotacao recusa.
  const ctx = comAbas();
  const pessoa = ctx.createPessoa({ nome: 'Otávio', nivel: 'SE' });

  const anotacao = ctx.createAnotacao({
    pessoa_id: pessoa.id, nota: 'puxou a investigação sozinho', tipo: 'positivo',
  });
  assert.strictEqual(anotacao.pessoa_id, pessoa.id);
});

/* ==========================================================================
   updatePessoa
   ========================================================================== */

test('updatePessoa desativa, e o listPessoas continua devolvendo a pessoa', () => {
  // É o contrato do `04`: listPessoas é a tabela de tradução id→nome do sistema inteiro.
  // Filtrar aqui faria card delegado a quem saiu mostrar o uuid.
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);

  assert.strictEqual(ctx.updatePessoa(id, { ativo: false }).ativo, false);

  const lista = ctx.listPessoas();
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].nome, 'Ana');
  assert.strictEqual(lista[0].ativo, false);
});

test('desativar faz efeito: a camada passa a recusar anotação para a pessoa', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  ctx.createAnotacao({ pessoa_id: id, nota: 'antes', tipo: 'positivo' });

  ctx.updatePessoa(id, { ativo: false });

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createAnotacao({ pessoa_id: id, nota: 'depois', tipo: 'positivo' })),
    'ErroValidacao'
  );
});

test('reativar devolve a pessoa à escrita', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, [{ nome: 'Ana', ativo: false }]);

  assert.strictEqual(ctx.updatePessoa(id, { ativo: true }).ativo, true);
  assert.strictEqual(
    ctx.createAnotacao({ pessoa_id: id, nota: 'voltou', tipo: 'positivo' }).pessoa_id,
    id
  );
});

test('desativar não apaga a linha nem quebra a anotação antiga', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  const anotacao = ctx.createAnotacao({ pessoa_id: id, nota: 'histórico', tipo: 'positivo' });

  ctx.updatePessoa(id, { ativo: false });

  assert.strictEqual(ctx.listAnotacoes().filter((a) => a.id === anotacao.id)[0].pessoa_id, id);
  assert.strictEqual(ctx.listPessoas().filter((p) => p.id === id)[0].nome, 'Ana');
});

test('updatePessoa corrige nome e nível', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);

  const depois = ctx.updatePessoa(id, { nome: 'Ana Prado', nivel: 'TTL' });
  assert.strictEqual(depois.nome, 'Ana Prado');
  assert.strictEqual(depois.nivel, 'TTL');
  assert.strictEqual(depois.ativo, true, 'campo ausente no patch preserva');
});

test('campo ausente no patch preserva o valor antigo', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  ctx.registrar1a1({ pessoa_id: id, data: '2026-09-01' });

  const depois = ctx.updatePessoa(id, { nivel: 'TTL' });
  assert.strictEqual(depois.nome, 'Ana');
  assert.strictEqual(depois.data_ultimo_1a1, '2026-09-01', 'o patch não pode zerar o 1:1');
});

test('updatePessoa recarimba atualizado_em', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  const antes = ctx.listPessoas()[0].atualizado_em;

  const depois = ctx.updatePessoa(id, { nivel: 'TTL' }).atualizado_em;
  assert.notStrictEqual(depois, antes);
});

test('updatePessoa não deixa o nome ficar vazio', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updatePessoa(id, { nome: '  ' })),
    'ErroValidacao'
  );
  assert.strictEqual(ctx.listPessoas()[0].nome, 'Ana', 'nada pode ter sido escrito');
});

test('updatePessoa com nível fora da lista é ErroValidacao', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updatePessoa(id, { nivel: 'Sênior' })),
    'ErroValidacao'
  );
});

test('updatePessoa com id inexistente é ErroNaoEncontrado, e não cadastra ninguém', () => {
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updatePessoa('nao-existe', { nome: 'Fantasma' })),
    'ErroNaoEncontrado'
  );
  assert.strictEqual(ctx.listPessoas().length, 0);
});

test('updatePessoa recusa notion_id e data_ultimo_1a1 no patch', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updatePessoa(id, { notion_id: 'outro' })),
    'ErroValidacao'
  );
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updatePessoa(id, { data_ultimo_1a1: '2026-01-01' })),
    'ErroValidacao'
  );
});

test('a porta do data_ultimo_1a1 continua sendo o registrar1a1', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  assert.strictEqual(
    ctx.registrar1a1({ pessoa_id: id, data: '2026-09-10' }).data_ultimo_1a1,
    '2026-09-10'
  );
});

test('renomear para o nome de outra pessoa ATIVA é recusado', () => {
  const ctx = comAbas();
  const [ana, bruno] = semearPessoas(ctx, ['Ana Prado', 'Bruno Melo']);

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updatePessoa(bruno, { nome: 'Ana Prado' })),
    'ErroValidacao'
  );
  assert.strictEqual(
    ctx.listPessoas().filter((p) => p.id === bruno)[0].nome,
    'Bruno Melo',
    'nada pode ter sido escrito'
  );
  assert.ok(ana);
});

test('renomear para o nome de alguém INATIVO passa', () => {
  const ctx = comAbas();
  const [, bruno] = semearPessoas(ctx, [{ nome: 'Ana Prado', ativo: false }, 'Bruno Melo']);
  assert.strictEqual(ctx.updatePessoa(bruno, { nome: 'Ana Prado' }).nome, 'Ana Prado');
});

test('manter o próprio nome não conta como repetido', () => {
  // O bug óbvio de uma checagem ingênua: a pessoa colide consigo mesma e nunca mais
  // consegue trocar de nível.
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  assert.strictEqual(ctx.updatePessoa(id, { nome: 'Ana', nivel: 'TTL' }).nivel, 'TTL');
});

test('desativar alguém nunca esbarra na checagem de nome', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  assert.strictEqual(ctx.updatePessoa(id, { ativo: false }).ativo, false);
});

test('reativar quem tem homônimo ativo é recusado, e ele continua inativo', () => {
  // O caso que só aparece com o tempo: ela sai, entra outra com o mesmo nome, e alguém
  // tenta reativar a primeira. É aqui que a ambiguidade nasceria.
  const ctx = comAbas();
  const [saiu] = semearPessoas(ctx, [{ nome: 'Ana Prado', ativo: false }]);
  ctx.createPessoa({ nome: 'Ana Prado' });

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updatePessoa(saiu, { ativo: true })),
    'ErroValidacao'
  );
  assert.strictEqual(ctx.listPessoas().filter((p) => p.id === saiu)[0].ativo, false);
});

test('updatePessoa escreve sempre na mesma linha', () => {
  const ctx = comAbas();
  const ids = semearPessoas(ctx, ['Ana', 'Bruno', 'Carla']);
  const sheet = ctx._ss.getSheetByName(ctx.PESSOAS_TAB_NAME);
  const antes = ctx.ultimaLinhaPreenchida_(sheet, ctx.colunaDe_(ctx.COLUNAS_PESSOAS, 'id'));

  ctx.updatePessoa(ids[1], { nivel: 'TTL' });

  assert.strictEqual(
    ctx.ultimaLinhaPreenchida_(sheet, ctx.colunaDe_(ctx.COLUNAS_PESSOAS, 'id')),
    antes,
    'update não pode acrescentar linha'
  );
  assert.deepStrictEqual(
    ctx.listPessoas().map((p) => p.nome),
    ['Ana', 'Bruno', 'Carla']
  );
});

test('updatePessoa com o lock ocupado é ErroLock, e nada muda', () => {
  const ctx = carregarProjeto({ lockOcupado: true });
  ctx.setupPessoas();
  const [id] = semearPessoas(ctx, ['Ana']);

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updatePessoa(id, { ativo: false })),
    'ErroLock'
  );
  assert.strictEqual(ctx.listPessoas()[0].ativo, true);
});

test('updatePessoa sem patch é ErroValidacao', () => {
  const ctx = comAbas();
  const [id] = semearPessoas(ctx, ['Ana']);
  assert.strictEqual(classeDoErroLancado(ctx, () => ctx.updatePessoa(id, null)), 'ErroValidacao');
});

/* ==========================================================================
   O que as duas alimentam
   ========================================================================== */

test('a referência das skills enxerga quem entrou e esquece quem saiu', () => {
  // `gerarReferenciaDePessoas` lista só os ativos. É o elo que torna o cadastro útil para a
  // captura por voz — e o motivo de a checagem de nome repetido olhar só para os ativos.
  // Semeia ANTES de criar: o `semearPessoas` escreve a partir da linha 2, e inverter a
  // ordem sobrescreveria a pessoa recém-cadastrada.
  const ctx = comAbas();
  const [saiu] = semearPessoas(ctx, [{ nome: 'Bruno Melo', ativo: false }]);
  const nova = ctx.createPessoa({ nome: 'Ana Prado', nivel: 'SE' });

  const md = ctx.gerarReferenciaDePessoas();
  assert.match(md, /Ana Prado/);
  assert.match(md, new RegExp(nova.id));
  assert.ok(!md.includes('Bruno Melo'), 'quem saiu não pode ser oferecido na captura');
  assert.ok(saiu);
});
