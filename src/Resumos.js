/**
 * Leitura dos compilados de 1:1. Contrato em models/04-front-end.md e models/05-skills.md.
 *
 * Estrutura no Drive, espelhando a que existia no Notion:
 *
 *     Resumos/
 *       Gustavo/
 *         2026-07-24        ← um Doc por compilação
 *         2026-08-20
 *
 * **Uma pasta por pessoa, um Doc por data — e não um Doc por pessoa com seções datadas.**
 * Com seções, mostrar "o último compilado" obrigaria a parsear texto livre que a skill
 * escreveu, e isso quebraria no dia em que ela mudasse um cabeçalho. Com um arquivo por
 * compilação, "o último" é o arquivo mais recente, e o app nunca precisa entender o texto.
 *
 * Quem escreve é a `compilador-1a1` (sob demanda) e a `compilador-1a1-rotina` (mensal).
 * Aqui só se lê.
 */

/** Pasta raiz dos resumos. Só leitura: quem escreve é a skill, pelo conector do Drive. */
const PROP_RESUMOS = 'RESUMOS_FOLDER_ID';

/**
 * Quem tem resumo, quantos, e de quando — **sem abrir nenhum Doc**.
 *
 * Abrir os sete documentos a cada carga da tela custaria uma chamada de Docs por pessoa,
 * para mostrar uma data que o nome do arquivo já diz. O texto vem depois, por `lerResumo`,
 * e só de quem for realmente aberto.
 *
 * **Casa as pastas contra o time inteiro e só então descarta os inativos.** A ordem importa:
 * filtrar antes faria a pasta de quem saiu do time cair em `orfas`, e o board levantaria
 * *"ou a pessoa saiu, ou o nome divergiu"* — um alarme para o caso normal. Órfã tem que
 * continuar significando o que significa: pasta que não casa com ninguém.
 *
 * @return {{pessoas: Object[], orfas: string[], inativos: number}} `pessoas` são só os
 *     ativos, na ordem de `listPessoas`, cada um com `resumos` do mais recente para o mais
 *     antigo; `orfas` são pastas que não casaram com ninguém; `inativos` é quanta gente
 *     ficou de fora — o board declara, em vez de esconder em silêncio.
 */
function listResumos() {
  const raiz = pastaDeResumos_();

  const porNome = {};
  const todos = listPessoas().map(function (p) {
    const entrada = {
      pessoa_id: p.id, nome: p.nome, nivel: p.nivel,
      data_ultimo_1a1: p.data_ultimo_1a1, ativo: p.ativo, resumos: []
    };
    porNome[chaveDeNome_(p.nome)] = entrada;
    return entrada;
  });

  const orfas = [];
  const pastas = raiz.getFolders();

  while (pastas.hasNext()) {
    const pasta = pastas.next();
    const dona = porNome[chaveDeNome_(pasta.getName())];

    // Pasta que não casa com ninguém não é descartada em silêncio: ou a pessoa nunca
    // existiu na aba, ou o nome divergiu, e as duas coisas alguém precisa saber. Quem está
    // na aba como inativo casa aqui normalmente e sai depois — não é órfã.
    if (!dona) { orfas.push(pasta.getName()); continue; }
    dona.resumos = resumosDaPasta_(pasta);
  }

  const ativos = todos.filter(function (p) { return p.ativo; });

  return { pessoas: ativos, orfas: orfas, inativos: todos.length - ativos.length };
}

/** Os Docs de uma pasta, do mais recente para o mais antigo. */
function resumosDaPasta_(pasta) {
  const lista = [];
  const arquivos = pasta.getFiles();

  while (arquivos.hasNext()) {
    const file = arquivos.next();
    lista.push({
      id: file.getId(),
      titulo: file.getName(),
      data: dataDoResumo_(file),
      url: file.getUrl()
    });
  }

  return lista.sort(function (a, b) { return b.data.localeCompare(a.data); });
}

/**
 * A data de um resumo, a partir do nome do arquivo.
 *
 * Aceita `AAAA-MM-DD`, `DD/MM/AAAA` e `DD-MM-AAAA` porque a migração dos resumos antigos
 * é manual, e recusar um nome por causa do separador transformaria um Doc com conteúdo
 * real em um item sem data. Nome irreconhecível cai para a data de modificação — errado
 * por alguns dias é melhor que invisível.
 */
function dataDoResumo_(file) {
  const nome = String(file.getName()).trim();

  const iso = nome.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];

  const br = nome.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (br) return br[3] + '-' + br[2] + '-' + br[1];

  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return Utilities.formatDate(file.getLastUpdated(), tz, ISO_DATA);
}

/**
 * O texto de um resumo.
 *
 * @param {string} id do Doc, vindo da lista que o `listResumos` devolveu.
 * @return {{id: string, titulo: string, texto: string, url: string}}
 * @throws ErroValidacao se o Doc não estiver sob a pasta de resumos.
 */
function lerResumo(id) {
  const alvo = texto_(id);
  if (!alvo) throw erro_(ERRO_VALIDACAO, 'lerResumo: "id" é obrigatório.');

  // O id chega do cliente. Sem esta checagem, a função viraria um leitor genérico de
  // qualquer Doc a que a conta tenha acesso — e o board não é lugar para isso.
  if (!estaSobResumos_(alvo)) {
    throw erro_(
      ERRO_NAO_ENCONTRADO,
      'o documento "' + alvo + '" não está na pasta de resumos.'
    );
  }

  const doc = DocumentApp.openById(alvo);
  const file = DriveApp.getFileById(alvo);

  return {
    id: alvo,
    titulo: file.getName(),
    texto: doc.getBody().getText(),
    url: file.getUrl()
  };
}

/** O arquivo está numa pasta cujo pai é a raiz de resumos? */
function estaSobResumos_(id) {
  const raiz = pastaDeResumos_().getId();

  let file;
  try {
    file = DriveApp.getFileById(id);
  } catch (err) {
    return false;
  }

  const pais = file.getParents();
  while (pais.hasNext()) {
    const pai = pais.next();
    if (pai.getId() === raiz) return true;

    const avos = pai.getParents();
    while (avos.hasNext()) {
      if (avos.next().getId() === raiz) return true;
    }
  }
  return false;
}

function pastaDeResumos_() {
  const id = String(
    PropertiesService.getScriptProperties().getProperty(PROP_RESUMOS) || ''
  ).trim();

  if (!id) {
    throw new Error(
      'Script Property "' + PROP_RESUMOS + '" não configurada. Preencha com o ID da pasta ' +
      'Resumos no Drive — é lá que a compilador-1a1 grava os 1:1.'
    );
  }
  return DriveApp.getFolderById(id);
}

/**
 * Chave de comparação de nome de pasta com nome de pessoa.
 *
 * **Este é o único lugar do sistema em que nome é chave**, e é uma exceção consciente: a
 * pasta é navegada por gente no Drive, e nomeá-la com um uuid a tornaria ilegível. O risco
 * de nome repetido some porque a comparação é do nome inteiro — "Gustavo" e "Luiz Gustavo"
 * são pastas distintas —, e o que sobra (alguém renomeado) aparece em `orfas` em vez de
 * sumir calado.
 */
function chaveDeNome_(valor) {
  return semAcento_(valor).replace(/\s+/g, ' ').trim();
}
