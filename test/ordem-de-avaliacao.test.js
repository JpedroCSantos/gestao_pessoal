'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SRC, ARQUIVOS } = require('../mock/emulador');

/**
 * O projeto avalia em QUALQUER ordem de arquivo.
 *
 * Existe por causa de uma quebra em produção: um `const` no nível do arquivo em
 * `CamadaDeAcesso.js` lia `COLUNAS_ANOTACOES`, que mora em `Código.js`. O Apps Script
 * avalia na ordem do EDITOR, onde `CamadaDeAcesso` vem antes de `Código` — a linha rodava
 * com a constante ainda inexistente e o projeto inteiro caía com `ReferenceError`, levando
 * junto as funções que não tinham nada com aquilo.
 *
 * **A suíte não pegou, e esse é o ponto.** O `mock/emulador.js` tem uma lista `ARQUIVOS`
 * com `Código.js` em primeiro, e os 304 testes passavam contra uma ordem que o Google não
 * garante. O comentário do emulador dizia "se quebrar aqui, quebra lá também" — o que não
 * cobre o inverso, que foi o que aconteceu.
 *
 * Então este arquivo testa o emulador tanto quanto o projeto: ele avalia `src/` em ordens
 * que o editor pode ter, e exige que todas carreguem.
 */

const fonteDe = (nomes) =>
  nomes.map((n) => fs.readFileSync(path.join(SRC, n), 'utf8')).join('\n;\n');

/**
 * Avalia a fonte sem rodar nada, com os serviços do Google como parâmetros indefinidos.
 *
 * Só a AVALIAÇÃO importa aqui: é nela que um `const` de nível de arquivo executa, e é ela
 * que o Apps Script faz a cada chamada. Nenhuma função é invocada.
 */
function avaliar(nomes) {
  const servicos = ['SpreadsheetApp', 'DriveApp', 'DocumentApp', 'CalendarApp', 'ScriptApp',
    'PropertiesService', 'LockService', 'HtmlService', 'Utilities', 'Session', 'Logger'];
  new Function(...servicos, fonteDe(nomes))(...servicos.map(() => undefined));
}

test('a ordem ALFABÉTICA carrega — é a que o editor do Apps Script usava quando quebrou', () => {
  const alfabetica = ARQUIVOS.slice().sort((a, b) => a.localeCompare(b));

  // Sanidade do próprio teste: se `Código.js` já fosse o primeiro em ordem alfabética,
  // este caso não estaria exercitando nada.
  assert.notStrictEqual(alfabetica[0], 'Código.js',
    'o caso perde o sentido se o arquivo dos schemas vier primeiro sozinho');

  assert.doesNotThrow(() => avaliar(alfabetica));
});

test('a ordem INVERTIDA carrega — o pior caso para quem depende de ordem', () => {
  assert.doesNotThrow(() => avaliar(ARQUIVOS.slice().reverse()));
});

test('cada arquivo de src/ avalia sozinho, sem os outros', () => {
  // O teste mais duro, e o que falha primeiro quando alguém reintroduz o padrão: se um
  // arquivo precisa de outro só para ser AVALIADO, ele tem referência de nível de arquivo
  // atravessando fronteira. A mensagem nomeia o arquivo, que é o que acelera o conserto.
  ARQUIVOS.forEach((nome) => {
    assert.doesNotThrow(
      () => avaliar([nome]),
      `"${nome}" não avalia sozinho — tem referência a outro arquivo no nível do arquivo. ` +
      'Mova para dentro de uma função: lá o acesso acontece na chamada, quando tudo já carregou.'
    );
  });
});

test('a ordem do emulador continua carregando', () => {
  assert.doesNotThrow(() => avaliar(ARQUIVOS));
});
