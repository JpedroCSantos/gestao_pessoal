'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto, semearPessoas, classeDoErroLancado } = require('./harness');
const { criarPasta, criarArquivo } = require('../mock/apps-script');

/**
 * Comentários do 1:1, gravados no Doc de hoje da pessoa.
 *
 * As duas regras que estes testes existem para travar:
 *
 *   1. **Nunca escreve em Doc de data anterior.** A `compilador-1a1` proíbe (`05`), e
 *      comentar lendo um compilado de julho não pode alterar julho.
 *   2. **Carimba `data_ultimo_1a1`** — e isso só funciona porque o carimbo está FORA do
 *      lock: `registrar1a1` toma o mesmo `getScriptLock()`, e lock do Apps Script não é
 *      reentrante. Aninhado, tudo viraria ErroLock depois de 20 segundos.
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

  const ids = semearPessoas(ctx, [{ nome: 'Ana Ribeiro' }, { nome: 'Saiu', ativo: false }]);
  return { ctx, resumos, ana: ids[0], saiu: ids[1] };
}

const hojeIso = () => {
  const d = new Date();
  const dois = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate());
};

/** A pessoa da aba `Pessoas`, para ler `data_ultimo_1a1`. */
const pessoa = (ctx, id) => ctx.listPessoas().filter((p) => p.id === id)[0];

/* ------------------------------- validação ------------------------------- */

test('pessoa_id e texto são obrigatórios', () => {
  const { ctx, ana } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.comentar1a1({ texto: 'x' })), 'ErroValidacao');
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.comentar1a1({ pessoa_id: ana, texto: '  ' })),
    'ErroValidacao');
});

test('pessoa inativa é recusada — 1:1 pressupõe alguém no time', () => {
  const { ctx, saiu } = montar();
  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.comentar1a1({ pessoa_id: saiu, texto: 'x' })),
    'ErroValidacao');
});

/* ---------------------------- o Doc e a pasta ---------------------------- */

test('sem pasta e sem Doc, cria os dois', () => {
  const { ctx, resumos, ana } = montar();
  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'concordou com o ponto do debug' });

  assert.strictEqual(r.criouDoc, true);
  assert.strictEqual(r.titulo, hojeIso(), 'o nome do Doc é a data em ISO');
  assert.match(r.texto, /concordou com o ponto do debug/);
  assert.match(r.texto, /sem compilação prévia/,
    'Doc que nasce de comentário avisa que não houve compilado');

  const pastas = [];
  const it = resumos.getFolders();
  while (it.hasNext()) pastas.push(it.next().getName());
  assert.deepStrictEqual(pastas, ['Ana Ribeiro']);
});

test('com Doc de hoje já existente, acrescenta em vez de criar outro', () => {
  const { ctx, resumos, ana } = montar();
  const pasta = criarPasta('Ana Ribeiro', resumos);
  criarArquivo(hojeIso(), 'o read compilado de hoje', pasta);

  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'disse que vai testar exceção' });

  assert.strictEqual(r.criouDoc, false);
  assert.match(r.texto, /o read compilado de hoje/, 'o compilado continua lá');
  assert.match(r.texto, /disse que vai testar exceção/);

  const arquivos = [];
  const it = pasta.getFiles();
  while (it.hasNext()) arquivos.push(it.next().getName());
  assert.strictEqual(arquivos.length, 1, 'um Doc por dia, não dois');
});

test('NUNCA escreve no Doc de data anterior', () => {
  // A regra do `05`. Comentar lendo o compilado de julho grava em hoje, não em julho.
  const { ctx, resumos, ana } = montar();
  const pasta = criarPasta('Ana Ribeiro', resumos);
  const antigo = criarArquivo('2026-07-10', 'compilado de julho', pasta);

  const r = ctx.comentar1a1({
    pessoa_id: ana, texto: 'comentário de hoje', resumo_id: antigo.getId(),
  });

  assert.notStrictEqual(r.id, antigo.getId());
  assert.strictEqual(r.titulo, hojeIso());
  assert.strictEqual(antigo._conteudo(), 'compilado de julho', 'julho ficou intacto');
});

test('o compilado usado na conversa fica referenciado', () => {
  const { ctx, resumos, ana } = montar();
  const pasta = criarPasta('Ana Ribeiro', resumos);
  const antigo = criarArquivo('2026-07-10', 'compilado de julho', pasta);

  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'x', resumo_id: antigo.getId() });
  assert.match(r.texto, new RegExp('Compilado usado na conversa: ' + antigo.getId()));
});

test('dois comentários no mesmo dia: um cabeçalho, dois parágrafos', () => {
  const { ctx, ana } = montar();
  ctx.comentar1a1({ pessoa_id: ana, texto: 'primeiro ponto' });
  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'segundo ponto' });

  const cabecalhos = r.texto.split(ctx.TITULO_COMENTARIOS).length - 1;
  assert.strictEqual(cabecalhos, 1, 'cabeçalho repetido encheria o Doc de títulos');
  assert.match(r.texto, /primeiro ponto/);
  assert.match(r.texto, /segundo ponto/);
});

test('cada comentário leva a hora', () => {
  const { ctx, ana } = montar();
  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'com hora' });
  assert.match(r.texto, /\d{2}:\d{2} — com hora/);
});

test('pessoas diferentes vão para pastas diferentes', () => {
  const { ctx, resumos } = montar();
  const ids = semearPessoas(ctx, [{ nome: 'Bruno' }, { nome: 'Camila' }]);

  ctx.comentar1a1({ pessoa_id: ids[0], texto: 'do Bruno' });
  ctx.comentar1a1({ pessoa_id: ids[1], texto: 'da Camila' });

  const nomes = [];
  const it = resumos.getFolders();
  while (it.hasNext()) nomes.push(it.next().getName());
  assert.deepStrictEqual(nomes.sort(), ['Bruno', 'Camila']);
});

/* ------------------------------- o carimbo ------------------------------- */

test('comentar carimba data_ultimo_1a1', () => {
  // O carimbo é o ponto: comentário é o EVENTO do 1:1, e é ele que destrava a fila do Hoje
  // sem depender da rotina mensal rodar.
  const { ctx, ana } = montar();
  assert.strictEqual(pessoa(ctx, ana).data_ultimo_1a1, '', 'começa em branco');

  ctx.comentar1a1({ pessoa_id: ana, texto: 'x' });
  assert.strictEqual(pessoa(ctx, ana).data_ultimo_1a1, hojeIso());
});

test('o carimbo não derruba a gravação — o lock não é reentrante', () => {
  /*
   * O teste que justifica o desenho. `registrar1a1` toma o `getScriptLock()` por conta
   * dele; se o `comentar1a1` o chamasse de dentro do próprio lock, o tryLock interno
   * falharia e a gravação inteira viraria ErroLock. Passar aqui prova que o carimbo está
   * fora do lock.
   */
  const { ctx, ana } = montar();
  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'sobreviveu ao carimbo' });

  assert.match(r.texto, /sobreviveu ao carimbo/);
  assert.strictEqual(pessoa(ctx, ana).data_ultimo_1a1, hojeIso());
});

test('lock ocupado vira ErroLock, sem escrever nada', () => {
  const { ctx, resumos, ana } = montar({ lockOcupado: true });

  assert.strictEqual(
    classeDoErroLancado(ctx, () => ctx.comentar1a1({ pessoa_id: ana, texto: 'x' })),
    'ErroLock');

  const it = resumos.getFolders();
  assert.strictEqual(it.hasNext(), false, 'nem a pasta da pessoa foi criada');
});

/* ------------------------- o retorno para a tela ------------------------- */

test('devolve o texto completo, para a tela recarregar sem segunda chamada', () => {
  const { ctx, ana } = montar();
  const r = ctx.comentar1a1({ pessoa_id: ana, texto: 'algo' });

  assert.ok(r.id && r.url && r.texto && r.data);
  assert.strictEqual(r.pessoa.nome, 'Ana Ribeiro');
  assert.strictEqual(r.data, hojeIso());
});
