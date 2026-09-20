'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, semearPessoas, classeDoErroLancado } = require('./harness');
const { criarPasta, criarArquivo } = require('../mock/apps-script');

/**
 * Comentários do 1:1, gravados no Doc do compilado que está aberto na tela.
 *
 * As quatro regras que estes testes existem para travar:
 *
 *   1. **Vai no Doc aberto, inclusive de data anterior.** O comentário é resposta àquele
 *      texto. Exceção consciente à regra do `05`, que proíbe a *skill* de mexer em Doc
 *      antigo — a regra é para compilar não reescrever histórico, e acrescentar o que foi
 *      dito na conversa não reescreve nada.
 *   2. **`resumo_id` é obrigatório e tem que ser da pasta DAQUELA pessoa.** Sem a primeira
 *      metade, a função vira "acrescente texto a qualquer Doc que a conta alcança", exposta
 *      ao cliente. Sem a segunda, comentar no compilado de um carimba o 1:1 de outro.
 *   3. **O parágrafo leva a data inteira.** O nome do arquivo deixou de datar o conteúdo.
 *   4. **Carimba `data_ultimo_1a1` com hoje** — e isso só funciona porque o carimbo está
 *      FORA do lock: `registrar1a1` toma o mesmo `getScriptLock()`, e lock do Apps Script
 *      não é reentrante. Aninhado, tudo viraria ErroLock depois de 20 segundos.
 */

function montar(opcoes = {}) {
  const resumos = criarPasta('Resumos');

  const ctx = carregarProjeto(Object.assign({}, opcoes, {
    pastas: { resumos },
    propriedades: { RESUMOS_FOLDER_ID: resumos.getId() },
  }));

  ctx.setupKanban();
  ctx.setupPessoas();
  ctx.setupAnotacoes();
  ctx.setupNotas();
  ctx.setupLog();

  /* Todo mundo numa chamada só: `semearPessoas` reescreve a aba e reaproveita os ids, então
     semear duas vezes faz o id guardado da primeira apontar para outra pessoa. */
  const ids = semearPessoas(ctx, [
    { nome: 'Ana Ribeiro' }, { nome: 'Bruno' }, { nome: 'Saiu', ativo: false },
  ]);
  return { ctx, resumos, ana: ids[0], bruno: ids[1], saiu: ids[2] };
}

const hojeIso = () => {
  const d = new Date();
  const dois = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate());
};

/** A pessoa da aba `Pessoas`, para ler `data_ultimo_1a1`. */
const pessoa = (ctx, id) => ctx.listPessoas().filter((p) => p.id === id)[0];

/** Uma pasta de pessoa com um compilado dentro — o cenário de toda a tela de Resumos. */
function comCompilado(resumos, nome, data, conteudo) {
  const pasta = criarPasta(nome, resumos);
  return { pasta, doc: criarArquivo(data, conteudo, pasta) };
}

/* ------------------------------- validação ------------------------------- */

test('pessoa_id e texto são obrigatórios', () => {
  const { ctx, ana } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.comentar1a1({ texto: 'x' })), 'ErroValidacao');
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.comentar1a1({ pessoa_id: ana, texto: '  ' })),
    'ErroValidacao');
});

test('resumo_id é obrigatório — não existe destino padrão', () => {
  /*
   * O ponto do desenho. Antes, sem `resumo_id` a função criava o Doc de hoje; era esse
   * fallback silencioso que fazia o comentário aparecer num arquivo novo em vez de no que
   * estava na tela. Recusar é o que garante que ninguém escreva "em algum lugar".
   */
  const { ctx, ana } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.comentar1a1({ pessoa_id: ana, texto: 'x' })),
    'ErroValidacao');
});

test('pessoa inativa é recusada — 1:1 pressupõe alguém no time', () => {
  const { ctx, resumos, saiu } = montar();
  const { doc } = comCompilado(resumos, 'Saiu', hojeIso(), 'compilado');
  assert.strictEqual(
    classeDoErroLancado(
      ctx, () => ctx.comentar1a1({ pessoa_id: saiu, texto: 'x', resumo_id: doc.getId() })),
    'ErroValidacao');
});

/* --------------------------- de quem é o Doc ----------------------------- */

test('Doc fora da pasta de resumos é recusado', () => {
  // Sem esta guarda a função é um "acrescente texto a qualquer Doc" chamável por
  // google.script.run — a mesma razão pela qual lerResumo tem a checagem.
  const { ctx, ana } = montar();
  const solto = criarArquivo('2026-08-01', 'documento de outra pasta', criarPasta('Outra'));

  assert.strictEqual(
    classeDoErroLancado(
      ctx, () => ctx.comentar1a1({ pessoa_id: ana, texto: 'x', resumo_id: solto.getId() })),
    'ErroNaoEncontrado');
  assert.strictEqual(solto._conteudo(), 'documento de outra pasta', 'nada foi escrito');
});

test('Doc da pasta de OUTRA pessoa é recusado', () => {
  /*
   * O par silencioso: o texto cairia no compilado de Bruno e o carimbo iria para Ana. Duas
   * metades erradas, nenhuma visível.
   */
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Bruno', hojeIso(), 'compilado do Bruno');

  assert.strictEqual(
    classeDoErroLancado(
      ctx, () => ctx.comentar1a1({ pessoa_id: ana, texto: 'x', resumo_id: doc.getId() })),
    'ErroNaoEncontrado');
  assert.strictEqual(doc._conteudo(), 'compilado do Bruno', 'o Doc do Bruno ficou intacto');
  assert.strictEqual(pessoa(ctx, ana).data_ultimo_1a1, '', 'e Ana não foi carimbada');
});

test('id inexistente vira ErroNaoEncontrado', () => {
  const { ctx, ana } = montar();
  assert.strictEqual(
    classeDoErroLancado(
      ctx, () => ctx.comentar1a1({ pessoa_id: ana, texto: 'x', resumo_id: 'nao-existe' })),
    'ErroNaoEncontrado');
});

/* ---------------------------- onde o texto cai --------------------------- */

test('escreve no Doc aberto, e o compilado continua lá', () => {
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'o read compilado de hoje');

  const r = ctx.comentar1a1({
    pessoa_id: ana, texto: 'disse que vai testar exceção', resumo_id: doc.getId(),
  });

  assert.strictEqual(r.id, doc.getId(), 'o mesmo arquivo, não outro');
  assert.match(r.texto, /o read compilado de hoje/, 'acrescenta, não sobrescreve');
  assert.match(r.texto, /disse que vai testar exceção/);
});

test('escreve no Doc de data anterior quando é o que está aberto', () => {
  /*
   * A inversão da regra antiga, e o motivo de existir este teste com este nome: comentar
   * lendo o compilado de julho grava EM julho. Antes criava um Doc de hoje, e era isso que
   * separava o diálogo em dois arquivos.
   */
  const { ctx, resumos, ana } = montar();
  const { pasta, doc } = comCompilado(resumos, 'Ana Ribeiro', '2026-07-10', 'compilado de julho');

  const r = ctx.comentar1a1({
    pessoa_id: ana, texto: 'comentário de hoje', resumo_id: doc.getId(),
  });

  assert.strictEqual(r.id, doc.getId());
  assert.strictEqual(r.titulo, '2026-07-10', 'o nome do arquivo não muda');
  assert.match(r.texto, /comentário de hoje/);

  const arquivos = [];
  const it = pasta.getFiles();
  while (it.hasNext()) arquivos.push(it.next().getName());
  assert.deepStrictEqual(arquivos, ['2026-07-10'], 'nenhum Doc de hoje foi criado');
});

test('nenhuma pasta nova é criada — a função só escreve em Doc que já existe', () => {
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'compilado');

  ctx.comentar1a1({ pessoa_id: ana, texto: 'x', resumo_id: doc.getId() });

  const pastas = [];
  const it = resumos.getFolders();
  while (it.hasNext()) pastas.push(it.next().getName());
  assert.deepStrictEqual(pastas, ['Ana Ribeiro']);
});

/* ------------------------------ o parágrafo ------------------------------ */

test('o parágrafo leva a data INTEIRA, não só a hora', () => {
  /*
   * Consequência direta de escrever no Doc aberto: o nome do arquivo deixou de datar o
   * conteúdo. Um comentário de agosto mora no Doc `2026-07-10`, e com só `HH:mm` reler daqui
   * a três meses responderia "quando ele disse isso?" pelo nome do arquivo — errado por
   * semanas.
   */
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', '2026-07-10', 'compilado de julho');

  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'com data', resumo_id: doc.getId() });
  assert.match(r.texto, new RegExp(hojeIso() + ' \\d{2}:\\d{2} — com data'));
});

test('comentário em tópicos vira um parágrafo por linha', () => {
  /*
   * O conserto que a caixa expansível deixou à vista. `appendParagraph` cria UM parágrafo, e
   * o Docs descarta o `\n` de dentro do texto — a anotação em tópicos entrava corrida, com o
   * fim de uma linha colado no começo da seguinte ("…Gabriel.- Incentivando…"). O dublê
   * também descarta o `\n`, senão este teste passaria com o código quebrado.
   */
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'compilado');

  const r = ctx.comentar1a1({
    pessoa_id: ana,
    texto: '- Elogiou Gustavo, Viviane e Gabriel.\n- Incentivou a pensarem por si.\n- MAIA: pergunta mais sobre negócio.',
    resumo_id: doc.getId(),
  });

  const linhas = r.texto.split('\n');
  assert.ok(linhas.some((l) => new RegExp('^' + hojeIso() + ' \\d{2}:\\d{2} — - Elogiou Gustavo, Viviane e Gabriel\\.$').test(l)),
    'a primeira linha leva o carimbo e nada mais');
  assert.ok(linhas.includes('- Incentivou a pensarem por si.'), 'a segunda é parágrafo próprio');
  assert.ok(linhas.includes('- MAIA: pergunta mais sobre negócio.'), 'e a terceira também');
  assert.doesNotMatch(r.texto, /Gabriel\.- Incentivou/, 'nada de linha colada na seguinte');
});

test('só a primeira linha leva o carimbo — é um evento, não sete', () => {
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'compilado');

  const r = ctx.comentar1a1({
    pessoa_id: ana, texto: 'um\ndois\ntrês', resumo_id: doc.getId(),
  });
  const carimbos = (r.texto.match(new RegExp(hojeIso() + ' \\d{2}:\\d{2} —', 'g')) || []).length;
  assert.strictEqual(carimbos, 1, 'hora repetida por linha faria parecer três gravações');
});

test('linha em branco não vira parágrafo vazio', () => {
  // Cada appendParagraph já é um parágrafo com espaçamento próprio: manter a linha vazia
  // produziria buraco no Doc.
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'compilado');

  const r = ctx.comentar1a1({
    pessoa_id: ana, texto: 'primeiro\n\n\n   \nsegundo', resumo_id: doc.getId(),
  });
  const depois = r.texto.slice(r.texto.indexOf(ctx.TITULO_COMENTARIOS));
  assert.strictEqual(depois.split('\n').filter((l) => !l.trim()).length, 0,
    'nenhuma linha vazia depois do cabeçalho');
  assert.match(depois, /primeiro/);
  assert.match(depois, /segundo/);
});

test('dois comentários no mesmo Doc: um cabeçalho, dois parágrafos', () => {
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'compilado');

  ctx.comentar1a1({ pessoa_id: ana, texto: 'primeiro ponto', resumo_id: doc.getId() });
  const r = ctx.comentar1a1({
    pessoa_id: ana, texto: 'segundo ponto', resumo_id: doc.getId(),
  });

  const cabecalhos = r.texto.split(ctx.TITULO_COMENTARIOS).length - 1;
  assert.strictEqual(cabecalhos, 1, 'cabeçalho repetido encheria o Doc de títulos');
  assert.match(r.texto, /primeiro ponto/);
  assert.match(r.texto, /segundo ponto/);
});

/* ------------------------------- o carimbo ------------------------------- */

test('comentar carimba data_ultimo_1a1 com HOJE, não com a data do Doc', () => {
  /*
   * O carimbo é o ponto: comentário é o EVENTO do 1:1, e é ele que destrava a fila do Hoje
   * sem depender da rotina mensal rodar. E a conversa é de hoje mesmo quando o compilado que
   * a conduziu é de julho — carimbar julho ressuscitaria a cobrança no dia seguinte.
   */
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', '2026-07-10', 'compilado de julho');
  assert.strictEqual(pessoa(ctx, ana).data_ultimo_1a1, '', 'começa em branco');

  ctx.comentar1a1({ pessoa_id: ana, texto: 'x', resumo_id: doc.getId() });
  assert.strictEqual(pessoa(ctx, ana).data_ultimo_1a1, hojeIso());
});

test('o carimbo não derruba a gravação — o lock não é reentrante', () => {
  /*
   * O teste que justifica o desenho. `registrar1a1` toma o `getScriptLock()` por conta
   * dele; se o `comentar1a1` o chamasse de dentro do próprio lock, o tryLock interno
   * falharia e a gravação inteira viraria ErroLock. Passar aqui prova que o carimbo está
   * fora do lock.
   */
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'compilado');

  const r = ctx.comentar1a1({
    pessoa_id: ana, texto: 'sobreviveu ao carimbo', resumo_id: doc.getId(),
  });

  assert.match(r.texto, /sobreviveu ao carimbo/);
  assert.strictEqual(pessoa(ctx, ana).data_ultimo_1a1, hojeIso());
});

test('lock ocupado vira ErroLock, sem escrever nada', () => {
  const { ctx, resumos, ana } = montar({ lockOcupado: true });
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'compilado');

  assert.strictEqual(
    classeDoErroLancado(
      ctx, () => ctx.comentar1a1({ pessoa_id: ana, texto: 'x', resumo_id: doc.getId() })),
    'ErroLock');

  assert.strictEqual(doc._conteudo(), 'compilado', 'o Doc não foi tocado');
  assert.strictEqual(pessoa(ctx, ana).data_ultimo_1a1, '', 'e o carimbo não saiu');
});

/* ------------------------- o retorno para a tela ------------------------- */

test('devolve o texto completo, para a tela recarregar sem segunda chamada', () => {
  const { ctx, resumos, ana } = montar();
  const { doc } = comCompilado(resumos, 'Ana Ribeiro', hojeIso(), 'compilado');

  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'algo', resumo_id: doc.getId() });

  assert.ok(r.id && r.url && r.texto && r.data);
  assert.strictEqual(r.pessoa.nome, 'Ana Ribeiro');
  assert.strictEqual(r.data, hojeIso(), 'a data do evento, não a do arquivo');
});
