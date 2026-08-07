/**
 * Ingestão pelo inbox do Drive.
 *
 * Contrato: models/02-camada-de-acesso.md. Se algo aqui divergir de lá, o errado é este
 * arquivo — exceto schema e serialização, onde manda o 01.
 *
 * O Claude escreve um JSON tipado em `inbox/`; este arquivo traduz aquilo em chamada de
 * `createCard` ou `createAnotacao`. Ninguém aqui escreve célula: tudo passa pela camada.
 *
 * É aqui que mora a tradução envelope→schema. O envelope fala a língua de quem captura; a
 * camada fala a do `01`. Manter a tradução na borda é o que permite ao front chamar as
 * mesmas funções sem passar por nada disto.
 */

/* Chaves em Configurações do projeto → Propriedades do script. Nada de ID hardcoded. */
const PROP_INBOX       = 'INBOX_FOLDER_ID';
const PROP_PROCESSADOS = 'PROCESSADOS_FOLDER_ID';
const PROP_ERROS       = 'ERROS_FOLDER_ID';

const FUNCAO_TRIGGER = 'processarInbox';
const INTERVALO_MINUTOS = 10;

/** Tipos que o envelope pode declarar. Duas skills, uma porta. */
const TIPOS_ACEITOS = ['card', 'anotacao', '1a1'];

/**
 * Teto de arquivos por rodada.
 *
 * Existe porque a execução morre aos 6 minutos: sem teto, um inbox com centenas de arquivos
 * é interrompido no meio, todo ciclo, sem nunca terminar. Com teto, o excedente sobra para a
 * próxima rodada — e o que sobrou é registrado, nunca silenciosamente descartado.
 */
const MAX_ARQUIVOS_POR_RODADA = 50;

/**
 * Lê o inbox, cria os cards e move os arquivos.
 *
 * @return {{processados: number, ignorados: number, erros: number,
 *           ocupado?: boolean, restantes?: boolean}}
 */
function processarInbox() {
  // getUserLock, e não getScriptLock: o createCard pega o script lock lá dentro, e locks do
  // Apps Script não são confiavelmente reentrantes — aninhar o mesmo lock faria todo arquivo
  // falhar no tryLock interno. Locks distintos, cada um protegendo o seu: este serializa a
  // leitura do inbox, o de lá serializa a escrita da linha.
  const lock = LockService.getUserLock();

  // Não conseguiu, desiste. Não enfileira: se outra execução está processando o mesmo
  // inbox, não há trabalho a fazer aqui.
  if (!lock.tryLock(1000)) {
    Logger.log('processarInbox: outra execução em andamento. Desistindo.');
    return { processados: 0, ignorados: 0, erros: 0, ocupado: true };
  }

  try {
    return processarInboxComLock_();
  } finally {
    lock.releaseLock();
  }
}

function processarInboxComLock_() {
  const pastas = pastasDeIngestao_();

  const arquivos = [];
  const fila = pastas.inbox.getFiles();
  while (fila.hasNext() && arquivos.length < MAX_ARQUIVOS_POR_RODADA) {
    arquivos.push(fila.next());
  }
  const restantes = fila.hasNext();

  if (!arquivos.length) {
    Logger.log('processarInbox: inbox vazio.');
    return { processados: 0, ignorados: 0, erros: 0 };
  }

  const quando = new Date();
  const linhasLog = [];
  let processados = 0;
  let ignorados = 0;
  let erros = 0;

  arquivos.forEach(function (file) {
    // Um arquivo ruim não derruba a leva: cada um no seu try/catch.
    try {
      const r = processarArquivo_(file);
      if (r.resultado === 'ok') processados++; else ignorados++;
      linhasLog.push(linhaDeLog_(quando, file, r.tipo, r.resultado, r.id, r.mensagem));
      moverPara_(file, pastas.processados);
    } catch (err) {
      erros++;
      linhasLog.push(linhaDeLog_(quando, file, '', 'erro', '', mensagemDe_(err)));
      moverPara_(file, pastas.erros);
    }
  });

  gravarLog_(linhasLog);

  const resumo = { processados: processados, ignorados: ignorados, erros: erros };
  Logger.log('processarInbox: %s ok, %s ignorado(s), %s erro(s).', processados, ignorados, erros);

  if (restantes) {
    resumo.restantes = true;
    Logger.log(
      'processarInbox: teto de %s arquivos por rodada atingido — ainda há arquivo no inbox ' +
      'para a próxima rodada.', MAX_ARQUIVOS_POR_RODADA
    );
  }
  return resumo;
}

/**
 * Um arquivo → uma chamada de camada.
 *
 * Devolve o desfecho quando ele é conhecido (`ok` ou `ignorado`) e lança quando o arquivo
 * precisa ir para `erros/`. `ErroDuplicado` não lança: pelo contrato, duplicata é o caminho
 * feliz do reprocessamento, vai para `processados/` e conta como ignorado.
 */
function processarArquivo_(file) {
  const envelope = lerEnvelope_(file);
  const payload = envelope.payload;

  // O file ID é único por construção: o Claude não tem como colidir nem esquecer. E cobre o
  // caso que importa — execução que morre entre gravar a linha e mover o arquivo deixa o
  // MESMO arquivo no inbox, com o MESMO id, e a rodada seguinte reconhece a duplicata.
  payload.origem_id = file.getId();

  try {
    const gravado = aplicarEnvelope_(envelope.tipo, payload);
    return { tipo: envelope.tipo, resultado: 'ok', id: gravado.id, mensagem: '' };
  } catch (err) {
    if (classeDoErro_(err) !== ERRO_DUPLICADO) throw err;
    return {
      tipo: envelope.tipo,
      resultado: 'ignorado',
      id: err.registroExistente || '',
      mensagem: 'já processado em rodada anterior'
    };
  }
}

/**
 * O `tipo` do envelope escolhe a função da camada.
 *
 * Toda escrita vinda de skill passa por aqui: o conector do Drive lê a planilha, mas não
 * escreve nela. O inbox é o caminho único, e cada tipo novo é um ramo neste dispatch — não
 * um caminho de escrita paralelo.
 */
function aplicarEnvelope_(tipo, payload) {
  if (tipo === 'anotacao') return createAnotacao(traduzirEnvelopeDeAnotacao_(payload));
  if (tipo === '1a1') return registrar1a1(traduzirEnvelopeDe1a1_(payload));
  return createCard(payload);
}

/**
 * Envelope de 1:1 → payload do registrar1a1.
 *
 * Descarta o `origem_id` que a ingestão acabou de carimbar: a aba Pessoas não tem essa
 * coluna. O carimbo é idempotente por natureza — regravar a mesma data não faz nada —, então
 * ele não precisa da dedupe que existe para não inserir a mesma linha duas vezes.
 *
 * Como na anotação, quem resolve nome→id é a skill; aqui só se confere que o id existe.
 */
function traduzirEnvelopeDe1a1_(payload) {
  const ACEITOS = ['pessoa_id', 'data'];

  Object.keys(payload).forEach(function (chave) {
    if (ACEITOS.indexOf(chave) < 0 && chave !== 'origem_id') {
      throw erro_(
        ERRO_VALIDACAO,
        'campo desconhecido no payload de 1a1: "' + chave + '". Aceitos: ' + ACEITOS.join(', ') + '.'
      );
    }
  });

  const traduzido = {};
  ACEITOS.forEach(function (campo) {
    if (campo in payload) traduzido[campo] = payload[campo];
  });
  return traduzido;
}

/**
 * Envelope de anotação → payload do schema.
 *
 * O envelope fala a língua de quem captura; o `01` fala a língua da planilha. A tradução
 * mora aqui, na borda, e não no createAnotacao — que continua conhecendo só o schema, e é
 * o que o front vai chamar direto quando existir.
 *
 * Duas diferenças em relação ao schema:
 *   `tipo_nota`  → `tipo`. O envelope já usa `tipo` para discriminar card/anotação.
 *   `valores[]`  → os quatro `valor_*` booleanos.
 *
 * `pessoa_id` NÃO é traduzido: quem resolve nome→id é a skill, antes de escrever o arquivo.
 * O createAnotacao confere se o id existe.
 */
function traduzirEnvelopeDeAnotacao_(payload) {
  const CAMPOS_DIRETOS = ['pessoa_id', 'nota', 'contexto', 'data', 'notion_id', 'origem_id'];
  const CAMPOS_TRADUZIDOS = ['tipo_nota', 'valores'];

  Object.keys(payload).forEach(function (chave) {
    if (CAMPOS_DIRETOS.indexOf(chave) < 0 && CAMPOS_TRADUZIDOS.indexOf(chave) < 0) {
      throw erro_(
        ERRO_VALIDACAO,
        'campo desconhecido no payload de anotação: "' + chave + '". Aceitos: ' +
        CAMPOS_DIRETOS.concat(CAMPOS_TRADUZIDOS).join(', ') + '.'
      );
    }
  });

  const traduzido = {};
  CAMPOS_DIRETOS.forEach(function (campo) {
    if (campo in payload) traduzido[campo] = payload[campo];
  });
  if ('tipo_nota' in payload) traduzido.tipo = payload.tipo_nota;

  if ('valores' in payload) {
    if (!Array.isArray(payload.valores)) {
      throw erro_(ERRO_VALIDACAO, '"valores" precisa ser uma lista de rótulos EMPRESA.');
    }
    // Todos explícitos: mandar `valores` significa declarar o conjunto inteiro, então o que
    // não veio é false, e não "não mexi". Patch parcial de valor não existe na criação.
    Object.keys(VALORES_EMPRESA).forEach(function (rotulo) {
      traduzido[VALORES_EMPRESA[rotulo]] = false;
    });
    payload.valores.forEach(function (rotulo) {
      const campo = campoDoValorEmpresa_(rotulo);
      if (!campo) {
        throw erro_(
          ERRO_VALIDACAO,
          'valor EMPRESA desconhecido: "' + rotulo + '". Aceitos: ' +
          Object.keys(VALORES_EMPRESA).join(' · ') + '.'
        );
      }
      traduzido[campo] = true;
    });
  }

  return traduzido;
}

/**
 * Rótulo EMPRESA → coluna, tolerante a caixa e acento.
 *
 * Ditado por voz não garante o acento de "Autogestão" nem a maiúscula, e recusar a nota
 * inteira por causa disso seria perder feedback por detalhe de digitação.
 */
function campoDoValorEmpresa_(rotulo) {
  const alvo = semAcento_(rotulo);
  const achado = Object.keys(VALORES_EMPRESA).filter(function (chave) {
    return semAcento_(chave) === alvo;
  })[0];
  return achado ? VALORES_EMPRESA[achado] : null;
}

function semAcento_(valor) {
  // NFD separa "ã" em "a" + til combinante; \p{M} casa a marca e deixa a letra base.
  // Property escape, e não um range tipo [̀-ͯ]: aquele só funciona escrito com
  // os caracteres literais, que são invisíveis no editor e somem em qualquer normalização
  // de arquivo — quebrando a função sem deixar rastro no diff.
  return texto_(valor).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Conteúdo do arquivo → envelope validado. Lança em qualquer coisa que não seja o esperado. */
function lerEnvelope_(file) {
  let texto;
  try {
    texto = file.getBlob().getDataAsString('UTF-8');
  } catch (err) {
    throw new Error('não foi possível ler o arquivo como texto: ' + mensagemDe_(err));
  }

  let envelope;
  try {
    envelope = JSON.parse(texto);
  } catch (err) {
    throw new Error('JSON inválido: ' + mensagemDe_(err));
  }

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('o envelope precisa ser um objeto JSON.');
  }

  const tipo = String(envelope.tipo || '').trim();
  if (TIPOS_ACEITOS.indexOf(tipo) < 0) {
    throw new Error(
      '"tipo" ausente ou desconhecido: "' + tipo + '". Aceitos: ' + TIPOS_ACEITOS.join(', ') + '.'
    );
  }

  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('"payload" ausente ou não é um objeto.');
  }

  // Quem preenche origem_id é a ingestão, com o file ID. Aceitar um vindo de fora abriria
  // caminho para duas linhas com a mesma procedência declarada e chaves de dedupe diferentes.
  if ('origem_id' in payload) {
    throw erro_(
      ERRO_VALIDACAO,
      '"origem_id" não pode vir no payload — quem preenche é a ingestão, com o ID do arquivo.'
    );
  }

  return { tipo: tipo, payload: payload };
}

/** Mover não pode derrubar a leva: falhou, registra e segue. O arquivo fica no inbox. */
function moverPara_(file, pasta) {
  try {
    file.moveTo(pasta);
  } catch (err) {
    Logger.log(
      'Falha ao mover "%s" para "%s": %s. O arquivo continua no inbox e será reprocessado — ' +
      'a dedupe por origem_id cobre isso.',
      file.getName(), pasta.getName(), mensagemDe_(err)
    );
  }
}

/* ==========================================================================
   LOG
   ========================================================================== */

/** Uma linha da aba Log, na ordem de COLUNAS_LOG. */
function linhaDeLog_(quando, file, tipo, resultado, idCriado, mensagem) {
  const valores = {
    quando: quando,
    arquivo: file.getName(),
    origem_id: file.getId(),
    tipo: tipo || '',
    resultado: resultado,
    id_criado: idCriado || '',
    mensagem: mensagem || ''
  };
  return COLUNAS_LOG.map(function (c) { return valores[c.campo]; });
}

/**
 * Escreve a leva inteira num setValues só.
 *
 * Em lote e não linha a linha: uma chamada em vez de N. Se a execução morrer no meio, o log
 * da leva se perde — mas os arquivos continuam no inbox e a rodada seguinte registra tudo.
 *
 * Log é auditoria, não é o trabalho: falhar aqui não pode derrubar uma ingestão que deu certo.
 */
function gravarLog_(linhas) {
  if (!linhas.length) return;

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_TAB_NAME);
    if (!sheet) {
      Logger.log(
        'Aba "%s" não existe — rode setupLog(). Log desta leva:\n%s',
        LOG_TAB_NAME, JSON.stringify(linhas)
      );
      return;
    }

    // Mesma âncora do Kanban, pelo mesmo motivo: getLastRow() não é confiável em aba com
    // formato aplicado no corpo inteiro. No Log a âncora é `quando`.
    const destino = ultimaLinhaPreenchida_(sheet, 1) + 1;
    const faltam = destino + linhas.length - 1 - sheet.getMaxRows();
    if (faltam > 0) sheet.insertRowsAfter(sheet.getMaxRows(), faltam);

    sheet.getRange(destino, 1, linhas.length, COLUNAS_LOG.length).setValues(linhas);
  } catch (err) {
    Logger.log('Falha ao gravar o Log: %s\nLinhas:\n%s', mensagemDe_(err), JSON.stringify(linhas));
  }
}

/* ==========================================================================
   CONFIGURAÇÃO E TRIGGER
   ========================================================================== */

function pastasDeIngestao_() {
  return {
    inbox: pastaDaPropriedade_(PROP_INBOX),
    processados: pastaDaPropriedade_(PROP_PROCESSADOS),
    erros: pastaDaPropriedade_(PROP_ERROS)
  };
}

function pastaDaPropriedade_(chave) {
  const id = String(
    PropertiesService.getScriptProperties().getProperty(chave) || ''
  ).trim();

  if (!id) {
    throw new Error(
      'Script Property "' + chave + '" não configurada. Preencha as três (' +
      [PROP_INBOX, PROP_PROCESSADOS, PROP_ERROS].join(', ') + ') em Configurações do ' +
      'projeto → Propriedades do script, e rode verificarConfiguracao().'
    );
  }

  try {
    return DriveApp.getFolderById(id);
  } catch (err) {
    throw new Error(
      'a pasta de "' + chave + '" (id ' + id + ') não abriu: ' + mensagemDe_(err)
    );
  }
}

/**
 * Confere o que precisa estar no lugar antes de operar: as pastas, as abas e o trigger.
 *
 * Nas três da ingestão, escreve e apaga um arquivo de teste — abrir uma pasta não prova que
 * dá para mover arquivo para dentro dela, e é justamente disso que a ingestão depende.
 *
 * As de painéis e de resumos são conferidas **só na leitura**, porque é só isso que o Apps
 * Script faz com elas: quem escreve ali é a skill, pelo conector do Drive. Exigir escrita
 * reprovaria uma configuração correta.
 */
function verificarConfiguracao() {
  const props = PropertiesService.getScriptProperties();
  let tudoOk = true;

  Logger.log('=== PASTAS ===');
  [
    { chave: PROP_INBOX,       escrita: true },
    { chave: PROP_PROCESSADOS, escrita: true },
    { chave: PROP_ERROS,       escrita: true },
    { chave: PROP_PAINEL,      escrita: false },
    { chave: PROP_RESUMOS,     escrita: false },
  ].forEach(function (alvo) {
    const id = String(props.getProperty(alvo.chave) || '').trim();
    if (!id) {
      Logger.log('%s: FALTANDO', alvo.chave);
      tudoOk = false;
      return;
    }
    try {
      const pasta = DriveApp.getFolderById(id);
      if (alvo.escrita) {
        const teste = pasta.createFile('.teste-de-escrita', '', MimeType.PLAIN_TEXT);
        teste.setTrashed(true);
        Logger.log('%s: OK — "%s" (escrita confirmada)', alvo.chave, pasta.getName());
      } else {
        Logger.log('%s: OK — "%s" (leitura)', alvo.chave, pasta.getName());
      }
    } catch (err) {
      Logger.log('%s: ERRO — %s', alvo.chave, mensagemDe_(err));
      tudoOk = false;
    }
  });

  Logger.log('=== ABAS ===');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [
    { nome: TAB_NAME, setup: 'setupKanban()' },
    { nome: PESSOAS_TAB_NAME, setup: 'setupPessoas()' },
    { nome: ANOTACOES_TAB_NAME, setup: 'setupAnotacoes()' },
    { nome: NOTAS_TAB_NAME, setup: 'setupNotas()' },
    { nome: LOG_TAB_NAME, setup: 'setupLog()' }
  ].forEach(function (aba) {
    if (ss.getSheetByName(aba.nome)) {
      Logger.log('Aba "%s": OK', aba.nome);
    } else {
      Logger.log('Aba "%s": FALTANDO — rode %s', aba.nome, aba.setup);
      tudoOk = false;
    }
  });

  // Zero ativos é o estado logo depois de criar a coluna `ativo`, com as caixas ainda em
  // branco — e ele deixa o app inteiro sem gente sem que nada dê erro. Fica aqui porque é
  // exatamente o tipo de coisa que esta função existe para pegar antes do uso.
  if (ss.getSheetByName(PESSOAS_TAB_NAME)) {
    Logger.log('=== PESSOAS ===');
    const todas = listPessoas();
    const ativas = todas.filter(function (p) { return p.ativo; }).length;

    if (ativas) {
      Logger.log('%s de %s pessoa(s) ativa(s).', ativas, todas.length);
    } else {
      Logger.log(
        'Nenhuma das %s pessoa(s) está marcada como ativa. As telas de Anotações e Resumos ' +
        'vão aparecer vazias. Marque a coluna "ativo" na aba %s.', todas.length,
        PESSOAS_TAB_NAME);
      tudoOk = false;
    }
  }

  Logger.log('=== TRIGGER ===');
  const triggers = triggersDoInbox_();
  if (triggers.length === 1) {
    Logger.log('1 trigger de %s instalado.', FUNCAO_TRIGGER);
  } else if (!triggers.length) {
    Logger.log('Nenhum trigger de %s — rode instalarTriggers()', FUNCAO_TRIGGER);
    tudoOk = false;
  } else {
    Logger.log('%s triggers de %s (esperado 1) — rode instalarTriggers() para normalizar.',
      triggers.length, FUNCAO_TRIGGER);
    tudoOk = false;
  }

  Logger.log(tudoOk ? '=== Configuração OK ===' : '=== Há pendências acima ===');
  return tudoOk;
}

/**
 * Instala o trigger de 10 minutos. Idempotente: remove os de `processarInbox` e recria.
 *
 * Remove só os deste handler, e não todos os do projeto: apagar trigger alheio seria efeito
 * colateral silencioso no dia em que o projeto tiver outro.
 */
function instalarTriggers() {
  const antigos = triggersDoInbox_();
  antigos.forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger(FUNCAO_TRIGGER)
    .timeBased()
    .everyMinutes(INTERVALO_MINUTOS)
    .create();

  Logger.log(
    'instalarTriggers: %s trigger(s) antigo(s) removido(s), 1 criado — %s a cada %s minutos.',
    antigos.length, FUNCAO_TRIGGER, INTERVALO_MINUTOS
  );
}

function triggersDoInbox_() {
  return ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === FUNCAO_TRIGGER;
  });
}
