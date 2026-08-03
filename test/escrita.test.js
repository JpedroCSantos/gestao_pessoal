'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, comAbas, semearPessoas, classeDoErroLancado } = require('./harness');

/**
 * Escrita contra uma planilha de verdade (fake em memória).
 *
 * Aqui moram as regressões que já custaram caro: o card que foi parar na linha 1001, e a
 * dedupe que precisa rodar dentro do lock. Teste de função pura não pegaria nenhuma das duas.
 */

test('o primeiro card cai na linha 2, não no fim da grade', () => {
  // A regressão original: appendRow posicionava por getLastRow(), que a validação aplicada
  // no corpo inteiro inflava até 1000. Os cards nasciam invisíveis na linha 1001.
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'primeiro' });

  const sheet = ctx._ss.getSheetByName(ctx.TAB_NAME);
  const linha2 = sheet.getRange(2, 1, 1, ctx.COLUNAS.length).getValues()[0];
  assert.strictEqual(linha2[ctx.colunaDe_(ctx.COLUNAS, 'id') - 1], card.id);
  assert.strictEqual(ctx.ultimaLinhaComId_(sheet), 2);
});

test('cards seguintes empilham sem buraco', () => {
  const ctx = comAbas();
  ['a', 'b', 'c'].forEach((t) => ctx.createCard({ titulo: t }));

  const sheet = ctx._ss.getSheetByName(ctx.TAB_NAME);
  const col = ctx.colunaDe_(ctx.COLUNAS, 'titulo');
  assert.deepStrictEqual(
    sheet.getRange(2, col, 3, 1).getValues().map((l) => l[0]),
    ['a', 'b', 'c']
  );
});

test('createCard devolve exatamente o que o listCards devolveria', () => {
  const ctx = comAbas();
  const criado = ctx.createCard({ titulo: 'igual', prazo: '2026-08-08' });
  const lido = ctx.listCards().cards.filter((c) => c.id === criado.id)[0];
  assert.deepStrictEqual(criado, lido);
});

test('listCards ordena por prazo, com os sem prazo no fim', () => {
  const ctx = comAbas();
  ctx.createCard({ titulo: 'sem prazo' });
  ctx.createCard({ titulo: 'tarde', prazo: '2026-12-01' });
  ctx.createCard({ titulo: 'cedo', prazo: '2026-01-01' });

  assert.deepStrictEqual(
    ctx.listCards().cards.map((c) => c.titulo),
    ['cedo', 'tarde', 'sem prazo']
  );
});

test('linha com conteúdo e sem id é contada como ignorada; linha em branco não', () => {
  const ctx = comAbas();
  const sheet = ctx._ss.getSheetByName(ctx.TAB_NAME);
  // Alguém digitou um título direto na planilha, sem passar pela camada.
  sheet.getRange(5, ctx.colunaDe_(ctx.COLUNAS, 'titulo')).setValues([['digitado à mão']]);

  const r = ctx.listCards();
  assert.strictEqual(r.cards.length, 0);
  assert.strictEqual(r.ignoradas, 1, 'lixo com conteúdo precisa aparecer para o front avisar');
});

test('dedupe: mesmo origem_id não entra duas vezes', () => {
  const ctx = comAbas();
  const primeiro = ctx.createCard({ titulo: 'do inbox', origem_id: 'file-42' });

  const erro = classeDoErroLancado(ctx, () =>
    ctx.createCard({ titulo: 'do inbox de novo', origem_id: 'file-42' }));

  assert.strictEqual(erro, 'ErroDuplicado');
  assert.strictEqual(ctx.listCards().cards.length, 1);

  // O id do que já existia viaja na propriedade, para o Log da ingestão.
  try {
    ctx.createCard({ titulo: 'x', origem_id: 'file-42' });
  } catch (err) {
    assert.strictEqual(err.registroExistente, primeiro.id);
  }
});

test('sem origem_id, dois cards iguais são dois cards', () => {
  // Dedupe é da ingestão, não do conteúdo: criar dois cards com o mesmo título é legítimo.
  const ctx = comAbas();
  ctx.createCard({ titulo: 'reunião' });
  ctx.createCard({ titulo: 'reunião' });
  assert.strictEqual(ctx.listCards().cards.length, 2);
});

test('lock ocupado vira ErroLock, e nada é escrito', () => {
  const ctx = carregarProjeto({ lockOcupado: true });
  ctx.setupKanban();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.createCard({ titulo: 'x' })), 'ErroLock');
  assert.strictEqual(ctx.listCards().cards.length, 0);
});

test('o lock é liberado mesmo quando a escrita falha', () => {
  const ctx = comAbas();
  ctx.createCard({ titulo: 'a', origem_id: 'f1' });
  try { ctx.createCard({ titulo: 'b', origem_id: 'f1' }); } catch (e) { /* esperado */ }
  assert.strictEqual(ctx._travasAbertas(), 0, 'finally precisa soltar o lock');
});

test('updateCard aplica o patch e recarimba só o atualizado_em', () => {
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'antes', prazo: '2026-08-08' });

  const depois = ctx.updateCard(card.id, { titulo: 'depois' });
  assert.strictEqual(depois.titulo, 'depois');
  assert.strictEqual(depois.prazo, '2026-08-08', 'campo ausente do patch preserva');
  assert.strictEqual(depois.criado_em, card.criado_em, 'criado_em nunca muda');
  assert.strictEqual(depois.id, card.id);
});

test('updateCard: campo presente e vazio limpa a célula', () => {
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'x', prazo: '2026-08-08' });
  assert.strictEqual(ctx.updateCard(card.id, { prazo: '' }).prazo, '');
});

test('updateCard: id inexistente é ErroNaoEncontrado, e não cria nada', () => {
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateCard('nao-existe', { titulo: 'x' })),
    'ErroNaoEncontrado');
  assert.strictEqual(ctx.listCards().cards.length, 0);
});

test('updateCard não deixa o título ficar vazio', () => {
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'x' });
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.updateCard(card.id, { titulo: '' })), 'ErroValidacao');
});

test('updateCard escreve na mesma linha, sempre', () => {
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'x' });
  const sheet = ctx._ss.getSheetByName(ctx.TAB_NAME);
  const linhaAntes = ctx.linhaDoId_(sheet, card.id);

  for (let i = 0; i < 3; i++) ctx.updateCard(card.id, { titulo: 'v' + i });

  assert.strictEqual(ctx.linhaDoId_(sheet, card.id), linhaAntes);
  assert.strictEqual(ctx.listCards().cards.length, 1);
});

test('createAnotacao grava e devolve a anotação', () => {
  const ctx = comAbas();
  const [pessoa] = semearPessoas(ctx, ['Lucas']);

  const nota = ctx.createAnotacao({
    pessoa_id: pessoa, nota: 'mandou bem', tipo: 'positivo',
    valor_qualidade: true, data: '2026-08-02',
  });

  assert.ok(nota.id);
  assert.strictEqual(nota.pessoa_id, pessoa);
  assert.strictEqual(nota.valor_qualidade, true);
  assert.strictEqual(nota.valor_autogestao, false);
  assert.strictEqual(nota.data, '2026-08-02');
});

test('createAnotacao recusa pessoa_id que não existe', () => {
  // A skill resolve nome→id contra uma lista que pode envelhecer. Sem esta checagem, a nota
  // entra apontando para ninguém e some de todo 1:1.
  const ctx = comAbas();
  semearPessoas(ctx, ['Lucas']);
  assert.strictEqual(
    classeDoErroLancado(ctx, () =>
      ctx.createAnotacao({ pessoa_id: 'fantasma', nota: 'n', tipo: 'positivo' })),
    'ErroValidacao');
});

test('anotação também deduplica por origem_id', () => {
  const ctx = comAbas();
  const [pessoa] = semearPessoas(ctx, ['Lucas']);
  const base = { pessoa_id: pessoa, nota: 'n', tipo: 'positivo', origem_id: 'file-9' };

  ctx.createAnotacao(base);
  assert.strictEqual(classeDoErroLancado(ctx, () => ctx.createAnotacao(base)), 'ErroDuplicado');
});

test('createAnotacao recusa pessoa inativa, em vez de gravar algo invisível', () => {
  /* As telas escondem quem saiu do time, então a nota entraria na aba e não apareceria em
     lugar nenhum. Erro visível em erros/ é melhor que registro invisível — mesmo raciocínio
     do `05` para pessoa não cadastrada. */
  const ctx = comAbas();
  const [saiu] = semearPessoas(ctx, [{ nome: 'Luiz Gustavo', ativo: false }]);

  assert.strictEqual(
    classeDoErroLancado(ctx, () =>
      ctx.createAnotacao({ pessoa_id: saiu, nota: 'n', tipo: 'positivo' })),
    'ErroValidacao');
  assert.strictEqual(ctx.listAnotacoes().length, 0);
});

test('a recusa por inatividade diz que é inatividade, e não "não existe"', () => {
  // Mandam procurar em lugares diferentes: uma é lista desatualizada, a outra é uma caixa.
  const ctx = comAbas();
  const [saiu] = semearPessoas(ctx, [{ nome: 'Luiz Gustavo', ativo: false }]);

  assert.throws(
    () => ctx.createAnotacao({ pessoa_id: saiu, nota: 'n', tipo: 'positivo' }),
    /inativo/);
});

test('listPessoas devolve ordenado por nome e sem as linhas vazias', () => {
  const ctx = comAbas();
  semearPessoas(ctx, ['Viviane', 'Gabriel', 'Lucas']);
  assert.deepStrictEqual(
    ctx.listPessoas().map((p) => p.nome), ['Gabriel', 'Lucas', 'Viviane']);
});

test('listPessoas devolve também quem está inativo', () => {
  /* É a tabela de tradução id→nome do sistema inteiro. Filtrar aqui faria card delegado a
     quem saiu mostrar o uuid e anotação antiga perder o nome. Quem esconde é a tela. */
  const ctx = comAbas();
  semearPessoas(ctx, ['Gabriel', { nome: 'Luiz Gustavo', ativo: false }]);

  const lista = ctx.listPessoas();
  assert.deepStrictEqual(lista.map((p) => p.nome), ['Gabriel', 'Luiz Gustavo']);
  assert.deepStrictEqual(lista.map((p) => p.ativo), [true, false]);
});

/* --------------------- carimbo das datas de transição --------------------- */

/** A data de hoje como a camada a escreve, para comparar sem depender do relógio do teste. */
function hojeIso() {
  const d = new Date();
  const dois = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

test('entrar em In progress carimba data_inicio', () => {
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'Migrar cluster' });
  assert.strictEqual(card.data_inicio, '', 'Not started não carimba nada');

  const depois = ctx.updateCard(card.id, { status: 'In progress' });
  assert.strictEqual(depois.data_inicio, hojeIso());
});

test('voltar para In progress não reinicia data_inicio', () => {
  // "Carrego isto há semanas" é o julgamento do resumo-semanal, e reiniciar o relógio a cada
  // desvio o apagaria. Card que passeia por Delegado e volta continua sendo o mesmo trabalho.
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'Migrar cluster', data_inicio: '2026-06-01' });

  ctx.updateCard(card.id, { status: 'In progress' });
  ctx.updateCard(card.id, { status: 'Delegado' });
  const volta = ctx.updateCard(card.id, { status: 'In progress' });

  assert.strictEqual(volta.data_inicio, '2026-06-01');
});

test('entrar em Delegado recarimba data_delegacao a cada delegação', () => {
  // O oposto do data_inicio, e de propósito: o lembrete de conferência conta o tempo da
  // delegação ATUAL. Manter a data antiga faria um card recém-delegado nascer "atrasado".
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'Reciclar consultores', data_delegacao: '2026-06-01' });

  ctx.updateCard(card.id, { status: 'Delegado' });
  ctx.updateCard(card.id, { status: 'In progress' });
  const redelegado = ctx.updateCard(card.id, { status: 'Delegado' });

  assert.strictEqual(redelegado.data_delegacao, hojeIso());
});

test('entrar em Done carimba data_conclusao, e reabrir preserva a antiga', () => {
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'OS da Anna' });

  const feito = ctx.updateCard(card.id, { status: 'Done' });
  assert.strictEqual(feito.data_conclusao, hojeIso());

  // Reabrir não limpa: quem lê a coluna cruza com status, e apagar sozinho perderia histórico.
  const reaberto = ctx.updateCard(card.id, { status: 'In progress' });
  assert.strictEqual(reaberto.data_conclusao, hojeIso());
});

test('update sem mudar de status não carimba nada', () => {
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'OS da Anna', status: 'Done' });
  const dataDaCriacao = card.data_conclusao;

  const depois = ctx.updateCard(card.id, { status: 'Done', prioridade: 'Alta' });
  assert.strictEqual(depois.data_conclusao, dataDaCriacao);
});

test('data explícita no patch manda sobre o carimbo', () => {
  // Editar a data no front é corrigir o carimbo, não pedir outro por cima dele.
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'OS da Anna' });

  const depois = ctx.updateCard(card.id, { status: 'Done', data_conclusao: '2026-07-15' });
  assert.strictEqual(depois.data_conclusao, '2026-07-15');
});

test('card que nasce Delegado já sai com data_delegacao', () => {
  // O histórico do Notion tem 3 de 4 delegados sem a data, e o lembrete de 7 dias nunca
  // dispara para eles. Criação é transição: sem isto, o buraco se repetiria nos cards novos.
  const ctx = comAbas();
  const card = ctx.createCard({ titulo: 'Reciclar consultores', status: 'Delegado' });

  assert.strictEqual(card.data_delegacao, hojeIso());
  assert.strictEqual(card.data_inicio, '');
  assert.strictEqual(card.data_conclusao, '');
});

/* ------------------------------ registrar1a1 ------------------------------ */

test('registrar1a1 carimba a data na pessoa certa', () => {
  const ctx = comAbas();
  const [gabriel, lucas] = semearPessoas(ctx, ['Gabriel', 'Lucas']);

  const depois = ctx.registrar1a1({ pessoa_id: lucas, data: '2026-09-01' });

  assert.strictEqual(depois.data_ultimo_1a1, '2026-09-01');
  const porId = {};
  ctx.listPessoas().forEach((p) => { porId[p.id] = p; });
  assert.strictEqual(porId[lucas].data_ultimo_1a1, '2026-09-01');
  assert.strictEqual(porId[gabriel].data_ultimo_1a1, '', 'não pode respingar em quem não foi');
});

test('registrar1a1 sem data usa hoje', () => {
  const ctx = comAbas();
  const [lucas] = semearPessoas(ctx, ['Lucas']);
  assert.strictEqual(ctx.registrar1a1({ pessoa_id: lucas }).data_ultimo_1a1, hojeIso());
});

test('registrar1a1 duas vezes é inofensivo — não deduplica porque não precisa', () => {
  // A única entrada do inbox sem dedupe por origem_id: Pessoas não tem a coluna, e regravar
  // a mesma data não faz nada. O que não pode é criar linha, e este caminho nunca cria.
  const ctx = comAbas();
  const [lucas] = semearPessoas(ctx, ['Lucas']);

  ctx.registrar1a1({ pessoa_id: lucas, data: '2026-09-01' });
  ctx.registrar1a1({ pessoa_id: lucas, data: '2026-09-01' });

  assert.strictEqual(ctx.listPessoas().length, 1);
  assert.strictEqual(ctx.listPessoas()[0].data_ultimo_1a1, '2026-09-01');
});

test('registrar1a1 com pessoa inexistente é ErroNaoEncontrado, e não cria ninguém', () => {
  const ctx = comAbas();
  semearPessoas(ctx, ['Lucas']);

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.registrar1a1({ pessoa_id: 'fantasma' })),
    'ErroNaoEncontrado');
  assert.strictEqual(ctx.listPessoas().length, 1);
});

test('registrar1a1 recusa pessoa inativa e não carimba data nenhuma', () => {
  /* A rotina mensal compila "cada pessoa da aba"; quem saiu não entra no ciclo. A skill
     filtra, e isto é a rede — a data carimbada aqui não apareceria em tela nenhuma. */
  const ctx = comAbas();
  const [saiu] = semearPessoas(ctx, [{ nome: 'Luiz Gustavo', ativo: false }]);

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.registrar1a1({ pessoa_id: saiu })), 'ErroValidacao');
  assert.strictEqual(ctx.listPessoas()[0].data_ultimo_1a1, '');
});

test('registrar1a1 sem pessoa_id é ErroValidacao', () => {
  const ctx = comAbas();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.registrar1a1({ data: '2026-09-01' })), 'ErroValidacao');
});

/* ------------------------------ listAnotacoes ----------------------------- */

test('listAnotacoes devolve da mais recente para a mais antiga', () => {
  const ctx = comAbas();
  const [pessoa] = semearPessoas(ctx, ['Lucas']);
  ['2026-07-01', '2026-08-02', '2026-07-15'].forEach((data) => {
    ctx.createAnotacao({ pessoa_id: pessoa, nota: data, tipo: 'positivo', data: data });
  });

  assert.deepStrictEqual(
    ctx.listAnotacoes().map((a) => a.data),
    ['2026-08-02', '2026-07-15', '2026-07-01']);
});

test('anotação sem data vai para o fim, não para o topo', () => {
  // Ela é linha incompleta, não a mais antiga do mundo. Ordenar '' como menor a jogaria
  // para o começo da lista, que é justamente o lugar de maior atenção.
  const ctx = comAbas();
  const [pessoa] = semearPessoas(ctx, ['Lucas']);
  const sheet = ctx._ss.getSheetByName(ctx.ANOTACOES_TAB_NAME);

  ctx.createAnotacao({ pessoa_id: pessoa, nota: 'com data', tipo: 'positivo', data: '2026-07-01' });
  ctx.createAnotacao({ pessoa_id: pessoa, nota: 'sem data', tipo: 'positivo' });

  // createAnotacao sempre preenche `data`; esvazia na célula para simular a linha torta.
  sheet.getRange(3, ctx.colunaDe_(ctx.COLUNAS_ANOTACOES, 'data'), 1, 1).setValues([['']]);

  const notas = ctx.listAnotacoes().map((a) => a.nota);
  assert.strictEqual(notas[notas.length - 1], 'sem data');
});

test('listAnotacoes devolve o schema cru, sem juntar o nome', () => {
  // A tradução id→nome mora no front, junto com a dos tiles. Dois caminhos sairiam de sincronia.
  const ctx = comAbas();
  const [pessoa] = semearPessoas(ctx, ['Lucas']);
  ctx.createAnotacao({ pessoa_id: pessoa, nota: 'n', tipo: 'positivo' });

  const nota = ctx.listAnotacoes()[0];
  assert.strictEqual(nota.pessoa_id, pessoa);
  assert.ok(!('pessoa_nome' in nota));
});
