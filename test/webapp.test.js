'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto } = require('./harness');
const { criarPasta, criarArquivo } = require('../mock/apps-script');

/**
 * A rota do Web App.
 *
 * O `doGet` deixou de ser só "serve o board" quando os painéis das rotinas passaram a
 * precisar de uma URL. O que importa aqui é que `view` venha da URL e mesmo assim não
 * escolha arquivo livremente, e que painel ainda não gerado seja uma tela, não um stack.
 */

function comPainel(arquivos = {}) {
  const painel = criarPasta('painel');
  Object.keys(arquivos).forEach((nome) => criarArquivo(nome, arquivos[nome], painel));

  return carregarProjeto({
    pastas: { painel },
    propriedades: { PAINEL_FOLDER_ID: painel.getId() },
  });
}

test('sem view, serve o board', () => {
  const ctx = comPainel();
  assert.match(ctx.doGet({ parameter: {} }).getContent(), /template:Index/);
});

test('doGet sem parâmetro nenhum não quebra', () => {
  // O Apps Script chama doGet() sem argumento em alguns caminhos.
  const ctx = comPainel();
  assert.match(ctx.doGet().getContent(), /template:Index/);
});

test('view=semana serve o HTML que a rotina escreveu', () => {
  const ctx = comPainel({ 'semana.html': '<h1>Semana de 27/07</h1>' });
  const saida = ctx.doGet({ parameter: { view: 'semana' } });

  assert.strictEqual(saida.getContent(), '<h1>Semana de 27/07</h1>');
  assert.match(saida.getTitle(), /Semana/);
});

test('os dois painéis leem dois arquivos diferentes', () => {
  const ctx = comPainel({ 'semana.html': 'SEMANA', 'mes.html': 'MES' });
  assert.strictEqual(ctx.doGet({ parameter: { view: 'semana' } }).getContent(), 'SEMANA');
  assert.strictEqual(ctx.doGet({ parameter: { view: 'mes' } }).getContent(), 'MES');
});

test('view=dia não existe mais — o app calcula a tela Hoje da planilha', () => {
  // O painel do dia era a mesma informação com até 10 minutos de atraso. Se a rota voltar
  // sem que alguém decida trazê-la de volta, é regressão.
  const ctx = comPainel({ 'dia.html': 'PAINEL ANTIGO' });
  const saida = ctx.doGet({ parameter: { view: 'dia' } });

  assert.ok(!saida.getContent().includes('PAINEL ANTIGO'));
  assert.match(saida.getContent(), /Painel desconhecido/);
});

test('view fora da lista não vira nome de arquivo', () => {
  // `view` vem da URL. Se ele fosse concatenado num nome, qualquer arquivo da pasta ficaria
  // legível por quem adivinhasse o nome — a lista fechada é o que impede isso.
  const ctx = comPainel({ 'segredo.html': 'NÃO PODE SAIR' });
  const saida = ctx.doGet({ parameter: { view: 'segredo' } });

  assert.ok(!saida.getContent().includes('NÃO PODE SAIR'));
  assert.match(saida.getContent(), /Painel desconhecido/);
});

test('painel que a rotina ainda não gerou vira aviso, não erro', () => {
  // Caso comum, não falha: a rotina escreve na segunda, e antes disso não há arquivo.
  const ctx = comPainel();
  const saida = ctx.doGet({ parameter: { view: 'semana' } });

  assert.match(saida.getContent(), /ainda não existe/);
  assert.match(saida.getContent(), /quando a rotina/);
});

test('pasta de painéis não configurada explica o que falta', () => {
  const ctx = carregarProjeto();
  assert.match(ctx.doGet({ parameter: { view: 'semana' } }).getContent(), /PAINEL_FOLDER_ID/);
});

test('o aviso escapa o que veio da URL', () => {
  const ctx = comPainel();
  const saida = ctx.doGet({ parameter: { view: '<script>alert(1)</script>' } });

  assert.ok(!saida.getContent().includes('<script>'));
  assert.match(saida.getContent(), /&lt;script&gt;/);
});
