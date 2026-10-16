'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, comAbas, semearPessoas, classeDoErroLancado } = require('./harness');

/**
 * Edição de anotação pelo front.
 *
 * O caso que justifica a função: a skill resolve nome falado para `pessoa_id`, e a lista
 * real tem homônimos ("Luiz") e homófonos ("Vitor" / "João Victor"). Quando ela erra, o
 * feedback entra na pessoa errada e aparece no 1:1 dela. Mover a anotação é o conserto, e é
 * por isso que `pessoa_id` é editável apesar de ser FK.
 *
 * O que estes testes travam, além do caminho feliz:
 *
 *   - **`origem_id` e `notion_id` são intocáveis.** O primeiro é a chave de dedupe do
 *     inbox, e os dois estragos que ele causa — mesmo envelope entrando duas vezes, outro
 *     sendo ignorado para sempre — não têm sintoma visível.
 *   - **A FK só é revalidada quando muda.** Corrigir vírgula em anotação de quem saiu do
 *     time tem que continuar possível, senão desativar alguém trancaria o histórico dele.
 */

/** Uma pessoa ativa e uma anotação dela, que é o cenário de quase todo teste daqui. */
function comAnotacao(extra) {
  const ctx = comAbas();
  const ids = semearPessoas(ctx, ['Ana Prado', 'Bruno Melo', { nome: 'Saiu', ativo: false }]);
  const anotacao = ctx.createAnotacao(Object.assign({
    pessoa_id: ids[0], nota: 'puxou a investigação sozinha', tipo: 'positivo',
  }, extra || {}));
  return { ctx, anotacao, ana: ids[0], bruno: ids[1], saiu: ids[2] };
}

const lida = (ctx, id) => ctx.listAnotacoes().filter((a) => a.id === id)[0];

/* ==========================================================================
   o caminho feliz
   ========================================================================== */

test('updateAnotacao corrige o texto e devolve o que o listAnotacoes devolveria', () => {
  const { ctx, anotacao } = comAnotacao();
  const depois = ctx.updateAnotacao(anotacao.id, { nota: 'puxou a investigação sozinha, até o fim' });

  assert.strictEqual(depois.nota, 'puxou a investigação sozinha, até o fim');
  assert.deepStrictEqual(depois, lida(ctx, anotacao.id));
});

test('campo ausente no patch preserva o valor antigo', () => {
  const { ctx, anotacao, ana } = comAnotacao({ contexto: 'o incidente de terça', data: '2026-09-01' });
  const depois = ctx.updateAnotacao(anotacao.id, { tipo: 'melhoria' });

  assert.strictEqual(depois.tipo, 'melhoria');
  assert.strictEqual(depois.pessoa_id, ana);
  assert.strictEqual(depois.contexto, 'o incidente de terça');
  assert.strictEqual(depois.data, '2026-09-01');
  assert.strictEqual(depois.nota, 'puxou a investigação sozinha');
});

test('campo presente e vazio limpa a célula', () => {
  // Mesma convenção do updateCard: é assim que se apaga uma evidência escrita errado.
  const { ctx, anotacao } = comAnotacao({ contexto: 'evidência que não era' });
  assert.strictEqual(ctx.updateAnotacao(anotacao.id, { contexto: '' }).contexto, '');
});

test('a data pode ser limpa, e não volta a ser hoje sozinha', () => {
  // O create preenche data vazia com hoje. Se o update fizesse o mesmo, "apagar a data"
  // viraria "carimbar hoje" em silêncio — o oposto do que foi pedido.
  const { ctx, anotacao } = comAnotacao({ data: '2026-09-01' });
  assert.strictEqual(ctx.updateAnotacao(anotacao.id, { data: '' }).data, '');
});

test('updateAnotacao recarimba atualizado_em e preserva criado_em', () => {
  const { ctx, anotacao } = comAnotacao();

  /* Envelhece o carimbo na planilha antes de editar. Sem isto o teste não prova nada: o
     transporte leva `atualizado_em` com precisão de SEGUNDO, e criar e editar na mesma
     execução caem no mesmo segundo — a comparação passaria a ser verdadeira por acaso de
     relógio, e falharia ou não conforme a máquina. */
  const sheet = ctx._ss.getSheetByName(ctx.ANOTACOES_TAB_NAME);
  const linha = ctx.linhaComValor_(sheet, ctx.colunaDe_(ctx.COLUNAS_ANOTACOES, 'id'), anotacao.id);
  sheet.getRange(linha, ctx.colunaDe_(ctx.COLUNAS_ANOTACOES, 'atualizado_em'))
    .setValues([[new Date(2026, 0, 1, 9, 0, 0)]]);

  const depois = ctx.updateAnotacao(anotacao.id, { nota: 'outra coisa' });

  assert.strictEqual(depois.criado_em, anotacao.criado_em, 'criar e editar são eventos diferentes');
  assert.notStrictEqual(depois.atualizado_em, '2026-01-01T09:00:00');
});

test('os quatro valores são editáveis, e desmarcar funciona', () => {
  const { ctx, anotacao } = comAnotacao({ valor_autogestao: true, valor_qualidade: true });
  const depois = ctx.updateAnotacao(anotacao.id, {
    valor_autogestao: false, valor_colaboracao: true, valor_qualidade: true,
    valor_transparencia: false,
  });

  assert.strictEqual(depois.valor_autogestao, false);
  assert.strictEqual(depois.valor_colaboracao, true);
  assert.strictEqual(depois.valor_qualidade, true);
  assert.strictEqual(depois.valor_transparencia, false);
});

test('updateAnotacao escreve sempre na mesma linha', () => {
  const { ctx, ana } = comAnotacao();
  const outras = [1, 2].map((n) => ctx.createAnotacao({
    pessoa_id: ana, nota: 'nota ' + n, tipo: 'positivo',
  }));

  const antes = ctx.listAnotacoes().length;
  ctx.updateAnotacao(outras[0].id, { nota: 'editada' });

  assert.strictEqual(ctx.listAnotacoes().length, antes, 'update não pode acrescentar linha');
  assert.strictEqual(lida(ctx, outras[1].id).nota, 'nota 2', 'a vizinha não pode ter sido tocada');
});

/* ==========================================================================
   pessoa_id — o motivo de a função existir
   ========================================================================== */

test('mover a anotação para outra pessoa é o conserto da captura que errou o nome', () => {
  const { ctx, anotacao, ana, bruno } = comAnotacao();
  assert.strictEqual(ctx.updateAnotacao(anotacao.id, { pessoa_id: bruno }).pessoa_id, bruno);

  assert.strictEqual(
    ctx.listAnotacoes().filter((a) => a.pessoa_id === ana).length, 0,
    'tem que SAIR da pessoa errada, não aparecer nas duas'
  );
});

test('mover para alguém que saiu do time é recusado', () => {
  const { ctx, anotacao, saiu, ana } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { pessoa_id: saiu })),
    'ErroValidacao'
  );
  assert.strictEqual(lida(ctx, anotacao.id).pessoa_id, ana, 'nada pode ter sido escrito');
});

test('mover para id inexistente é recusado', () => {
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { pessoa_id: 'nao-existe' })),
    'ErroValidacao'
  );
});

test('pessoa_id não pode ficar vazio', () => {
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { pessoa_id: '' })),
    'ErroValidacao'
  );
});

test('editar anotação de quem JÁ SAIU do time continua possível', () => {
  // A regressão que a revalidação ingênua causaria: desativar alguém trancaria o histórico
  // inteiro dele. O histórico é justamente o que se preserva ao desativar em vez de apagar.
  const ctx = comAbas();
  const [alguem] = semearPessoas(ctx, ['Ana Prado']);
  const anotacao = ctx.createAnotacao({ pessoa_id: alguem, nota: 'com herro', tipo: 'positivo' });

  ctx.updatePessoa(alguem, { ativo: false });

  assert.strictEqual(ctx.updateAnotacao(anotacao.id, { nota: 'com erro' }).nota, 'com erro');
});

/* ==========================================================================
   o que a camada recusa
   ========================================================================== */

test('origem_id não é editável — é a chave de dedupe do inbox', () => {
  const { ctx, anotacao } = comAnotacao({ origem_id: 'file-42' });

  let mensagem = '';
  try { ctx.updateAnotacao(anotacao.id, { origem_id: 'outro' }); } catch (e) { mensagem = e.message; }

  assert.match(mensagem, /ErroValidacao/);
  assert.match(mensagem, /dedup/i, 'a recusa precisa dizer por que, senão vira capricho');
  assert.strictEqual(lida(ctx, anotacao.id).origem_id, 'file-42');
});

test('a dedupe do inbox continua valendo depois de uma edição', () => {
  // O teste que prova que a recusa acima serve para alguma coisa: reprocessar o mesmo
  // envelope depois de editar o texto ainda é inofensivo.
  const { ctx, anotacao, ana } = comAnotacao({ origem_id: 'file-42' });
  ctx.updateAnotacao(anotacao.id, { nota: 'texto corrigido' });

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createAnotacao({
      pessoa_id: ana, nota: 'texto corrigido', tipo: 'positivo', origem_id: 'file-42',
    })),
    'ErroDuplicado'
  );
  assert.strictEqual(ctx.listAnotacoes().length, 1);
});

test('notion_id não é editável', () => {
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { notion_id: 'abc' })),
    'ErroValidacao'
  );
});

test('campo gerado pela camada é recusado', () => {
  const { ctx, anotacao } = comAnotacao();
  ['id', 'criado_em', 'atualizado_em'].forEach((campo) => {
    const patch = {};
    patch[campo] = 'x';
    assert.strictEqual(
      classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, patch)),
      'ErroValidacao',
      campo + ' não pode ser enviado'
    );
  });
});

test('campo que não existe no schema é recusado', () => {
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { humor: 'bom' })),
    'ErroValidacao'
  );
});

test('a nota não pode ficar vazia', () => {
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { nota: '   ' })),
    'ErroValidacao'
  );
  assert.strictEqual(lida(ctx, anotacao.id).nota, 'puxou a investigação sozinha');
});

test('o tipo não pode ficar vazio — positivo e melhoria são opostos', () => {
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { tipo: '' })),
    'ErroValidacao'
  );
});

test('tipo fora da lista fechada é recusado', () => {
  // A armadilha que fez três capturas morrerem com "ponto_forte".
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { tipo: 'ponto_forte' })),
    'ErroValidacao'
  );
});

test('data fora do formato é recusada', () => {
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, { data: '01/09/2026' })),
    'ErroValidacao'
  );
});

test('id inexistente é ErroNaoEncontrado, e não cria anotação nenhuma', () => {
  const { ctx } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao('nao-existe', { nota: 'x' })),
    'ErroNaoEncontrado'
  );
  assert.strictEqual(ctx.listAnotacoes().length, 1);
});

test('updateAnotacao sem id e sem patch é ErroValidacao', () => {
  const { ctx, anotacao } = comAnotacao();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao('', { nota: 'x' })), 'ErroValidacao');
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao(anotacao.id, null)), 'ErroValidacao');
});

test('updateAnotacao com o lock ocupado é ErroLock, e nada muda', () => {
  const ctx = carregarProjeto({ lockOcupado: true });
  ctx.setupKanban(); ctx.setupPessoas(); ctx.setupAnotacoes(); ctx.setupNotas(); ctx.setupLog();
  const [ana] = semearPessoas(ctx, ['Ana Prado']);

  /* O create também bateria no lock, então a linha entra direto na aba — o alvo aqui é o
     update, e precisar do create para montar o cenário esconderia o que se testa. */
  const sheet = ctx._ss.getSheetByName(ctx.ANOTACOES_TAB_NAME);
  const linha = ctx.objetoParaLinha_({
    id: 'anot-1', notion_id: '', pessoa_id: ana, nota: 'original', tipo: 'positivo',
    contexto: '', data: new Date(2026, 8, 1), criado_em: new Date(2026, 8, 1),
    atualizado_em: new Date(2026, 8, 1), valor_autogestao: false, valor_colaboracao: false,
    valor_qualidade: false, valor_transparencia: false, origem_id: '',
  }, ctx.COLUNAS_ANOTACOES);
  sheet.getRange(2, 1, 1, ctx.COLUNAS_ANOTACOES.length).setValues([linha]);

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateAnotacao('anot-1', { nota: 'editada' })),
    'ErroLock'
  );
  assert.strictEqual(lida(ctx, 'anot-1').nota, 'original');
});

/* ==========================================================================
   a lista de campos editáveis sai do schema
   ========================================================================== */

test('a lista de campos editáveis é derivada do schema, sem os gerados e sem os protegidos', () => {
  // Trava a derivação, e não a lista: um quinto `valor_*` no schema tem que virar editável
  // sozinho. Se alguém trocar isto por uma lista literal, este teste cai.
  const ctx = comAbas();
  const esperada = ctx.COLUNAS_ANOTACOES
    .map((c) => c.campo)
    .filter((c) => ['id', 'criado_em', 'atualizado_em', 'notion_id', 'origem_id'].indexOf(c) < 0);

  assert.deepStrictEqual(ctx.camposAnotacaoEditaveis_(), esperada);
});
