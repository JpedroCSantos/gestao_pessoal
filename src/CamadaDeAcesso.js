/**
 * Camada de acesso — leitura da aba Kanban.
 *
 * Contrato: models/01-modelo-de-dados.md. Se algo aqui divergir de lá, o errado é este arquivo.
 *
 * Caminho único de escrita: front e Claude não tocam célula. Leitura e criação passam pelo
 * mesmo mapeador, dirigido por COLUNAS; updateCard entra depois, pelo mesmo caminho.
 */

/**
 * Formatos de transporte servidor→cliente.
 *
 * `google.script.run` não aceita Date atravessando a fronteira — os campos de data saem
 * daqui como string ISO e o front formata para exibir. ISO também ordena
 * lexicograficamente na ordem cronológica, que é o que a ordenação por prazo usa.
 */
const ISO_DATA = 'yyyy-MM-dd';
const ISO_DATA_HORA = "yyyy-MM-dd'T'HH:mm:ss";

/** Default de `status` quando o payload não traz. Regra da camada, não da aba. */
const STATUS_PADRAO = 'Not started';

/** Campos que a camada gera. Se vierem no payload, é bug de quem chamou — erro, não silêncio. */
const CAMPOS_GERADOS = ['id', 'criado_em', 'atualizado_em'];

/* ==========================================================================
   CONTRATO DE ERRO (02-camada-de-acesso)
   --------------------------------------------------------------------------
   A classe vai no INÍCIO DA MENSAGEM, não numa subclasse de Error: o
   google.script.run só transporta a mensagem até o cliente, então herança de
   Error não sobrevive à fronteira. Chamador discrimina por classeDoErro_.
   ========================================================================== */

const ERRO_VALIDACAO     = 'ErroValidacao';      // payload inválido
const ERRO_NAO_ENCONTRADO = 'ErroNaoEncontrado'; // updateCard com id inexistente
const ERRO_DUPLICADO     = 'ErroDuplicado';      // origem_id já presente
const ERRO_LOCK          = 'ErroLock';           // não conseguiu o lock

/** Error com a classe prefixada na mensagem. */
function erro_(classe, mensagem) {
  return new Error(classe + ': ' + mensagem);
}

/**
 * A classe de um erro, ou '' se ele não tiver uma.
 *
 * Não ancora no começo da string de propósito: o Apps Script às vezes prefixa a mensagem
 * com "Exception: " antes de entregá-la, e ancorar faria a classe sumir justamente do outro
 * lado da fronteira, que é onde ela precisa ser lida.
 */
function classeDoErro_(err) {
  const achado = /(Erro[A-Za-z]+):/.exec(mensagemDe_(err));
  return achado ? achado[1] : '';
}

function mensagemDe_(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Lê a aba inteira e devolve os cards.
 *
 * @return {{cards: Object[], ignoradas: number}} `cards` ordenados por prazo ascendente
 *     (sem prazo vai para o fim); `ignoradas` conta linhas com conteúdo mas sem `id`.
 */
function listCards() {
  const sheet = abaKanban_();

  // getMaxRows e não getLastRow — ver ultimaLinhaComId_ para o porquê. Linha em branco é
  // descartada abaixo, então varrer a grade inteira só torna esta chamada um pouco maior.
  const totalLinhas = sheet.getMaxRows() - 1;
  if (totalLinhas < 1) return { cards: [], ignoradas: 0 };

  // Uma leitura só para a aba inteira — nada de célula a célula.
  const linhas = sheet.getRange(2, 1, totalLinhas, COLUNAS.length).getValues();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  const cards = [];
  let ignoradas = 0;

  linhas.forEach(function (linha) {
    const card = linhaParaObjeto_(linha, COLUNAS, tz);
    if (card.id) {
      cards.push(card);
      return;
    }
    // Sem `id` não há PK: nenhuma operação futura consegue endereçar esse card. Linha em
    // branco é só grade sobrando e passa calada; linha COM conteúdo e sem id é lixo, e o
    // front avisa.
    if (!cardVazio_(card)) ignoradas++;
  });

  cards.sort(compararPorPrazo_);

  if (ignoradas > 0) {
    Logger.log('listCards: %s linha(s) com conteúdo e sem id foram ignoradas.', ignoradas);
  }
  return { cards: cards, ignoradas: ignoradas };
}

/**
 * Cria um card e devolve o que foi gravado.
 *
 * @param {Object} payload Campos do card, no formato de transporte (datas em yyyy-MM-dd).
 *     `titulo` é obrigatório. `id`, `criado_em` e `atualizado_em` não podem vir — são
 *     gerados aqui. Campo fora de COLUNAS é erro. `origem_id` só a ingestão manda.
 * @return {Object} O card criado, com `id`, no mesmo formato que o listCards devolve.
 * @throws ErroValidacao, ErroDuplicado (origem_id já presente), ErroLock.
 */
function createCard(payload) {
  const card = validarPayload_(payload);

  // Nascer já `Delegado` é uma transição como qualquer outra. Sem isto, card criado por voz
  // direto em Delegado nunca teria `data_delegacao`, e o lembrete de conferência de 7 dias
  // não dispararia para ele — que é o buraco que o histórico do Notion já mostra (1 dos 4).
  const regra = regraDeCarimbo_(card.status, '', payload);
  if (regra && (regra.sobrescreve || !card[regra.campo])) {
    card[regra.campo] = hojeMeiaNoite_();
  }

  // Um usuário só, mas duplo clique com latência ou duas abas abertas geram dois appends
  // concorrentes — e appendRow não é atômico. O lock é a defesa do lado do servidor.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  try {
    return inserirComDedupe_(abaKanban_(), COLUNAS, card, 'card');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Cria uma anotação de feedback e devolve o que foi gravado.
 *
 * @param {Object} payload Campos no formato de transporte, já traduzidos do envelope —
 *     `pessoa_id` resolvido e os quatro `valor_*` como booleanos. `nota`, `pessoa_id` e
 *     `tipo` são obrigatórios; `data` cai para hoje se ausente.
 * @return {Object} A anotação criada, com `id`.
 * @throws ErroValidacao, ErroDuplicado, ErroLock.
 */
function createAnotacao(payload) {
  const anotacao = validarPayloadAnotacao_(payload);

  // FK conferida antes do lock: é leitura, e segurar o lock durante ela não protege nada.
  exigirPessoaAtiva_(anotacao.pessoa_id);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  try {
    return inserirComDedupe_(abaAnotacoes_(), COLUNAS_ANOTACOES, anotacao, 'anotação');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Miolo comum dos creates: deduplica, gera id, carimba e grava.
 *
 * `createPessoa` passa por aqui sem `origem_id` no objeto, e a dedupe se pula sozinha — a
 * aba Pessoas não tem essa coluna, e não precisa: ela não é alimentada pelo inbox.
 *
 * **Precisa ser chamado com o lock já tomado.** A dedupe roda DENTRO do lock, nunca antes:
 * checar fora reabre exatamente a corrida que o lock existe para fechar — duas execuções
 * passam pela checagem e as duas inserem.
 *
 * @param {string} rotulo Como chamar o registro na mensagem de duplicata ("card", "anotação").
 */
function inserirComDedupe_(sheet, colunas, obj, rotulo) {
  if (obj.origem_id) {
    const jaExiste = linhaDeOrigemId_(sheet, colunas, obj.origem_id);
    if (jaExiste) {
      const idExistente = String(
        sheet.getRange(jaExiste, colunaDe_(colunas, 'id')).getValue()
      ).trim();

      const duplicado = erro_(
        ERRO_DUPLICADO,
        'origem_id "' + obj.origem_id + '" já entrou como ' + rotulo + ' ' + idExistente + '.'
      );
      // A ingestão registra esse id no Log. Vai como propriedade, e não extraído da
      // mensagem, porque parsear texto de erro é frágil. Não atravessa o google.script.run,
      // e não precisa: quem lê é o processarInbox, na mesma execução.
      duplicado.registroExistente = idExistente;
      throw duplicado;
    }
  }

  const agora = new Date();
  obj.id = Utilities.getUuid();
  obj.criado_em = agora;
  obj.atualizado_em = agora;

  // Nada de appendRow: ele posiciona por getLastRow(), que nestas abas aponta para o fim da
  // grade e faria a linha cair lá embaixo. A posição vem da coluna `id`.
  const linha = objetoParaLinha_(obj, colunas);
  const destino = ultimaLinhaPreenchida_(sheet, colunaDe_(colunas, 'id')) + 1;
  if (destino > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 1);  // herda formato e validação da anterior
  }
  sheet.getRange(destino, 1, 1, colunas.length).setValues([linha]);
  SpreadsheetApp.flush();

  // Volta pelo mesmo mapeador da leitura: o que o chamador recebe é exatamente o formato
  // que a leitura devolve, sem reler a planilha e sem um segundo caminho de serialização.
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return linhaParaObjeto_(linha, colunas, tz);
}

/**
 * Aborta se o `pessoa_id` não existir na aba Pessoas, ou existir desmarcado em `ativo`.
 *
 * A resolução nome→id acontece na skill, fora deste repositório, contra uma lista que pode
 * envelhecer. Sem esta checagem, uma skill desatualizada grava anotação apontando para
 * ninguém: não aparece em 1:1 nenhum, não dá erro, e só é descoberta quando alguém reclama
 * que o feedback sumiu. É a "FK órfã" que a reconciliação do `03` exige que seja zero.
 *
 * **Inativo recusa, em vez de gravar e sumir da tela.** As telas de Anotações e Resumos
 * escondem quem saiu do time; uma anotação escrita para essa pessoa entraria na aba e não
 * apareceria em lugar nenhum. É o mesmo raciocínio do `05` para pessoa não cadastrada:
 * melhor o erro visível em `erros/` que o registro invisível. O caminho de volta é
 * remarcar a caixa e reescrever.
 *
 * @throws ErroValidacao
 */
function exigirPessoaAtiva_(pessoaId) {
  const sheet = abaPorNome_(PESSOAS_TAB_NAME, 'setupPessoas');
  const numeroDaLinha = linhaComValor_(sheet, colunaDe_(COLUNAS_PESSOAS, 'id'), pessoaId);

  if (!numeroDaLinha) {
    throw erro_(
      ERRO_VALIDACAO,
      'pessoa_id "' + pessoaId + '" não existe na aba ' + PESSOAS_TAB_NAME + '. ' +
      'Se veio de uma skill, a lista de pessoas dela pode estar desatualizada.'
    );
  }

  if (!pessoaAtivaNaLinha_(sheet, numeroDaLinha)) {
    throw erro_(
      ERRO_VALIDACAO,
      'pessoa_id "' + pessoaId + '" está inativo na aba ' + PESSOAS_TAB_NAME + '. ' +
      'Registro para quem saiu do time não apareceria em tela nenhuma. Se a pessoa voltou, ' +
      'reative-a na tela Pessoas do app — é o updatePessoa, que carimba o atualizado_em ' +
      'junto. Marcar a caixa à mão na aba também funciona, e não carimba.'
    );
  }
}

/**
 * A caixa `ativo` daquela linha está marcada?
 *
 * `=== true` porque o setup usa `requireCheckbox()`: célula nunca tocada volta `''`, e o
 * mapeador de leitura trata do mesmo jeito. Consequência prática — a coluna recém-criada
 * deixa todo mundo inativo até as caixas serem marcadas à mão. Ver `01`.
 */
function pessoaAtivaNaLinha_(sheet, numeroDaLinha) {
  return sheet.getRange(numeroDaLinha, colunaDe_(COLUNAS_PESSOAS, 'ativo')).getValue() === true;
}

/**
 * Aplica um patch parcial a um card existente.
 *
 * Convenção de patch: campo **presente** no objeto é aplicado, mesmo vazio — `{prazo: ''}`
 * limpa o prazo. Campo **ausente** preserva o que já está na célula.
 *
 * `id` e `criado_em` saem da linha lida, nunca do patch. `atualizado_em` é recarimbado em
 * toda chamada, mesmo que nada tenha mudado de valor.
 *
 * @param {string} id    O `id` do card. Nunca o título.
 * @param {Object} patch Campos a alterar, no formato de transporte.
 * @return {Object} O card já atualizado, no mesmo formato do listCards.
 * @throws ErroValidacao, ErroNaoEncontrado, ErroLock.
 */
function updateCard(id, patch) {
  const alvo = texto_(id);
  if (!alvo) throw erro_(ERRO_VALIDACAO, 'updateCard: "id" é obrigatório.');
  if (!patch || typeof patch !== 'object') {
    throw erro_(ERRO_VALIDACAO, 'updateCard: patch ausente ou não é um objeto.');
  }
  validarChaves_(COLUNAS, patch, 'updateCard');

  // Read-modify-write precisa do lock ainda mais que o append: sem ele, duas edições
  // simultâneas fazem a segunda sobrescrever a primeira com a linha que leu antes.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  try {
    const sheet = abaKanban_();
    const numeroDaLinha = linhaDoId_(sheet, alvo);
    if (!numeroDaLinha) {
      throw erro_(
        ERRO_NAO_ENCONTRADO,
        'nenhum card com id "' + alvo + '". Nada foi alterado — ' +
        'update não cria card silenciosamente.'
      );
    }

    const linha = sheet.getRange(numeroDaLinha, 1, 1, COLUNAS.length).getValues()[0];
    const statusAnterior = texto_(linha[colunaDe_(COLUNAS, 'status') - 1]);

    COLUNAS.forEach(function (c, i) {
      if (!(c.campo in patch)) return;   // ausente preserva; presente aplica, mesmo vazio
      linha[i] = normalizarEntrada_(COLUNAS, c.campo, patch[c.campo]);
    });

    const regra = regraDeCarimbo_(texto_(linha[colunaDe_(COLUNAS, 'status') - 1]), statusAnterior, patch);
    if (regra) {
      const iCarimbo = colunaDe_(COLUNAS, regra.campo) - 1;
      if (regra.sobrescreve || !(linha[iCarimbo] instanceof Date)) {
        linha[iCarimbo] = hojeMeiaNoite_();
      }
    }

    linha[colunaDe_(COLUNAS, 'atualizado_em') - 1] = new Date();

    if (!texto_(linha[colunaDe_(COLUNAS, 'titulo') - 1])) {
      throw erro_(ERRO_VALIDACAO, 'updateCard: "titulo" não pode ficar vazio.');
    }

    sheet.getRange(numeroDaLinha, 1, 1, COLUNAS.length).setValues([linha]);
    SpreadsheetApp.flush();

    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return linhaParaObjeto_(linha, COLUNAS, tz);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Status de destino → a data que entrar nele carimba.
 *
 * As três colunas vieram cheias da migração e nada as alimentava daqui para frente. Isso
 * importa porque o `o-que-tenho-hoje` usa `data_delegacao` para lembrar de conferir delegado
 * parado há uma semana — regra que, sem carimbo, nunca dispararia num card novo.
 *
 * **`sobrescreve` é assimétrico de propósito**, porque as três respondem perguntas diferentes:
 *
 *   `data_inicio`     — "desde quando isto está comigo". Card que volta para In progress
 *                       depois de um desvio continua sendo o mesmo trabalho antigo, e
 *                       reiniciar a contagem apagaria justamente o "carrego há semanas" que o
 *                       `resumo-semanal` procura. Só carimba se estiver vazia.
 *   `data_conclusao`  — "quando fechou". Reabriu e fechou de novo, a data boa é a última.
 *   `data_delegacao`  — "há quanto tempo está com a outra pessoa". O relógio da conferência
 *                       é o da delegação atual, então toda entrada em Delegado reinicia.
 *
 * O que isto **não** faz: limpar a data quando o card sai do status. Card reaberto mantém a
 * `data_conclusao` antiga até fechar de novo. Preferimos o resíduo visível ao apagamento
 * automático — quem lê a coluna cruza com `status`, e limpar sozinho perderia histórico.
 */
const CARIMBO_DE_STATUS = {
  'In progress': { campo: 'data_inicio',    sobrescreve: false },
  'Done':        { campo: 'data_conclusao', sobrescreve: true  },
  'Delegado':    { campo: 'data_delegacao', sobrescreve: true  },
};

/**
 * A regra de carimbo desta mudança de status, ou null quando não há o que carimbar.
 *
 * @param {string} destino   status depois da mudança
 * @param {string} anterior  status antes — '' na criação, que conta como transição
 * @param {Object} explicitos campos que o chamador mandou. Data presente aí manda: quem
 *     edita a data à mão no front está corrigindo o carimbo, não pedindo outro por cima.
 */
function regraDeCarimbo_(destino, anterior, explicitos) {
  if (destino === anterior) return null;

  const regra = CARIMBO_DE_STATUS[destino];
  if (!regra) return null;
  if (explicitos && regra.campo in explicitos) return null;

  return regra;
}

/** Hoje à meia-noite local. Coluna `data` guarda dia, não instante. */
function hojeMeiaNoite_() {
  const agora = new Date();
  return new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
}

/**
 * Carimba `data_ultimo_1a1` de uma pessoa.
 *
 * Existe porque a rotina mensal de 1:1 precisa marcar quem já foi feito no ciclo, e o
 * conector do Drive lê a planilha mas **não escreve nela** — toda escrita vinda de skill
 * entra pelo inbox. É estreita de propósito: não é o `updatePessoa`, que entra junto com o
 * front e mexe em nome e nível. Aqui só a data muda.
 *
 * **Não deduplica por `origem_id`,** e é a única entrada do inbox assim. Pessoas não tem essa
 * coluna, e não precisa: regravar a mesma data é inofensivo por natureza, ao contrário de
 * inserir a mesma linha duas vezes.
 *
 * @param {Object} payload `pessoa_id` obrigatório; `data` em yyyy-MM-dd, hoje se ausente.
 * @return {Object} A pessoa já atualizada, no formato de transporte.
 * @throws ErroValidacao, ErroNaoEncontrado, ErroLock.
 */
function registrar1a1(payload) {
  if (!payload || typeof payload !== 'object') {
    throw erro_(ERRO_VALIDACAO, 'registrar1a1: payload ausente ou não é um objeto.');
  }

  const pessoaId = texto_(payload.pessoa_id);
  if (!pessoaId) throw erro_(ERRO_VALIDACAO, 'registrar1a1: "pessoa_id" é obrigatório.');

  const data = texto_(payload.data)
    ? normalizarEntrada_(COLUNAS_PESSOAS, 'data_ultimo_1a1', payload.data)
    : hojeMeiaNoite_();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  try {
    const sheet = abaPorNome_(PESSOAS_TAB_NAME, 'setupPessoas');
    const numeroDaLinha = linhaComValor_(sheet, colunaDe_(COLUNAS_PESSOAS, 'id'), pessoaId);
    if (!numeroDaLinha) {
      throw erro_(
        ERRO_NAO_ENCONTRADO,
        'nenhuma pessoa com id "' + pessoaId + '". Se veio de uma skill, a lista de pessoas ' +
        'dela pode estar desatualizada — regere o references/pessoas.md.'
      );
    }

    // A rotina mensal compila "cada pessoa da aba"; quem saiu do time não entra no ciclo.
    // A skill filtra, e esta é a rede — carimbar aqui produziria uma data que a tela de
    // 1:1 nunca mostra, porque ela só lista ativos.
    if (!pessoaAtivaNaLinha_(sheet, numeroDaLinha)) {
      throw erro_(
        ERRO_VALIDACAO,
        'pessoa_id "' + pessoaId + '" está inativo na aba ' + PESSOAS_TAB_NAME + '. ' +
        'A rotina de 1:1 não deveria tê-lo incluído no ciclo.'
      );
    }

    const linha = sheet.getRange(numeroDaLinha, 1, 1, COLUNAS_PESSOAS.length).getValues()[0];
    linha[colunaDe_(COLUNAS_PESSOAS, 'data_ultimo_1a1') - 1] = data;
    linha[colunaDe_(COLUNAS_PESSOAS, 'atualizado_em') - 1] = new Date();

    sheet.getRange(numeroDaLinha, 1, 1, COLUNAS_PESSOAS.length).setValues([linha]);
    SpreadsheetApp.flush();

    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return linhaParaObjeto_(linha, COLUNAS_PESSOAS, tz);
  } finally {
    lock.releaseLock();
  }
}

/** Linha em que mora o card com esse `id`, ou 0 se não existir. */
function linhaDoId_(sheet, id) {
  return linhaComValor_(sheet, colunaDe_(COLUNAS, 'id'), id);
}

/**
 * Linha que já tem esse `origem_id`, ou 0. Chave de deduplicação da ingestão: é o que faz
 * reprocessar o inbox ser inofensivo por construção, e não por sorte.
 */
function linhaDeOrigemId_(sheet, colunas, origemId) {
  return linhaComValor_(sheet, colunaDe_(colunas, 'origem_id'), origemId);
}

/** Primeira linha do corpo cuja `coluna` tem exatamente esse valor, ou 0. */
function linhaComValor_(sheet, coluna, valor) {
  const corpo = sheet.getMaxRows() - 1;
  if (corpo < 1) return 0;

  const valores = sheet.getRange(2, coluna, corpo, 1).getValues();
  for (let i = 0; i < valores.length; i++) {
    if (String(valores[i][0]).trim() === valor) return i + 2;
  }
  return 0;
}

/**
 * Última linha com a coluna âncora preenchida, ou 1 (só o cabeçalho) se não houver nenhuma.
 *
 * Existe porque **`getLastRow()` não é confiável nestas abas**. O setup aplica validação e
 * formato no corpo inteiro para que a linha nova já nasça configurada, e o efeito colateral
 * é o Sheets passar a contar as linhas em branco como conteúdo: `getLastRow()` devolve o fim
 * da grade e o `appendRow` escreve depois dele.
 *
 * A âncora tem que ser uma coluna que só a camada escreve — `id` no Kanban, `quando` no Log.
 */
function ultimaLinhaPreenchida_(sheet, coluna) {
  const corpo = sheet.getMaxRows() - 1;
  if (corpo < 1) return 1;

  const valores = sheet.getRange(2, coluna, corpo, 1).getValues();
  for (let i = valores.length - 1; i >= 0; i--) {
    if (String(valores[i][0]).trim() !== '') return i + 2;  // +2: a varredura começa na linha 2
  }
  return 1;
}

function ultimaLinhaComId_(sheet) {
  return ultimaLinhaPreenchida_(sheet, colunaDe_(COLUNAS, 'id'));
}

/**
 * Lê a aba `Pessoas` inteira, ordenada por nome — **inclusive quem está inativo**.
 *
 * É o que alimenta o seletor de `delegado_para` no front e o resolvedor de id→nome dos
 * tiles. Sem escrita nesta fase: a aba só muda por migração ou à mão.
 *
 * **Não filtra por `ativo`, de propósito.** Esta é a tabela de tradução id→nome do sistema
 * inteiro, e ela precisa ser completa: card delegado a quem saiu mostraria o uuid, as
 * anotações antigas dele perderiam o nome, e a pasta de resumos dele viraria "órfã". Quem
 * esconde inativo é cada visão do front, que sabe se está mostrando atenção (esconde) ou
 * histórico (mostra). Ver `04`.
 *
 * @return {Object[]} pessoas no formato de transporte, linhas sem `id` descartadas.
 */
function listPessoas() {
  return lerAba_(PESSOAS_TAB_NAME, 'setupPessoas', COLUNAS_PESSOAS)
    .sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
}

/* ==========================================================================
   PESSOAS — escrita
   --------------------------------------------------------------------------
   Duas funções estreitas, e a estreiteza é o desenho. `createPessoa` cadastra
   alguém; `updatePessoa` corrige nome e nível e liga e desliga o `ativo`.

   Até aqui a aba `Pessoas` só mudava por migração ou à mão, e digitar a linha
   direto tem três armadilhas que estas funções fecham de uma vez: `id` tem que
   ser UUID porque é o alvo de todas as FKs, `ativo` em branco lê como `false` e
   faz a pessoa nascer invisível, e `nivel` fora da lista passa se for colado.

   DUAS COLUNAS FICAM DE FORA, e nenhuma por esquecimento:

   `notion_id` — é o endereço do rollback. **Vazio significa "nasceu aqui"**, e é
       o que faz o delta da migração se identificar sozinho, sem depender de data
       nem de título (DEPLOY.md §4). Deixar o front escrevê-lo apagaria a única
       coisa que distingue as duas origens.

   `data_ultimo_1a1` — é do `registrar1a1`, que existe porque o conector do Drive
       lê a planilha e não escreve nela. Uma segunda porta para a mesma coluna é
       exatamente o começo do problema que o §2.1 descreve, e aqui seria pior: a
       fila de 1:1 do Hoje lê essa data, e um valor digitado no formulário
       silenciaria a fila sem que a conversa tivesse acontecido.
   ========================================================================== */

/** O que o cadastro aceita. `ativo` não entra: ver o `createPessoa`. */
const CAMPOS_PESSOA_NO_CADASTRO = ['nome', 'nivel'];

/** O que a edição aceita. É o cadastro mais o `ativo`, que é o motivo de ela existir. */
const CAMPOS_PESSOA_EDITAVEIS = ['nome', 'nivel', 'ativo'];

/**
 * Cadastra alguém no time.
 *
 * **Nasce sempre `ativo`, e o payload não pode dizer o contrário.** Cadastrar alguém
 * inativo é cadastrar uma linha que não aparece em tela nenhuma — e, pior, é o estado em
 * que a pessoa cai por acidente quando a caixa fica desmarcada na digitação à mão. Quem
 * desativa é o `updatePessoa`, que é uma decisão própria e não um default.
 *
 * **Não deduplica por `origem_id`** — `Pessoas` não tem essa coluna, e não precisa ter: a
 * única porta de entrada é o front, porque `TIPOS_ACEITOS` da ingestão não inclui pessoa.
 * Quem protege do duplo clique é a recusa de nome repetido, tomada dentro do mesmo lock.
 *
 * @param {Object} payload `nome` obrigatório; `nivel` opcional, validado contra NIVEL_OPCOES.
 * @return {Object} A pessoa criada, com `id`, no formato de transporte.
 * @throws ErroValidacao, ErroLock.
 */
function createPessoa(payload) {
  if (!payload || typeof payload !== 'object') {
    throw erro_(ERRO_VALIDACAO, 'createPessoa: payload ausente ou não é um objeto.');
  }
  validarChavesDePessoa_(payload, CAMPOS_PESSOA_NO_CADASTRO, 'createPessoa');

  const nome = texto_(payload.nome);
  if (!nome) throw erro_(ERRO_VALIDACAO, 'createPessoa: "nome" é obrigatório.');

  const nivel = normalizarEntrada_(COLUNAS_PESSOAS, 'nivel', payload.nivel);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  try {
    const sheet = abaPessoas_();

    // DENTRO do lock, como a dedupe do inserirComDedupe_ e pelo mesmo motivo: checar fora
    // deixa duas execuções passarem pela checagem e inserirem as duas.
    exigirNomeLivre_(sheet, nome, '');

    // `id`, `criado_em` e `atualizado_em` são preenchidos lá dentro. Sem `origem_id` no
    // objeto, a dedupe é pulada sozinha — e é o mesmo caminho de escrita dos outros dois
    // creates, incluindo o posicionamento que não usa getLastRow (§2.2).
    return inserirComDedupe_(sheet, COLUNAS_PESSOAS, {
      notion_id: '',          // nasceu aqui — ver o cabeçalho desta seção
      nome: nome,
      nivel: nivel,
      data_ultimo_1a1: '',    // ninguém tem 1:1 antes de entrar
      ativo: true,
    }, 'pessoa');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Corrige nome e nível, e liga ou desliga o `ativo`.
 *
 * **Desativar não apaga nem esconde nada**, e é o que faz esta função ser segura: o
 * `listPessoas` continua devolvendo quem saiu, porque ele é a tabela de tradução id→nome do
 * sistema inteiro. O que muda é que a camada passa a recusar anotação e carimbo de 1:1 para
 * essa pessoa, e as telas de atenção param de oferecê-la. Card ainda delegado a ela continua
 * aparecendo com o nome dela — que é justamente o card que precisa de outro dono. Ver `04`.
 *
 * Por isso também **não há delete**: remover a linha transformaria em uuid cru toda anotação
 * e todo card que apontam para ela. Sair do time é um estado, não um sumiço.
 *
 * @param {string} id
 * @param {Object} patch Só `nome`, `nivel` e `ativo`. Ausente preserva; presente aplica.
 * @return {Object} A pessoa já atualizada.
 * @throws ErroValidacao, ErroNaoEncontrado, ErroLock.
 */
function updatePessoa(id, patch) {
  const alvo = texto_(id);
  if (!alvo) throw erro_(ERRO_VALIDACAO, 'updatePessoa: "id" é obrigatório.');
  if (!patch || typeof patch !== 'object') {
    throw erro_(ERRO_VALIDACAO, 'updatePessoa: patch ausente ou não é um objeto.');
  }
  validarChavesDePessoa_(patch, CAMPOS_PESSOA_EDITAVEIS, 'updatePessoa');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  try {
    const sheet = abaPessoas_();
    const numeroDaLinha = linhaComValor_(sheet, colunaDe_(COLUNAS_PESSOAS, 'id'), alvo);
    if (!numeroDaLinha) {
      throw erro_(
        ERRO_NAO_ENCONTRADO,
        'nenhuma pessoa com id "' + alvo + '". Nada foi alterado — ' +
        'update não cadastra ninguém silenciosamente.'
      );
    }

    // Lê, muta e regrava a linha inteira: mesmo padrão do updateCard e do arquivarNota.
    const linha = sheet.getRange(numeroDaLinha, 1, 1, COLUNAS_PESSOAS.length).getValues()[0];

    CAMPOS_PESSOA_EDITAVEIS.forEach(function (campo) {
      if (!(campo in patch)) return;   // ausente preserva; presente aplica, mesmo vazio
      linha[colunaDe_(COLUNAS_PESSOAS, campo) - 1] =
        normalizarEntrada_(COLUNAS_PESSOAS, campo, patch[campo]);
    });

    const nome = texto_(linha[colunaDe_(COLUNAS_PESSOAS, 'nome') - 1]);
    if (!nome) throw erro_(ERRO_VALIDACAO, 'updatePessoa: "nome" não pode ficar vazio.');

    // Só quando ela TERMINA ativa. Dois inativos homônimos são inofensivos — a referência
    // das skills lista apenas ativos, e é lá que o nome ambíguo faz a captura errar.
    // Conferir sempre impediria reativar alguém cujo homônimo entrou no meio tempo sem
    // dizer o que fazer a respeito; conferindo aqui, a recusa vem no momento certo.
    if (linha[colunaDe_(COLUNAS_PESSOAS, 'ativo') - 1] === true) {
      exigirNomeLivre_(sheet, nome, alvo);
    }

    linha[colunaDe_(COLUNAS_PESSOAS, 'atualizado_em') - 1] = new Date();

    sheet.getRange(numeroDaLinha, 1, 1, COLUNAS_PESSOAS.length).setValues([linha]);
    SpreadsheetApp.flush();

    return linhaParaObjeto_(
      linha, COLUNAS_PESSOAS,
      SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()
    );
  } finally {
    lock.releaseLock();
  }
}

/**
 * Rejeita chave fora da lista aceita por aquela operação.
 *
 * Não reusa o `validarChaves_` porque a regra é outra: lá o critério é "tudo do schema que
 * a camada não gera", e aqui `notion_id` e `data_ultimo_1a1` passariam — são editáveis pelo
 * schema e proibidos por decisão. A lista explícita é o que torna a decisão legível.
 */
function validarChavesDePessoa_(obj, aceitos, contexto) {
  Object.keys(obj).forEach(function (chave) {
    if (aceitos.indexOf(chave) >= 0) return;

    if (chave === 'notion_id') {
      throw erro_(
        ERRO_VALIDACAO,
        contexto + ': "notion_id" não é editável. Vazio significa "nasceu aqui", e é como o ' +
        'rollback da migração identifica o que precisa voltar.'
      );
    }
    if (chave === 'data_ultimo_1a1') {
      throw erro_(
        ERRO_VALIDACAO,
        contexto + ': "data_ultimo_1a1" é carimbada pelo registrar1a1, quando a conversa ' +
        'acontece. Editá-la aqui silenciaria a fila de 1:1 sem que ela tivesse acontecido.'
      );
    }
    if (CAMPOS_GERADOS.indexOf(chave) >= 0) {
      throw erro_(
        ERRO_VALIDACAO,
        contexto + ': "' + chave + '" é gerado pela camada e não pode ser enviado.'
      );
    }
    if (chave === 'ativo') {
      throw erro_(
        ERRO_VALIDACAO,
        contexto + ': quem entra no time entra ativo. Para desativar alguém, use o ' +
        'updatePessoa — é uma decisão, não um default de formulário.'
      );
    }
    throw erro_(
      ERRO_VALIDACAO,
      contexto + ': campo desconhecido "' + chave + '". Aceitos: ' + aceitos.join(', ') + '.'
    );
  });
}

/**
 * Recusa nome que já está em uso por OUTRA pessoa ativa.
 *
 * Nome não é chave em lugar nenhum do schema — as FKs são todas por id. Mas ele **é** chave
 * na captura por voz: a skill ouve "a Ana mandou bem no deploy" e resolve "Ana" para um id
 * pela tabela que o `gerarReferenciaDePessoas()` imprime, e essa tabela lista só os ativos.
 * Duas Anas ativas fazem a captura escolher uma em silêncio, e a anotação vai para a pessoa
 * errada sem erro nenhum aparecer. É o tipo de falha que só se descobre num 1:1.
 *
 * Inativo não conta, por isso mesmo: ele não entra na referência.
 *
 * @param {string} idQuePodeRepetir O id da própria pessoa, num update. '' na criação.
 */
function exigirNomeLivre_(sheet, nome, idQuePodeRepetir) {
  const colId = colunaDe_(COLUNAS_PESSOAS, 'id');
  const ultima = ultimaLinhaPreenchida_(sheet, colId);
  if (ultima < 2) return;

  const linhas = sheet.getRange(2, 1, ultima - 1, COLUNAS_PESSOAS.length).getValues();
  const procurado = nome.toLowerCase();

  for (let i = 0; i < linhas.length; i++) {
    if (linhas[i][colunaDe_(COLUNAS_PESSOAS, 'ativo') - 1] !== true) continue;
    if (texto_(linhas[i][colId - 1]) === idQuePodeRepetir) continue;
    if (texto_(linhas[i][colunaDe_(COLUNAS_PESSOAS, 'nome') - 1]).toLowerCase() !== procurado) {
      continue;
    }

    throw erro_(
      ERRO_VALIDACAO,
      'já existe alguém ativo chamado "' + nome + '". As skills resolvem nome → id pela ' +
      'lista de ativos, e dois iguais fariam a captura por voz escolher em silêncio. ' +
      'Use o sobrenome para distinguir, ou desative quem já saiu.'
    );
  }
}

/**
 * Lê a aba `Anotações` inteira, da mais recente para a mais antiga.
 *
 * Devolve o schema cru, sem juntar o nome da pessoa: quem resolve `pessoa_id` → nome é o
 * front, que já carrega `listPessoas` para o seletor de delegados. Juntar aqui criaria um
 * segundo caminho de tradução para sair de sincronia com o `nomesDeIds` dos tiles.
 *
 * Nasceu privada na Fase 3 — o front não mostrava anotação. Virou pública quando o board
 * ganhou a visão delas.
 *
 * @return {Object[]} anotações no formato de transporte, mais recentes primeiro.
 */
function listAnotacoes() {
  return lerAnotacoes_().sort(function (a, b) {
    // Sem data vai para o fim: é linha incompleta, não a mais antiga do mundo.
    if (!a.data) return b.data ? 1 : 0;
    if (!b.data) return -1;
    return b.data.localeCompare(a.data);   // ISO ordena como texto
  });
}

/** As anotações da aba, na ordem em que estão. Quem usa é a reconciliação e o listAnotacoes. */
function lerAnotacoes_() {
  return lerAba_(ANOTACOES_TAB_NAME, 'setupAnotacoes', COLUNAS_ANOTACOES);
}

/* ==========================================================================
   NOTAS — o recado solto
   --------------------------------------------------------------------------
   Aba separada de Anotações de propósito: ver o comentário de COLUNAS_NOTAS.
   Aqui não há `tipo` nem `valor_*` porque não há juízo — e é justamente por
   isso que "Gustavo comentou que estava cansado" cabe aqui e não lá.

   As duas FKs são opcionais e independentes. `pessoa_id` exige apenas que a
   pessoa EXISTA, e não que esteja ativa: nota sobre quem acabou de sair do time
   é legítima ("X pediu demissão") e não vai para fila de 1:1 nenhuma. É a
   diferença deliberada em relação ao createAnotacao, que exige pessoa ativa.
   ========================================================================== */

/**
 * As notas, mais recentes primeiro.
 *
 * Devolve **tudo**, arquivadas incluídas, com a flag: quem recorta é a tela. Filtrar aqui
 * tornaria a nota arquivada inalcançável pelo front sem uma segunda função.
 *
 * @return {Object[]} notas no formato de transporte.
 */
function listNotas() {
  /*
   * Três critérios, e o terceiro é o que sempre resolve.
   *
   * Empate de `data` é o caso comum — várias notas do mesmo dia. `criado_em` desempata na
   * maioria, mas ele atravessa com precisão de SEGUNDO (`ISO_DATA_HORA`), e duas notas
   * escritas no mesmo segundo empatam de novo. Então o último critério é a posição na aba:
   * a inserção é sempre append, logo ordem de linha **é** ordem de escrita, e essa nunca
   * empata. Invertida, porque a tela quer a mais nova primeiro.
   */
  return lerAba_(NOTAS_TAB_NAME, 'setupNotas', COLUNAS_NOTAS)
    .map(function (nota, i) { return { nota: nota, linha: i }; })
    .sort(function (a, b) {
      const porData = String(b.nota.data || '').localeCompare(String(a.nota.data || ''));
      if (porData !== 0) return porData;

      const porCriacao = String(b.nota.criado_em || '').localeCompare(String(a.nota.criado_em || ''));
      if (porCriacao !== 0) return porCriacao;

      return b.linha - a.linha;
    })
    .map(function (item) { return item.nota; });
}

/**
 * Cria uma nota.
 *
 * @param {Object} payload `texto` obrigatório. `pessoa_id`, `card_id`, `data` opcionais.
 *     `data` ausente cai para hoje. Campos gerados não podem vir.
 * @return {Object} A nota criada, com `id`.
 * @throws ErroValidacao, ErroNaoEncontrado, ErroDuplicado, ErroLock.
 */
function createNota(payload) {
  const nota = validarPayloadDeNota_(payload);

  // FKs conferidas antes do lock: é leitura, e segurá-lo durante ela não protege nada.
  if (nota.pessoa_id) exigirPessoaExistente_(nota.pessoa_id);
  if (nota.card_id) exigirCardExistente_(nota.card_id);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  try {
    return inserirComDedupe_(abaNotas_(), COLUNAS_NOTAS, nota, 'nota');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Arquiva ou desarquiva uma nota.
 *
 * Estreito de propósito, como o `registrar1a1`: não é um `updateNota` que mexe no texto.
 * Nota é registro de um momento, e reescrever o passado é outra decisão — se o texto estiver
 * errado, arquiva e escreve outra.
 *
 * @param {string} id
 * @param {boolean} arquivada
 * @return {Object} A nota já atualizada.
 * @throws ErroValidacao, ErroNaoEncontrado, ErroLock.
 */
function arquivarNota(id, arquivada) {
  const alvo = texto_(id);
  if (!alvo) throw erro_(ERRO_VALIDACAO, 'arquivarNota: "id" é obrigatório.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento. Tente de novo em alguns segundos.');
  }

  try {
    const sheet = abaNotas_();
    const linha = linhaComValor_(sheet, colunaDe_(COLUNAS_NOTAS, 'id'), alvo);
    if (!linha) {
      throw erro_(ERRO_NAO_ENCONTRADO, 'nota "' + alvo + '" não existe na aba ' + NOTAS_TAB_NAME + '.');
    }

    // Lê a linha, muta e regrava inteira — o mesmo padrão do updateCard. Duas escritas de
    // célula seriam duas chamadas de API, e `arquivada` e `atualizado_em` não são vizinhas.
    const valores = sheet.getRange(linha, 1, 1, COLUNAS_NOTAS.length).getValues()[0];
    valores[colunaDe_(COLUNAS_NOTAS, 'arquivada') - 1] = arquivada === true;
    valores[colunaDe_(COLUNAS_NOTAS, 'atualizado_em') - 1] = new Date();

    sheet.getRange(linha, 1, 1, COLUNAS_NOTAS.length).setValues([valores]);
    SpreadsheetApp.flush();

    return linhaParaObjeto_(
      valores, COLUNAS_NOTAS,
      SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()
    );
  } finally {
    lock.releaseLock();
  }
}

function validarPayloadDeNota_(payload) {
  const nota = normalizarPayload_(COLUNAS_NOTAS, payload, 'createNota');

  if (!nota.texto) throw erro_(ERRO_VALIDACAO, 'createNota: "texto" é obrigatório.');
  if (!nota.data) nota.data = hojeMeiaNoite_();

  return nota;
}

/**
 * A pessoa existe? — sem exigir que esteja ativa.
 *
 * Separado do `exigirPessoaAtiva_` porque a regra é outra: feedback para quem saiu do time
 * não apareceria em tela nenhuma, mas nota sobre quem saiu é informação legítima.
 */
function exigirPessoaExistente_(pessoaId) {
  const sheet = abaPorNome_(PESSOAS_TAB_NAME, 'setupPessoas');
  if (!linhaComValor_(sheet, colunaDe_(COLUNAS_PESSOAS, 'id'), pessoaId)) {
    throw erro_(
      ERRO_NAO_ENCONTRADO,
      'pessoa_id "' + pessoaId + '" não existe na aba ' + PESSOAS_TAB_NAME + '.'
    );
  }
}

/**
 * O card existe?
 *
 * Note que o `delegado_para` do createCard **não** faz esta conferência (ver `02`). Aqui ela
 * entra porque é barata e porque a nota é o único lugar que referencia card por id vindo do
 * cliente — id solto viraria uma referência pendurada que ninguém acha depois.
 */
function exigirCardExistente_(cardId) {
  const sheet = abaKanban_();
  if (!linhaComValor_(sheet, colunaDe_(COLUNAS, 'id'), cardId)) {
    throw erro_(ERRO_NAO_ENCONTRADO, 'card_id "' + cardId + '" não existe na aba ' + TAB_NAME + '.');
  }
}

function abaNotas_() {
  return abaPorNome_(NOTAS_TAB_NAME, 'setupNotas');
}

/* ==========================================================================
   LOG DA INGESTÃO — LEITURA
   --------------------------------------------------------------------------
   Quem escreve é o `gravarLog_`, na Ingestão. Aqui só se lê, para a tela.

   Existe porque toda captura de skill confirma ANTES de ser validada: a skill
   grava o arquivo e diz "anotado", e a validação só acontece no processarInbox,
   até 10 minutos depois. Quando ela falha, o fracasso ficava escrito aqui e em
   `erros/` sem nada na tela — em 03/08/2026 três anotações morreram assim e só
   apareceram porque alguém foi olhar. Ver `05`.
   ========================================================================== */

/** Janela padrão da tela de Log. Auditoria de ontem serve; de junho, não. */
const LOG_DIAS_JANELA = 7;

/**
 * Teto de linhas devolvidas.
 *
 * O Log cresce para sempre e nada o apara. Sem teto, um dia de reprocessamento em massa
 * mandaria milhares de linhas pelo `google.script.run` para desenhar uma lista que ninguém
 * rola até o fim. O que foi cortado é **declarado**, nunca omitido.
 */
const LOG_MAX_LINHAS = 200;

/**
 * Até quando o log já foi conferido, em UserProperties.
 *
 * Existe porque `erros na janela` é um número que não pode baixar — só envelhecer. Depois de
 * corrigir os arquivos e reprocessá-los, a pasta `erros/` fica vazia e o contador continua
 * marcando 4, porque as linhas antigas do Log seguem lá. O marcador transforma o contador em
 * **"falhas que eu ainda não vi"**, que é um número que a ação zera.
 *
 * `PropertiesService` não pede escopo, como no tema.
 */
const PROP_LOG_VISTO = 'LOG_VISTO_ATE';

/**
 * O log recente da ingestão, mais novo primeiro.
 *
 * As contagens são da **janela**, não da aba inteira: somar o histórico faria um erro de
 * junho pedir atenção para sempre.
 *
 * `naoVistos` é o que vai no menu; `erros` continua sendo o total da janela, porque a lista
 * mostra todos. **Marcar como visto zera o contador e não esconde nada** — se escondesse,
 * seria a mesma perda silenciosa que esta tela existe para consertar.
 *
 * @param {number} [dias=LOG_DIAS_JANELA] Tamanho da janela.
 * @return {{linhas: Object[], dias: number, total: number, naJanela: number,
 *           cortadas: number, ok: number, ignorados: number, erros: number,
 *           naoVistos: number, vistoAte: string}}
 */
function listLog(dias) {
  const janela = Number(dias) > 0 ? Math.floor(Number(dias)) : LOG_DIAS_JANELA;

  // Âncora em `quando` e não em `id`: a aba Log não tem coluna de id.
  const todas = lerAba_(LOG_TAB_NAME, 'setupLog', COLUNAS_LOG, 'quando');

  const corte = Utilities.formatDate(
    new Date(Date.now() - janela * 86400000),
    SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(),
    ISO_DATA
  );

  // `quando` atravessa como 'yyyy-MM-ddTHH:mm:ss', então comparar os 10 primeiros
  // caracteres com uma data ISO é comparação de texto e ordena certo.
  const naJanela = todas
    .filter(function (l) { return String(l.quando).slice(0, 10) >= corte; })
    .sort(function (a, b) { return String(b.quando).localeCompare(String(a.quando)); });

  const conta = function (resultado) {
    return naJanela.filter(function (l) { return l.resultado === resultado; }).length;
  };

  // Comparação de texto entre dois ISO 'yyyy-MM-ddTHH:mm:ss' ordena certo, e é o mesmo
  // formato dos dois lados: `quando` sai do mapeador e `vistoAte` foi gravado por aqui.
  const vistoAte = logVistoAte_();
  const naoVistos = naJanela.filter(function (l) {
    return l.resultado === 'erro' && (!vistoAte || String(l.quando) > vistoAte);
  }).length;

  return {
    linhas: naJanela.slice(0, LOG_MAX_LINHAS),
    dias: janela,
    total: todas.length,
    naJanela: naJanela.length,
    cortadas: Math.max(0, naJanela.length - LOG_MAX_LINHAS),
    ok: conta('ok'),
    ignorados: conta('ignorado'),
    erros: conta('erro'),
    naoVistos: naoVistos,
    vistoAte: vistoAte
  };
}

function logVistoAte_() {
  return String(
    PropertiesService.getUserProperties().getProperty(PROP_LOG_VISTO) || ''
  ).trim();
}

/**
 * Marca o log como conferido até agora.
 *
 * Grava o instante, e não um "zerado: true": um erro que chegar depois disto levanta o
 * contador de novo sozinho, sem ninguém precisar destravar nada. Flag booleana exigiria
 * lembrar de limpá-la, e ela seria esquecida exatamente no dia em que importasse.
 *
 * @return {{vistoAte: string, naoVistos: number}} O estado depois de marcar.
 */
function marcarLogVisto() {
  const agora = Utilities.formatDate(
    new Date(),
    SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(),
    ISO_DATA_HORA
  );

  PropertiesService.getUserProperties().setProperty(PROP_LOG_VISTO, agora);
  return { vistoAte: agora, naoVistos: 0 };
}

/**
 * Lê uma aba inteira e devolve objetos, descartando linha sem o campo-âncora.
 *
 * Sem contador de ignoradas, ao contrário do listCards: nas abas que não recebem digitação
 * manual, linha sem âncora é grade sobrando, não sintoma de uso indevido.
 *
 * @param {string} [ancora='id'] Campo que precisa estar preenchido para a linha valer. A
 *     aba `Log` **não tem `id`** — a primeira coluna dela é `quando`, e o padrão descartaria
 *     o log inteiro em silêncio.
 */
function lerAba_(nome, funcaoDeSetup, colunas, ancora) {
  const sheet = abaPorNome_(nome, funcaoDeSetup);
  const campo = ancora || 'id';

  const totalLinhas = sheet.getMaxRows() - 1;
  if (totalLinhas < 1) return [];

  const linhas = sheet.getRange(2, 1, totalLinhas, colunas.length).getValues();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  return linhas
    .map(function (linha) { return linhaParaObjeto_(linha, colunas, tz); })
    .filter(function (obj) { return obj[campo]; });
}

/** "id1,id2" → ['id1','id2']. Formato de FK multivalor do `delegado_para`. */
function idsDeCsv_(valor) {
  return texto_(valor).split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
}

/** A aba de cards, ou erro explícito se o setup nunca rodou. */
function abaKanban_() {
  return abaPorNome_(TAB_NAME, 'setupKanban');
}

function abaAnotacoes_() {
  return abaPorNome_(ANOTACOES_TAB_NAME, 'setupAnotacoes');
}

function abaPessoas_() {
  return abaPorNome_(PESSOAS_TAB_NAME, 'setupPessoas');
}

function abaPorNome_(nome, funcaoDeSetup) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome);
  if (!sheet) {
    throw new Error(
      'Aba "' + nome + '" não encontrada na planilha ativa. Rode ' + funcaoDeSetup + '() antes.'
    );
  }
  return sheet;
}

/**
 * Mapeador linha→objeto, dirigido pelo schema recebido. Sem nenhum índice de coluna
 * cravado — mudar a ordem no schema reordena a leitura de graça.
 *
 * Recebe o schema em vez de ler COLUNAS: é a mesma função para Kanban, Pessoas e Anotações.
 * Uma cópia por entidade seria a segunda fonte da verdade que o contrato proíbe.
 */
function linhaParaObjeto_(linha, colunas, tz) {
  const obj = {};
  colunas.forEach(function (c, i) {
    obj[c.campo] = normalizarLeitura_(linha[i], c.tipo, tz);
  });
  return obj;
}

/**
 * Mapeador objeto→linha, espelho do linhaParaObjeto_. Recebe o objeto já validado, com
 * valores prontos para célula (Date nas datas, boolean no checkbox, string no resto).
 */
function objetoParaLinha_(obj, colunas) {
  return colunas.map(function (c) {
    if (!(c.campo in obj)) {
      throw new Error(
        'objetoParaLinha_: campo "' + c.campo + '" ausente. O schema ganhou uma coluna e a ' +
        'montagem do objeto não acompanhou.'
      );
    }
    return obj[c.campo];
  });
}

/** Valor de célula → valor de transporte, conforme o `tipo` declarado no schema. */
function normalizarLeitura_(valor, tipo, tz) {
  if (tipo === 'data' || tipo === 'data_hora') {
    // Célula vazia, ou texto onde deveria haver data: devolve '' em vez de inventar.
    if (!(valor instanceof Date)) return '';
    return Utilities.formatDate(valor, tz, tipo === 'data' ? ISO_DATA : ISO_DATA_HORA);
  }

  // Usamos requireCheckbox() no setup, então célula nunca tocada volta '' e não false.
  if (tipo === 'booleano') return valor === true;

  if (valor === null || valor === undefined) return '';
  return String(valor).trim();
}

/** Linha sem nada preenchido — grade sobrando, não lixo. Não vira aviso. */
function cardVazio_(card) {
  return COLUNAS.every(function (c) {
    const v = card[c.campo];
    return v === '' || v === false;
  });
}

/* ==========================================================================
   VALIDAÇÃO DE ENTRADA
   --------------------------------------------------------------------------
   O dropdown e o checkbox montados pelo setupKanban valem para quem digita na aba;
   escrita via API passa por cima deles sem reclamar. Então a validação daqui não é
   redundante com a da planilha — nesse caminho, ela é a única que existe.
   ========================================================================== */

/**
 * Payload cru → card pronto para virar linha. Todos os campos de COLUNAS presentes, com
 * defaults aplicados e valores já no tipo de célula. Lança em qualquer entrada inválida.
 */
/**
 * Payload do createCard → card completo, com defaults aplicados e valores prontos para
 * célula. Os três campos gerados saem vazios daqui: quem preenche é o createCard, no lock.
 */
function validarPayload_(payload) {
  const card = normalizarPayload_(COLUNAS, payload, 'createCard');

  // Daqui para baixo, o que é regra só da criação de card.
  if (!card.titulo) throw erro_(ERRO_VALIDACAO, 'createCard: "titulo" é obrigatório.');
  if (!card.status) card.status = STATUS_PADRAO;
  // `prioridade` não ganha default: o contrato só define um para `status`.

  return card;
}

/**
 * Payload do createAnotacao → anotação pronta para virar linha.
 *
 * Recebe o payload já traduzido do envelope: `pessoa_id` resolvido pela skill e os quatro
 * `valor_*` como booleanos. A tradução dos rótulos EMPRESA mora na borda da ingestão.
 */
function validarPayloadAnotacao_(payload) {
  const anotacao = normalizarPayload_(COLUNAS_ANOTACOES, payload, 'createAnotacao');

  if (!anotacao.nota) throw erro_(ERRO_VALIDACAO, 'createAnotacao: "nota" é obrigatória.');
  if (!anotacao.pessoa_id) {
    throw erro_(ERRO_VALIDACAO, 'createAnotacao: "pessoa_id" é obrigatório.');
  }
  // Sem default: melhoria e positivo são opostos, e escolher um por omissão seria inventar
  // julgamento sobre um feedback que ninguém classificou.
  if (!anotacao.tipo) {
    throw erro_(
      ERRO_VALIDACAO,
      'createAnotacao: "tipo" é obrigatório. Aceitos: ' + TIPO_NOTA_OPCOES.join(' · ') + '.'
    );
  }

  // A captura por voz quase sempre é do dia. Meia-noite local, não `agora`, para a célula
  // guardar uma data limpa.
  if (!anotacao.data) anotacao.data = hojeMeiaNoite_();

  return anotacao;
}

/** Payload cru → objeto com todos os campos do schema, normalizados. Comum aos dois creates. */
function normalizarPayload_(colunas, payload, contexto) {
  if (!payload || typeof payload !== 'object') {
    throw erro_(ERRO_VALIDACAO, contexto + ': payload ausente ou não é um objeto.');
  }
  validarChaves_(colunas, payload, contexto);

  const obj = {};
  colunas.forEach(function (c) {
    obj[c.campo] = CAMPOS_GERADOS.indexOf(c.campo) >= 0
      ? ''
      : normalizarEntrada_(colunas, c.campo, payload[c.campo]);
  });
  return obj;
}

/** Rejeita campo gerado pela camada e campo que não existe no schema. */
function validarChaves_(colunas, obj, contexto) {
  const editaveis = colunas
    .filter(function (c) { return CAMPOS_GERADOS.indexOf(c.campo) < 0; })
    .map(function (c) { return c.campo; });

  Object.keys(obj).forEach(function (chave) {
    if (CAMPOS_GERADOS.indexOf(chave) >= 0) {
      throw erro_(
        ERRO_VALIDACAO,
        contexto + ': "' + chave + '" é gerado pela camada e não pode ser enviado.'
      );
    }
    if (editaveis.indexOf(chave) < 0) {
      throw erro_(
        ERRO_VALIDACAO,
        contexto + ': campo desconhecido "' + chave + '". Aceitos: ' + editaveis.join(', ') + '.'
      );
    }
  });
}

/**
 * Valor cru de payload/patch → valor pronto para célula, pela regra do `tipo` em COLUNAS.
 * Espelho do normalizarLeitura_, que faz o caminho de volta.
 *
 * Fonte única das regras por campo: createCard e updateCard passam os dois por aqui.
 */
function normalizarEntrada_(colunas, campo, valor) {
  const coluna = colunaPorCampo_(colunas, campo);
  if (!coluna) {
    throw erro_(ERRO_VALIDACAO, 'normalizarEntrada_: campo desconhecido "' + campo + '".');
  }

  if (coluna.tipo === 'booleano') return valor === true;
  if (coluna.tipo === 'data') return dataDeIso_(valor, campo);
  if (coluna.tipo === 'data_hora') {
    throw erro_(ERRO_VALIDACAO, 'normalizarEntrada_: "' + campo + '" é carimbado pela camada.');
  }

  // A lista fechada vem do próprio schema, não de um mapa campo→lista à parte: assim uma
  // aba nova valida sozinha, sem tocar nesta função.
  const texto = texto_(valor);
  if (coluna.opcoes && texto) validarOpcao_(campo, texto, coluna.opcoes);
  return texto;
}

function validarOpcao_(campo, valor, opcoes) {
  if (opcoes.indexOf(valor) < 0) {
    throw erro_(
      ERRO_VALIDACAO,
      '"' + campo + '" = "' + valor + '" não está na lista. ' +
      'Valores aceitos: ' + opcoes.join(' · ') + '.'
    );
  }
}

/**
 * String ISO `yyyy-MM-dd` → Date à meia-noite local. Vazio devolve ''.
 *
 * Não usa `new Date(iso)`: o parser trataria a string como UTC e, em fuso negativo, a
 * data gravada voltaria um dia.
 */
function dataDeIso_(valor, campo) {
  const iso = texto_(valor);
  if (!iso) return '';

  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!partes) {
    throw erro_(
      ERRO_VALIDACAO,
      '"' + campo + '" = "' + iso + '" fora do formato esperado (yyyy-MM-dd).'
    );
  }

  const ano = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);
  const data = new Date(ano, mes - 1, dia);

  // new Date(2026, 1, 31) não estoura — rola para 03/03. Conferir de volta pega isso.
  if (data.getFullYear() !== ano || data.getMonth() !== mes - 1 || data.getDate() !== dia) {
    throw erro_(ERRO_VALIDACAO, '"' + campo + '" = "' + iso + '" não é uma data válida.');
  }
  return data;
}

function texto_(valor) {
  return valor === null || valor === undefined ? '' : String(valor).trim();
}

/**
 * Prazo ascendente. Card sem prazo vai para o fim; entre eles o sort estável do V8
 * preserva a ordem da planilha.
 */
function compararPorPrazo_(a, b) {
  if (!a.prazo && !b.prazo) return 0;
  if (!a.prazo) return 1;
  if (!b.prazo) return -1;
  if (a.prazo < b.prazo) return -1;
  return a.prazo > b.prazo ? 1 : 0;
}
