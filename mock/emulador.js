'use strict';

/**
 * Carrega os arquivos de `src/` sobre os dublês do Apps Script.
 *
 * **Tem dois consumidores, e é por isso que mora aqui e não em `test/`:** os testes
 * (`test/harness.js`) e o servidor local (`mock/servidor.js`). Os dois precisam do mesmo
 * projeto rodando fora do Google, e uma segunda implementação divergiria — o executor
 * passaria a demonstrar um sistema que os testes não cobrem.
 */

const fs = require('fs');
const path = require('path');

const { criarAmbiente } = require('./apps-script');

const RAIZ = path.join(__dirname, '..');
const SRC = path.join(RAIZ, 'src');

/**
 * Ordem em que os arquivos são avaliados.
 *
 * `Código.js` vem primeiro porque os schemas referenciam as listas fechadas no nível do
 * arquivo. No Apps Script a ordem é a do editor — se ela mudar lá e os testes continuarem
 * passando, é porque nada depende dela; se quebrar aqui, quebra lá também.
 */
const ARQUIVOS = [
  'Código.js', 'CamadaDeAcesso.js', 'Agenda.js', 'Ingestao.js', 'Migracao.js',
  'Resumos.js', 'Skills.js', 'WebApp.js',
];

/**
 * Carrega o projeto sobre dublês do Apps Script e devolve tudo que ele declara.
 *
 * Os arquivos são concatenados num escopo só, que é como o Apps Script realmente avalia:
 * todos compartilham o global, e `const` de um enxerga o de outro. Carregar cada arquivo
 * isolado não reproduziria isso.
 *
 * Usa `new Function` em vez de `vm`: o `vm` cria outro realm, e aí um array vindo do
 * projeto não é `deepStrictEqual` a um array do teste — mesma estrutura, protótipos
 * diferentes. Aqui tudo roda no realm de quem chamou, e os serviços do Apps Script entram
 * como parâmetros nomeados em vez de globais.
 *
 * @param {Object} opcoes repassadas a criarAmbiente (lockOcupado, propriedades, pastas)
 * @return {Object} funções e constantes do projeto, mais os `_` de inspeção do ambiente
 */
function carregarProjeto(opcoes = {}) {
  const fonte = ARQUIVOS
    .map((nome) => fs.readFileSync(path.join(SRC, nome), 'utf8'))
    .join('\n;\n');

  const ambiente = criarAmbiente(opcoes);
  const servicos = Object.keys(ambiente).filter((k) => !k.startsWith('_'));
  const declarados = nomesDeclarados(fonte);

  const fabricar = new Function(
    ...servicos,
    `${fonte}\n;\nreturn { ${declarados.join(', ')} };`
  );

  const projeto = fabricar(...servicos.map((nome) => ambiente[nome]));
  return Object.assign(projeto, ambiente);
}

/**
 * Nomes declarados no nível do arquivo — funções e constantes.
 *
 * Só casa declarações sem indentação: as de dentro de função não interessam e, se
 * entrassem no `return`, quebrariam a compilação por não existirem naquele escopo.
 */
function nomesDeclarados(fonte) {
  const nomes = new Set();
  const padroes = [/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm, /^const\s+([A-Za-z_$][\w$]*)\s*=/gm];

  padroes.forEach((padrao) => {
    let achado;
    while ((achado = padrao.exec(fonte)) !== null) nomes.add(achado[1]);
  });
  return [...nomes];
}

module.exports = { carregarProjeto, nomesDeclarados, RAIZ, SRC, ARQUIVOS };
