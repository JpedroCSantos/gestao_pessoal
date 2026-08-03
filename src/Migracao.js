/**
 * Migração Notion → Google. Runbook em models/03-migracao.md.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ CÓDIGO COM DATA DE VALIDADE.                                             │
 * │ Este arquivo, a pasta de dumps no Drive e a Script Property DUMPS_FOLDER │
 * │ existem só até o corte. Depois dele, os três somem juntos — não vire     │
 * │ entulho permanente por esquecimento.                                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Estas funções NÃO rodam no dia a dia. São chamadas à mão, pelo editor.
 *
 * **Por que não usam createCard.** Ele carimba `criado_em = agora`, o que apagaria a data
 * de origem e cegaria o `resumo-semanal` justamente no julgamento de "o que carrego há
 * semanas". A carga histórica preserva `criado_em` da origem.
 */

/** Pasta no Drive com os dumps. Descartável, como o resto deste arquivo. */
const PROP_DUMPS = 'DUMPS_FOLDER_ID';

const DUMP_PESSOAS = 'pessoas.json';
const DUMP_KANBAN = 'kanban.json';
const DUMP_ANOTACOES = 'anotacoes.json';

/** Quantos registros a reconciliação imprime lado a lado para conferência humana. */
const TAMANHO_DA_AMOSTRA = 10;

/* ==========================================================================
   PESSOAS — entram primeiro, porque delas sai o mapa das FKs
   ========================================================================== */

/** Rode esta: lê `pessoas.json` da pasta de dumps e carrega. */
function rodarImportPessoas() {
  const resultado = importPessoas(lerDump_(DUMP_PESSOAS).pessoas);
  Logger.log('importPessoas: %s', JSON.stringify(resultado));
  return resultado;
}

/**
 * Insere ou atualiza pessoas, em lote.
 *
 * @param {Object[]} rows Registros do dump. `id` é o page ID do Notion, que vira `notion_id`.
 * @return {{inseridos: number, atualizados: number, erros: string[]}}
 */
function importPessoas(rows) {
  return importarEmLote_(rows, {
    rotulo: 'importPessoas',
    aba: PESSOAS_TAB_NAME,
    setup: 'setupPessoas',
    colunas: COLUNAS_PESSOAS,
    identificar: function (row) { return row && row.nome; },
    converter: function (row, agora) { return pessoaDoDump_(row, agora); },
  });
}

/* ==========================================================================
   CARDS
   ========================================================================== */

/** Rode esta: lê `kanban.json` da pasta de dumps e carrega. */
function rodarImportCards() {
  const resultado = importCards(lerDump_(DUMP_KANBAN).cards);
  Logger.log('importCards: %s', JSON.stringify(resultado));
  return resultado;
}

/**
 * Insere ou atualiza cards, em lote.
 *
 * Exige `Pessoas` já carregada: `delegado_para` vem do Notion como lista de páginas, e cada
 * uma precisa virar um `Pessoas.id` local pelo mapa de `notion_id`.
 */
function importCards(rows) {
  const mapa = mapaDePessoas_();
  return importarEmLote_(rows, {
    rotulo: 'importCards',
    aba: TAB_NAME,
    setup: 'setupKanban',
    colunas: COLUNAS,
    identificar: function (row) { return row && row.titulo; },
    converter: function (row, agora) { return cardDoDump_(row, mapa, agora); },
  });
}

/* ==========================================================================
   ANOTAÇÕES
   ========================================================================== */

/** Rode esta: lê `anotacoes.json` da pasta de dumps e carrega. */
function rodarImportAnotacoes() {
  const resultado = importAnotacoes(lerDump_(DUMP_ANOTACOES).anotacoes);
  Logger.log('importAnotacoes: %s', JSON.stringify(resultado));
  return resultado;
}

/** Insere ou atualiza anotações, em lote. Exige `Pessoas` já carregada — `pessoa_id` é FK. */
function importAnotacoes(rows) {
  const mapa = mapaDePessoas_();
  return importarEmLote_(rows, {
    rotulo: 'importAnotacoes',
    aba: ANOTACOES_TAB_NAME,
    setup: 'setupAnotacoes',
    colunas: COLUNAS_ANOTACOES,
    identificar: function (row) { return row && row.nota && String(row.nota).slice(0, 40); },
    converter: function (row, agora) { return anotacaoDoDump_(row, mapa, agora); },
  });
}

/* ==========================================================================
   O MOTOR DOS TRÊS IMPORTS
   ========================================================================== */

/**
 * Percorre os registros, converte cada um e grava — inserindo o que é novo e atualizando o
 * que já tem aquele `notion_id`.
 *
 * **Idempotente por `notion_id`:** rodar duas vezes atualiza em vez de duplicar. É o que
 * permite corrigir o dump e recarregar sem limpar a aba antes.
 *
 * **Registro inválido não derruba a leva** — vai para `erros[]` e os outros seguem. Carga
 * histórica que aborta no registro 37 de 60 deixa a aba num estado que ninguém sabe descrever.
 */
function importarEmLote_(rows, spec) {
  if (!Array.isArray(rows)) {
    throw new Error(spec.rotulo + ': esperava um array de registros.');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw erro_(ERRO_LOCK, 'outra escrita está em andamento.');
  }

  try {
    const sheet = abaPorNome_(spec.aba, spec.setup);
    const existentes = indicePorNotionId_(sheet, spec.colunas);
    const agora = new Date();

    const erros = [];
    const novas = [];
    let atualizados = 0;

    rows.forEach(function (row, i) {
      try {
        const obj = spec.converter(row, agora);
        const linha = objetoParaLinha_(obj, spec.colunas);
        const jaExiste = existentes[obj.notion_id];

        if (jaExiste) {
          preservarIdECriadoEm_(sheet, spec.colunas, jaExiste, linha);
          sheet.getRange(jaExiste, 1, 1, spec.colunas.length).setValues([linha]);
          atualizados++;
        } else {
          novas.push(linha);
        }
      } catch (err) {
        erros.push(
          'registro ' + i + ' (' + (spec.identificar(row) || row && row.id) + '): ' +
          mensagemDe_(err)
        );
      }
    });

    if (novas.length) escreverLote_(sheet, spec.colunas, novas);
    SpreadsheetApp.flush();

    return { inseridos: novas.length, atualizados: atualizados, erros: erros };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Na atualização, `id` e `criado_em` vêm da linha que já está lá.
 *
 * Trocar a PK quebraria toda FK que aponta para ela — e reescrever a data de origem é
 * exatamente o que a carga histórica existe para evitar.
 */
function preservarIdECriadoEm_(sheet, colunas, numeroDaLinha, linha) {
  const atual = sheet.getRange(numeroDaLinha, 1, 1, colunas.length).getValues()[0];
  ['id', 'criado_em'].forEach(function (campo) {
    const i = colunaDe_(colunas, campo) - 1;
    linha[i] = atual[i];
  });
}

/**
 * Mapa `notion_page_id` → `Pessoas.id` local.
 *
 * É por aqui que as duas FKs do sistema resolvem — `delegado_para` e `pessoa_id` —, e nunca
 * por nome: nome repete, muda, e o dump traz "Luiz Alberto" e "Luiz José" no mesmo time.
 */
function mapaDePessoas_() {
  const mapa = {};
  listPessoas().forEach(function (p) {
    if (p.notion_id) mapa[p.notion_id] = p.id;
  });

  if (!Object.keys(mapa).length) {
    throw new Error(
      'Nenhuma pessoa com notion_id na aba ' + PESSOAS_TAB_NAME + '. ' +
      'Rode rodarImportPessoas() antes: as FKs dependem desse mapa.'
    );
  }
  return mapa;
}

/** Registro do dump → objeto pronto para virar linha. Lança se algo estiver inválido. */
function pessoaDoDump_(row, agora) {
  if (!row || typeof row !== 'object') throw new Error('registro não é um objeto.');

  const nome = texto_(row.nome);
  if (!nome) throw new Error('"nome" é obrigatório.');

  const notionId = texto_(row.id);
  if (!notionId) throw new Error('"id" (page ID do Notion) é obrigatório.');

  const nivel = texto_(row.nivel);
  if (nivel) validarOpcao_('nivel', nivel, NIVEL_OPCOES);

  const criadoEm = dataHoraDaOrigem_(row.created_time) || agora;

  return {
    id: Utilities.getUuid(),
    notion_id: notionId,
    nome: nome,
    nivel: nivel,
    data_ultimo_1a1: dataDeIso_(row.data_ultimo_1a1, 'data_ultimo_1a1'),
    criado_em: criadoEm,
    // Origem não tem "atualizado_em": usa a data de criação, e não `agora`, para não fazer
    // todo registro migrado parecer tocado no dia da migração.
    atualizado_em: criadoEm,
    // O dump não tem esse conceito — todo mundo que estava no Notion estava no time. Quem
    // saiu depois é desmarcado à mão na aba.
    ativo: true
  };
}

/* ==========================================================================
   CONVERSORES — registro do dump → objeto do schema
   ========================================================================== */

/** Lança se algo estiver inválido; o chamador põe no relatório e segue. */
function cardDoDump_(row, mapa, agora) {
  exigirObjeto_(row);

  const titulo = texto_(row.titulo);
  if (!titulo) throw new Error('"titulo" é obrigatório.');

  // `status` vazio é aceito: o board tem a coluna "Sem status" justamente para deixar
  // visível o card que ficou sem classificação, em vez de escondê-lo ou recusá-lo.
  const status = texto_(row.status);
  if (status) validarOpcao_('status', status, STATUS_OPCOES);
  const prioridade = texto_(row.prioridade);
  if (prioridade) validarOpcao_('prioridade', prioridade, PRIORIDADE_OPCOES);

  const criadoEm = dataHoraDaOrigem_(row.created_time) || agora;

  return {
    id: Utilities.getUuid(),
    notion_id: exigirPageId_(row),
    titulo: titulo,
    status: status,
    prioridade: prioridade,
    prazo: dataDeIso_(row.prazo, 'prazo'),
    descricao: texto_(row.descricao),
    criado_em: criadoEm,
    atualizado_em: atualizadoEmDaOrigem_(row, criadoEm),
    aguardando_cliente: row.aguardando_cliente === true,
    prazo_cliente: dataDeIso_(row.prazo_cliente, 'prazo_cliente'),
    pendencia_cliente: texto_(row.pendencia_cliente),
    delegado_para: idsLocaisDeDelegados_(row.delegado_para, mapa),
    origem_id: '',            // a linha não veio do inbox
    data_inicio: dataDeIso_(row.data_inicio, 'data_inicio'),
    data_conclusao: dataDeIso_(row.data_conclusao, 'data_conclusao'),
    data_delegacao: dataDeIso_(row.data_delegacao, 'data_delegacao'),
  };
}

function anotacaoDoDump_(row, mapa, agora) {
  exigirObjeto_(row);

  const nota = texto_(row.nota);
  if (!nota) throw new Error('"nota" é obrigatória.');

  const pessoaLocal = mapa[texto_(row.pessoa_id)];
  if (!pessoaLocal) {
    throw new Error(
      'pessoa "' + texto_(row.pessoa_nome) + '" (page ' + texto_(row.pessoa_id) + ') não está ' +
      'em ' + PESSOAS_TAB_NAME + '.'
    );
  }

  const tipo = texto_(row.tipo);
  if (!tipo) throw new Error('"tipo" é obrigatório.');
  validarOpcao_('tipo', tipo, TIPO_NOTA_OPCOES);

  const criadoEm = dataHoraDaOrigem_(row.created_time) || agora;

  const anotacao = {
    id: Utilities.getUuid(),
    notion_id: exigirPageId_(row),
    pessoa_id: pessoaLocal,
    nota: nota,
    tipo: tipo,
    contexto: texto_(row.contexto),
    data: dataDeIso_(row.data, 'data'),
    criado_em: criadoEm,
    atualizado_em: atualizadoEmDaOrigem_(row, criadoEm),
    origem_id: '',
  };

  // Os quatro nascem false e só os citados sobem — mesma regra da tradução do envelope.
  Object.keys(VALORES_EMPRESA).forEach(function (rotulo) {
    anotacao[VALORES_EMPRESA[rotulo]] = false;
  });
  (row.valores || []).forEach(function (rotulo) {
    const campo = campoDoValorEmpresa_(rotulo);
    if (!campo) {
      throw new Error(
        'valor EMPRESA desconhecido: "' + rotulo + '". Aceitos: ' +
        Object.keys(VALORES_EMPRESA).join(' · ') + '.'
      );
    }
    anotacao[campo] = true;
  });

  return anotacao;
}

/**
 * A lista de delegados do Notion → ids locais separados por vírgula.
 *
 * Delegado fora do mapa é **erro no card**, não delegação silenciosamente perdida: FK órfã
 * é o que a reconciliação exige que seja zero, e um card no relatório de erros é achável.
 */
function idsLocaisDeDelegados_(delegados, mapa) {
  if (!Array.isArray(delegados) || !delegados.length) return '';

  return delegados.map(function (d) {
    const local = mapa[texto_(d && d.id)];
    if (!local) {
      throw new Error(
        'delegado "' + texto_(d && d.nome) + '" (page ' + texto_(d && d.id) + ') não está em ' +
        PESSOAS_TAB_NAME + '. Rode rodarImportPessoas() antes, ou confira o dump.'
      );
    }
    return local;
  }).join(',');
}

/**
 * `atualizado_em` da origem, caindo para `criado_em` quando o dump não trouxer.
 *
 * Sem `last_edited_time`, todo registro migrado fica parecendo intocado desde que nasceu, e
 * o `resumo-semanal` deixa de distinguir card parado de card mexido ontem. Cair para `agora`
 * seria pior: aí *todos* pareceriam tocados no dia da migração.
 */
function atualizadoEmDaOrigem_(row, criadoEm) {
  return dataHoraDaOrigem_(row.last_edited_time) || criadoEm;
}

function exigirObjeto_(row) {
  if (!row || typeof row !== 'object') throw new Error('registro não é um objeto.');
}

function exigirPageId_(row) {
  const id = texto_(row.id);
  if (!id) throw new Error('"id" (page ID do Notion) é obrigatório.');
  return id;
}

/* ==========================================================================
   INFRAESTRUTURA COMPARTILHADA PELOS IMPORTS
   ========================================================================== */

/** Lê e parseia um dump da pasta de dumps no Drive. */
function lerDump_(nomeArquivo) {
  const id = String(PropertiesService.getScriptProperties().getProperty(PROP_DUMPS) || '').trim();
  if (!id) {
    throw new Error(
      'Script Property "' + PROP_DUMPS + '" não configurada. Suba os dumps para uma pasta ' +
      'no Drive e ponha o ID dela nessa chave.'
    );
  }

  let pasta;
  try {
    pasta = DriveApp.getFolderById(id);
  } catch (err) {
    throw new Error('pasta de dumps (id ' + id + ') não abriu: ' + mensagemDe_(err));
  }

  const arquivos = pasta.getFilesByName(nomeArquivo);
  if (!arquivos.hasNext()) {
    throw new Error('"' + nomeArquivo + '" não encontrado em "' + pasta.getName() + '".');
  }

  const file = arquivos.next();
  if (arquivos.hasNext()) {
    // Duas versões do mesmo dump é a receita para carregar a errada sem perceber.
    throw new Error(
      'há mais de um "' + nomeArquivo + '" em "' + pasta.getName() + '". Deixe só o vigente.'
    );
  }

  try {
    return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  } catch (err) {
    throw new Error('"' + nomeArquivo + '" não é JSON válido: ' + mensagemDe_(err));
  }
}

/** Mapa `notion_id` → número da linha, para o import ser idempotente. */
function indicePorNotionId_(sheet, colunas) {
  const corpo = sheet.getMaxRows() - 1;
  const indice = {};
  if (corpo < 1) return indice;

  const valores = sheet.getRange(2, colunaDe_(colunas, 'notion_id'), corpo, 1).getValues();
  valores.forEach(function (linha, i) {
    const chave = String(linha[0]).trim();
    if (chave) indice[chave] = i + 2;
  });
  return indice;
}

/**
 * Escreve várias linhas de uma vez, ancorando na coluna `id`.
 *
 * Em lote e não linha a linha: centenas de escritas individuais estouram o tempo de
 * execução. E nada de appendRow, pelo motivo de sempre — `getLastRow()` não é confiável
 * numa aba com formato aplicado no corpo inteiro.
 */
function escreverLote_(sheet, colunas, linhas) {
  if (!linhas.length) return;

  const destino = ultimaLinhaPreenchida_(sheet, colunaDe_(colunas, 'id')) + 1;
  const faltam = destino + linhas.length - 1 - sheet.getMaxRows();
  if (faltam > 0) sheet.insertRowsAfter(sheet.getMaxRows(), faltam);

  sheet.getRange(destino, 1, linhas.length, colunas.length).setValues(linhas);
}

/**
 * Timestamp da origem → Date. Aceita o formato do dump (`2026-07-20 00:21:13Z`) e ISO 8601.
 *
 * Diferente de `dataDeIso_`, aqui `new Date()` sobre a string é o certo: o valor **tem**
 * fuso declarado (o Z no fim), então não há ambiguidade a evitar — só conversão para o
 * fuso local, que é exatamente o que queremos gravar.
 */
function dataHoraDaOrigem_(valor) {
  const texto = texto_(valor);
  if (!texto) return null;

  const data = new Date(texto.indexOf('T') >= 0 ? texto : texto.replace(' ', 'T'));
  if (isNaN(data.getTime())) {
    throw new Error('timestamp de origem inválido: "' + texto + '".');
  }
  return data;
}

/* ==========================================================================
   RECONCILIAÇÃO
   ========================================================================== */

/**
 * Confere a migração contra os dumps e imprime o resultado no log.
 *
 * As três checagens do `03`, nesta ordem: contagem por base, FK órfã, e amostra campo a
 * campo. Devolve `true` só se as três passarem — e o número é o que decide o cutover, então
 * ele não pode sair de "olhar a planilha e achar que está certo".
 *
 * A comparação é contra o **dump**, não contra o Notion. Isso pega erro de transformação,
 * que é o que o código pode ter errado; divergência entre dump e Notion é assunto do dump.
 */
function reconciliarMigracao() {
  const dumps = {
    Pessoas: { origem: lerDump_(DUMP_PESSOAS).pessoas, destino: listPessoas() },
    Kanban: { origem: lerDump_(DUMP_KANBAN).cards, destino: listCards().cards },
    Anotações: { origem: lerDump_(DUMP_ANOTACOES).anotacoes, destino: lerAnotacoes_() },
  };

  let tudoOk = true;

  Logger.log('=== 1. CONTAGEM ===');
  Object.keys(dumps).forEach(function (base) {
    if (!conferirContagem_(base, dumps[base].origem, dumps[base].destino)) tudoOk = false;
  });

  Logger.log('=== 2. INTEGRIDADE DAS FKs ===');
  if (!conferirFks_(dumps.Pessoas.destino, dumps.Kanban.destino, dumps['Anotações'].destino)) {
    tudoOk = false;
  }

  Logger.log('=== 3. AMOSTRA, CAMPO A CAMPO ===');
  if (!conferirCampos_('Kanban', dumps.Kanban, CAMPOS_CONFERIDOS_CARD)) tudoOk = false;
  if (!conferirCampos_('Anotações', dumps['Anotações'], CAMPOS_CONFERIDOS_ANOTACAO)) tudoOk = false;

  Logger.log(tudoOk ? '=== RECONCILIAÇÃO OK ===' : '=== HÁ DIVERGÊNCIAS ACIMA ===');
  return tudoOk;
}

/** Campo do dump → campo da aba, para os que devem sobreviver idênticos. */
const CAMPOS_CONFERIDOS_CARD = {
  titulo: 'titulo', status: 'status', prioridade: 'prioridade',
  descricao: 'descricao', prazo: 'prazo', prazo_cliente: 'prazo_cliente',
  pendencia_cliente: 'pendencia_cliente', data_inicio: 'data_inicio',
  data_conclusao: 'data_conclusao', data_delegacao: 'data_delegacao',
};

const CAMPOS_CONFERIDOS_ANOTACAO = {
  nota: 'nota', tipo: 'tipo', contexto: 'contexto', data: 'data',
};

/** Contagem, e quais page IDs faltam ou sobram — o número sozinho não diz onde procurar. */
function conferirContagem_(base, origem, destino) {
  const idsOrigem = origem.map(function (r) { return texto_(r.id); }).filter(Boolean);
  const idsDestino = destino.map(function (r) { return r.notion_id; }).filter(Boolean);

  const noDestino = {};
  idsDestino.forEach(function (id) { noDestino[id] = true; });
  const noOrigem = {};
  idsOrigem.forEach(function (id) { noOrigem[id] = true; });

  const faltando = idsOrigem.filter(function (id) { return !noDestino[id]; });
  const sobrando = idsDestino.filter(function (id) { return !noOrigem[id]; });

  Logger.log('%s: dump %s | aba %s', base, origem.length, destino.length);
  if (faltando.length) Logger.log('  no dump e NÃO na aba (%s): %s', faltando.length, faltando.join(', '));
  if (sobrando.length) Logger.log('  na aba e NÃO no dump (%s): %s', sobrando.length, sobrando.join(', '));

  return !faltando.length && !sobrando.length;
}

/** Nenhum `delegado_para` nem `pessoa_id` pode apontar para id que não existe. */
function conferirFks_(pessoas, cards, anotacoes) {
  const existe = {};
  pessoas.forEach(function (p) { existe[p.id] = true; });

  const orfas = [];
  cards.forEach(function (c) {
    idsDeCsv_(c.delegado_para).forEach(function (id) {
      if (!existe[id]) orfas.push('card "' + c.titulo + '" delega para id inexistente ' + id);
    });
  });
  anotacoes.forEach(function (a) {
    if (a.pessoa_id && !existe[a.pessoa_id]) {
      orfas.push('anotação "' + a.nota.slice(0, 40) + '" aponta para id inexistente ' + a.pessoa_id);
    }
  });

  if (orfas.length) orfas.forEach(function (o) { Logger.log('  ' + o); });
  Logger.log('%s FK(s) órfã(s).', orfas.length);
  return !orfas.length;
}

/**
 * Compara **todos** os registros nos campos mapeáveis e imprime uma amostra.
 *
 * O `03` pede amostra de ~10 conferida à mão. Comparar todos custa o mesmo em código e pega
 * o campo que se perdeu num registro que a amostra não sortearia; a amostra impressa
 * continua existindo para o olho humano ver que o conteúdo faz sentido, e não só que bate.
 */
function conferirCampos_(base, par, mapaDeCampos) {
  const porNotionId = {};
  par.destino.forEach(function (r) { porNotionId[r.notion_id] = r; });

  const divergencias = [];
  par.origem.forEach(function (origem) {
    const destino = porNotionId[texto_(origem.id)];
    if (!destino) return;   // já reportado na contagem

    Object.keys(mapaDeCampos).forEach(function (campoOrigem) {
      const esperado = texto_(origem[campoOrigem]);
      const obtido = texto_(destino[mapaDeCampos[campoOrigem]]);
      if (esperado !== obtido) {
        divergencias.push(
          '  ' + texto_(origem.id) + ' .' + campoOrigem +
          ': dump "' + esperado.slice(0, 60) + '" | aba "' + obtido.slice(0, 60) + '"'
        );
      }
    });
  });

  Logger.log('%s: %s registro(s) comparado(s) em %s campo(s) — %s divergência(s).',
    base, par.origem.length, Object.keys(mapaDeCampos).length, divergencias.length);
  divergencias.slice(0, 30).forEach(function (d) { Logger.log(d); });

  const passo = Math.max(1, Math.floor(par.destino.length / TAMANHO_DA_AMOSTRA));
  Logger.log('  amostra para conferência humana:');
  for (let i = 0; i < par.destino.length; i += passo) {
    const r = par.destino[i];
    Logger.log('    %s | %s', r.notion_id, texto_(r.titulo || r.nota).slice(0, 70));
  }

  return !divergencias.length;
}
