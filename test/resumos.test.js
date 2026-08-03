'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, semearPessoas, classeDoErroLancado } = require('./harness');
const { criarPasta, criarArquivo } = require('../mock/apps-script');

/**
 * Os compilados de 1:1 lidos do Drive.
 *
 * O que importa aqui é que a tela nunca precise entender o texto: "o último" é o arquivo
 * mais recente da pasta da pessoa, e a data sai do nome. E que nada suma calado — nem
 * pessoa sem pasta, nem pasta sem pessoa.
 */

/**
 * Monta a estrutura Resumos/<Pessoa>/<Doc>.
 *
 * @param {Object} arvore nome da pessoa → { 'nome-do-doc': 'texto' }
 */
function comResumos(arvore, nomes) {
  const raiz = criarPasta('Resumos');

  Object.keys(arvore).forEach((pessoa) => {
    const pasta = criarPasta(pessoa, raiz);
    Object.keys(arvore[pessoa]).forEach((doc) => {
      criarArquivo(doc, arvore[pessoa][doc], pasta);
    });
  });

  const ctx = carregarProjeto({
    pastas: { resumos: raiz },
    propriedades: { RESUMOS_FOLDER_ID: raiz.getId() },
  });

  ctx.setupKanban();
  ctx.setupPessoas();
  ctx.setupAnotacoes();
  ctx.setupLog();
  semearPessoas(ctx, nomes || Object.keys(arvore));
  return ctx;
}

test('lista uma entrada por pessoa, com os resumos do mais recente ao mais antigo', () => {
  const ctx = comResumos({
    Gustavo: { '2026-07-24': 'primeiro', '2026-08-20': 'segundo' },
  });

  const r = ctx.listResumos();
  const gustavo = r.pessoas.filter((p) => p.nome === 'Gustavo')[0];

  assert.deepStrictEqual(gustavo.resumos.map((x) => x.data), ['2026-08-20', '2026-07-24']);
  assert.strictEqual(r.orfas.length, 0);
});

test('pessoa sem pasta aparece com a lista vazia, não some', () => {
  // É a Viviane do Notion: existe no time e não tem resumo nenhum. A ausência é a
  // informação — a tela precisa poder dizer "nunca teve 1:1 compilado".
  const ctx = comResumos({ Gustavo: { '2026-07-24': 'x' } }, ['Gustavo', 'Viviane']);

  const viviane = ctx.listResumos().pessoas.filter((p) => p.nome === 'Viviane')[0];
  assert.ok(viviane, 'a pessoa sem pasta precisa estar na lista');
  assert.deepStrictEqual(viviane.resumos, []);
});

test('pasta que não casa com ninguém vira órfã, não é descartada', () => {
  const ctx = comResumos({ Gustavo: { '2026-07-24': 'x' }, 'Ex Colaborador': { '2026-01-10': 'y' } },
    ['Gustavo']);

  assert.deepStrictEqual(ctx.listResumos().orfas, ['Ex Colaborador']);
});

test('o nome da pasta casa sem depender de acento nem de espaço extra', () => {
  // A pasta é criada à mão no Drive, e a migração dos resumos antigos também é manual.
  const ctx = comResumos({ 'Joao  Victor': { '2026-07-24': 'x' } }, ['João Victor']);

  const p = ctx.listResumos().pessoas[0];
  assert.strictEqual(p.nome, 'João Victor');
  assert.strictEqual(p.resumos.length, 1);
});

test('a data sai do nome do arquivo, em ISO ou no formato brasileiro', () => {
  // Recusar "24/07/2026" transformaria um Doc com conteúdo real num item sem data.
  const ctx = comResumos({ Gustavo: { '24/07/2026': 'a', '2026-08-20': 'b' } });

  const datas = ctx.listResumos().pessoas[0].resumos.map((x) => x.data);
  assert.deepStrictEqual(datas, ['2026-08-20', '2026-07-24']);
});

test('nome sem data reconhecível cai para a modificação, e não some', () => {
  const ctx = comResumos({ Gustavo: { 'rascunho': 'a' } });

  const resumo = ctx.listResumos().pessoas[0].resumos[0];
  assert.match(resumo.data, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(resumo.titulo, 'rascunho');
});

test('listResumos não abre nenhum Doc', () => {
  // Abrir sete documentos para mostrar sete datas que o nome já diz seria pagar uma
  // chamada de Docs por pessoa a cada carga da tela.
  const ctx = comResumos({ Gustavo: { '2026-07-24': 'texto denso' } });
  let aberturas = 0;
  const original = ctx.DocumentApp.openById;
  ctx.DocumentApp.openById = function (id) { aberturas++; return original(id); };

  ctx.listResumos();
  assert.strictEqual(aberturas, 0);
});

test('lerResumo devolve o texto do Doc', () => {
  const ctx = comResumos({ Gustavo: { '2026-07-24': 'Gustavo é Trainee SE, o mesmo nível…' } });
  const id = ctx.listResumos().pessoas[0].resumos[0].id;

  const resumo = ctx.lerResumo(id);
  assert.strictEqual(resumo.texto, 'Gustavo é Trainee SE, o mesmo nível…');
  assert.strictEqual(resumo.titulo, '2026-07-24');
});

test('lerResumo recusa documento fora da pasta de resumos', () => {
  // O id chega do cliente. Sem esta checagem a função viraria um leitor genérico de
  // qualquer Doc a que a conta tenha acesso.
  const raiz = criarPasta('Resumos');
  const outra = criarPasta('Particular');
  const intruso = criarArquivo('segredo', 'não pode sair', outra);

  const ctx = carregarProjeto({
    pastas: { resumos: raiz, outra: outra },
    propriedades: { RESUMOS_FOLDER_ID: raiz.getId() },
  });
  ctx.setupPessoas();

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.lerResumo(intruso.getId())), 'ErroNaoEncontrado');
});

test('quem saiu do time sai da lista, e a contagem diz quantos', () => {
  const ctx = comResumos(
    { Gustavo: { '2026-07-24': 'x' }, 'Luiz Gustavo': { '2026-07-25': 'y' } },
    ['Gustavo', { nome: 'Luiz Gustavo', ativo: false }]);

  const r = ctx.listResumos();
  assert.deepStrictEqual(r.pessoas.map((p) => p.nome), ['Gustavo']);
  assert.strictEqual(r.inativos, 1);
});

test('a pasta de quem está inativo não vira órfã', () => {
  /* Se o filtro rodasse antes de casar as pastas, desativar alguém levantaria o aviso de
     "pasta sem dona" — um alarme para o caso normal. Órfã tem que continuar significando
     nome divergente, que é o que alguém precisa ir consertar. */
  const ctx = comResumos(
    { 'Luiz Gustavo': { '2026-07-25': 'y' } },
    [{ nome: 'Luiz Gustavo', ativo: false }]);

  assert.deepStrictEqual(ctx.listResumos().orfas, []);
});

test('sem a Script Property, o erro diz qual é e para que serve', () => {
  const ctx = carregarProjeto();
  ctx.setupPessoas();
  assert.throws(() => ctx.listResumos(), /RESUMOS_FOLDER_ID/);
});
