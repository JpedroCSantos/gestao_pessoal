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

/* ==========================================================================
   COMENTÁRIOS DO 1:1
   --------------------------------------------------------------------------
   O compilado é de mão única: ele diz o que o gestor deve dizer. O que o
   colaborador responde — onde concorda, onde discorda, com o que se compromete
   — não tinha onde ficar, e o momento de capturar é durante a conversa.

   **Sempre no Doc de HOJE daquela pessoa, nunca no que está na tela.** A
   `compilador-1a1` manda acrescentar ao Doc do dia quando ele existe e proíbe
   mexer em data anterior (`05`). Comentar lendo um compilado de julho não pode
   escrever em julho — então grava em hoje, dizendo qual compilação foi usada.

   Por que no Doc e não em aba nova: a `compilador-1a1` **já lê Docs**. A
   compilação do mês que vem enxerga o que ele disse neste mês sem nenhum
   encanamento novo, e sem mudar a skill.
   ========================================================================== */

/** Cabeçalho da seção. Serve de âncora para achar onde acrescentar no mesmo dia. */
const TITULO_COMENTARIOS = '— comentários do 1:1 —';

/**
 * Grava um comentário de 1:1 no Doc de hoje da pessoa, e carimba `data_ultimo_1a1`.
 *
 * O carimbo entra aqui, e **não** é o mesmo caso do compilador sob demanda — que é proibido
 * de carimbar porque compilar é preparação e pode rodar três vezes na semana. Comentário é o
 * **evento**: só existe se a conversa aconteceu. É também o que destrava a fila de 1:1 do
 * Hoje sem depender da rotina mensal rodar.
 *
 * @param {Object} payload
 * @param {string} payload.pessoa_id  De quem é o 1:1.
 * @param {string} payload.texto      O que ele anotou da conversa.
 * @param {string} [payload.resumo_id] O compilado que estava na tela, para a referência.
 * @return {{id: string, titulo: string, texto: string, url: string, criouDoc: boolean,
 *           data: string, pessoa: Object}}
 * @throws ErroValidacao, ErroNaoEncontrado, ErroLock.
 */
function comentar1a1(payload) {
  const pessoaId = texto_(payload && payload.pessoa_id);
  const comentario = texto_(payload && payload.texto);

  if (!pessoaId) throw erro_(ERRO_VALIDACAO, 'comentar1a1: "pessoa_id" é obrigatório.');
  if (!comentario) throw erro_(ERRO_VALIDACAO, 'comentar1a1: "texto" é obrigatório.');

  // Ativa, e não só existente: comentário de 1:1 pressupõe alguém no time. Mesma regra do
  // createAnotacao, e por isso a mensagem de erro dele serve aqui.
  exigirPessoaAtiva_(pessoaId);

  const pessoa = pessoaPorId_(pessoaId);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const hoje = Utilities.formatDate(new Date(), tz, ISO_DATA);

  // Lock porque duas gravações concorrentes poderiam criar dois arquivos com o nome de hoje
  // — e "um Doc por compilação" viraria dois.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  let escrito;
  try {
    escrito = gravarComentarioNoDoc_(pessoa, comentario, payload && payload.resumo_id, hoje, tz);
  } finally {
    lock.releaseLock();
  }

  /*
   * O carimbo fica FORA do lock, e não é detalhe de estilo.
   *
   * `registrar1a1` toma o `getScriptLock()` por conta dele, e lock do Apps Script não é
   * confiavelmente reentrante — chamá-lo daqui de dentro faria o tryLock interno falhar
   * depois de 20 segundos e a gravação inteira virar ErroLock. É a mesma armadilha que fez
   * o processarInbox usar getUserLock em vez do de script.
   *
   * Sair do lock é seguro porque o carimbo é idempotente por natureza: regravar a mesma
   * data não faz nada. E vem DEPOIS de o Doc estar salvo — carimbar antes e falhar na
   * escrita deixaria o 1:1 marcado como feito sem registro nenhum da conversa.
   */
  registrar1a1({ pessoa_id: pessoaId, data: hoje });

  const file = DriveApp.getFileById(escrito.id);
  return {
    id: escrito.id,
    titulo: file.getName(),
    texto: DocumentApp.openById(escrito.id).getBody().getText(),
    url: file.getUrl(),
    criouDoc: escrito.criouDoc,
    data: hoje,
    pessoa: pessoa
  };
}

/** A parte que precisa do lock: achar ou criar o Doc do dia e acrescentar o parágrafo. */
function gravarComentarioNoDoc_(pessoa, comentario, resumoId, hoje, tz) {
  const pasta = pastaDaPessoa_(pessoa.nome);
  const existente = docDoDia_(pasta, hoje);
  const doc = existente || DocumentApp.create(hoje);
  const criouDoc = !existente;

  if (criouDoc) {
    // DocumentApp.create nasce na raiz do Drive; move para a pasta da pessoa.
    DriveApp.getFileById(doc.getId()).moveTo(pasta);
  }

  escreverComentario_(doc, comentario, resumoId, tz, criouDoc);
  doc.saveAndClose();

  return { id: doc.getId(), criouDoc: criouDoc };
}

/**
 * Acrescenta o comentário ao fim do corpo.
 *
 * Cada gravação vira um parágrafo com hora, sob um cabeçalho único por Doc. Uma conversa
 * produz vários pensamentos em momentos diferentes; sobrescrever perderia os anteriores, e um
 * cabeçalho por gravação encheria o Doc de títulos repetidos.
 */
function escreverComentario_(doc, comentario, resumoId, tz, criouDoc) {
  const corpo = doc.getBody();

  if (criouDoc) {
    // Doc que nasce de um comentário não tem compilado nenhum. Dizer isso evita que alguém
    // leia o arquivo daqui a um mês e procure o read que nunca existiu.
    corpo.appendParagraph('Registro de 1:1 sem compilação prévia.')
      .setHeading(DocumentApp.ParagraphHeading.NORMAL);
  }

  if (!temTitulo_(corpo)) {
    corpo.appendParagraph('').setHeading(DocumentApp.ParagraphHeading.NORMAL);
    corpo.appendParagraph(TITULO_COMENTARIOS).setHeading(DocumentApp.ParagraphHeading.HEADING3);
    if (resumoId) {
      corpo.appendParagraph('Compilado usado na conversa: ' + resumoId)
        .setHeading(DocumentApp.ParagraphHeading.NORMAL);
    }
  }

  const hora = Utilities.formatDate(new Date(), tz, 'HH:mm');
  corpo.appendParagraph(hora + ' — ' + comentario)
    .setHeading(DocumentApp.ParagraphHeading.NORMAL);
}

function temTitulo_(corpo) {
  return String(corpo.getText()).indexOf(TITULO_COMENTARIOS) >= 0;
}

/** O Doc cujo nome é a data de hoje, ou null. */
function docDoDia_(pasta, hoje) {
  const arquivos = pasta.getFiles();
  while (arquivos.hasNext()) {
    const file = arquivos.next();
    if (dataDoResumo_(file) === hoje) return DocumentApp.openById(file.getId());
  }
  return null;
}

/**
 * A subpasta da pessoa, criada se não existir.
 *
 * O nome é o da aba `Pessoas`, exatamente — é o único lugar do sistema em que nome é chave
 * (ver `chaveDeNome_`), porque a pasta é navegada por gente no Drive. Criar aqui é o que
 * permite comentar o 1:1 de quem ainda não tem compilado nenhum.
 */
function pastaDaPessoa_(nome) {
  const raiz = pastaDeResumos_();
  const alvo = chaveDeNome_(nome);

  const pastas = raiz.getFolders();
  while (pastas.hasNext()) {
    const pasta = pastas.next();
    if (chaveDeNome_(pasta.getName()) === alvo) return pasta;
  }
  return raiz.createFolder(nome);
}

function pessoaPorId_(pessoaId) {
  const achada = listPessoas().filter(function (p) { return p.id === pessoaId; })[0];
  if (!achada) {
    throw erro_(ERRO_NAO_ENCONTRADO, 'pessoa_id "' + pessoaId + '" não existe.');
  }
  return achada;
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
