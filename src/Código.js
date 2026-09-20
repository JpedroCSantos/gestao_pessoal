/**
 * Provisionamento das abas de dados.
 *
 * Contrato: models/01-modelo-de-dados.md (aba Kanban) e models/02-camada-de-acesso.md
 * (aba Log). Se algo aqui divergir de lá, o errado é este arquivo.
 *
 * Este arquivo só monta CONFIGURAÇÃO de aba (cabeçalho, validações, formatos). Ele não
 * escreve card nem linha de log. Quem gera id, carimba data e grava é a camada de acesso —
 * caminho único de escrita.
 */

const TAB_NAME = 'Kanban';                // aba de cards. A planilha se chama "Gestão"
const PESSOAS_TAB_NAME = 'Pessoas';       // âncora das FKs
const ANOTACOES_TAB_NAME = 'Anotações';   // feedback por pessoa
const NOTAS_TAB_NAME = 'Notas';           // recado solto — NÃO é feedback. Ver o schema
const LOG_TAB_NAME = 'Log';               // auditoria da ingestão

/* --------------------------------------------------------------------------
   Listas fechadas. Declaradas ANTES dos schemas porque eles as referenciam no
   nível do arquivo — inverter a ordem daria ReferenceError na avaliação.
   -------------------------------------------------------------------------- */

/** Valores aceitos em `status`. Literais do contrato — a mistura de idiomas é proposital. */
const STATUS_OPCOES = ['Not started', 'In progress', 'Done', 'Delegado'];

/** Valores aceitos em `prioridade`. Literais do contrato, com acento em "Média". */
const PRIORIDADE_OPCOES = ['Alta', 'Média', 'Baixa'];

/** Valores aceitos em `nivel`. "TTL" ainda não aparece no dump, mas a lista rejeita o que
 *  está fora dela — descobrir isso no dia de promover alguém seria descobrir tarde. */
const NIVEL_OPCOES = ['Trainee SE', 'SE', 'TTL'];

/** Valores aceitos em `tipo` de anotação. Opostos: não existe default honesto entre eles. */
const TIPO_NOTA_OPCOES = ['melhoria', 'positivo'];

/**
 *
 * Existe porque o envelope da skill fala em rótulos (`["Qualidade", "Autogestão"]`) e o
 * schema fala em colunas. A tradução acontece na borda da ingestão; este mapa é a fonte
 * única dela. Rótulo novo entra aqui e em COLUNAS_ANOTACOES, e nada mais muda.
 */
const VALORES_EMPRESA = {
  'Autogestão':    'valor_autogestao',
  'Colaboração':   'valor_colaboracao',
  'Qualidade':     'valor_qualidade',
  'Transparência': 'valor_transparencia',
};

/* --------------------------------------------------------------------------
   Schemas. Cada um é a fonte única da ordem das colunas da sua aba: cabeçalho,
   validações, formatos e o mapeador linha↔objeto derivam todos daqui. Mexer na
   ordem é mexer no contrato — não faça sem atualizar o `01`.

   A lista fechada mora no próprio schema (`opcoes`), não num mapa campo→lista à
   parte: assim a validação é genérica e uma aba nova não precisa alterar código.
   -------------------------------------------------------------------------- */

const COLUNAS = [
  { campo: 'id',                 tipo: 'texto'     },
  { campo: 'notion_id',          tipo: 'texto'     },
  { campo: 'titulo',             tipo: 'texto'     },
  { campo: 'status',             tipo: 'lista', opcoes: STATUS_OPCOES },
  { campo: 'prioridade',         tipo: 'lista', opcoes: PRIORIDADE_OPCOES },
  { campo: 'prazo',              tipo: 'data'      },
  { campo: 'descricao',          tipo: 'texto'     },
  { campo: 'criado_em',          tipo: 'data_hora' },
  { campo: 'atualizado_em',      tipo: 'data_hora' },
  { campo: 'aguardando_cliente', tipo: 'booleano'  },
  { campo: 'prazo_cliente',      tipo: 'data'      },
  { campo: 'pendencia_cliente',  tipo: 'texto'     },
  { campo: 'delegado_para',      tipo: 'texto'     },  // FK multivalor: ids separados por vírgula
  { campo: 'origem_id',          tipo: 'texto'     },
  // O–Q entraram depois. Ficam no fim porque a guarda de cabeçalho só aceita acréscimo
  // à direita; inserir no meio realinharia rótulo sobre dado. Ver `01`.
  // Carimbadas na transição de status — ver CARIMBO_DE_STATUS na camada.
  { campo: 'data_inicio',        tipo: 'data'      },
  { campo: 'data_conclusao',     tipo: 'data'      },
  { campo: 'data_delegacao',     tipo: 'data'      },
];

const COLUNAS_PESSOAS = [
  { campo: 'id',              tipo: 'texto'     },
  { campo: 'notion_id',       tipo: 'texto'     },
  { campo: 'nome',            tipo: 'texto'     },
  { campo: 'nivel',           tipo: 'lista', opcoes: NIVEL_OPCOES },
  { campo: 'data_ultimo_1a1', tipo: 'data'      },
  { campo: 'criado_em',       tipo: 'data_hora' },
  { campo: 'atualizado_em',   tipo: 'data_hora' },
  // H entrou depois, e fica no fim pelo mesmo motivo das O–Q do Kanban: a guarda de
  // cabeçalho só aceita acréscimo à direita.
  //
  // ATENÇÃO ao rodar o setup numa aba que já tem gente: booleano vazio volta `false` do
  // mapeador, então as linhas existentes nascem INATIVAS e o time inteiro some das telas.
  // Marcar as caixas à mão é o passo seguinte ao setup, não algo para descobrir depois.
  { campo: 'ativo',           tipo: 'booleano'  },
];

const COLUNAS_ANOTACOES = [
  { campo: 'id',                  tipo: 'texto'     },
  { campo: 'notion_id',           tipo: 'texto'     },
  { campo: 'pessoa_id',           tipo: 'texto'     },  // FK → Pessoas.id, escalar
  { campo: 'nota',                tipo: 'texto'     },
  { campo: 'tipo',                tipo: 'lista', opcoes: TIPO_NOTA_OPCOES },
  { campo: 'contexto',            tipo: 'texto'     },
  { campo: 'data',                tipo: 'data'      },
  { campo: 'criado_em',           tipo: 'data_hora' },
  { campo: 'atualizado_em',       tipo: 'data_hora' },
  // EMPRESA em quatro booleanas: 40% das notas têm 2 ou 3 valores, e filtrar por um deles é
  // a operação comum. Em célula única com separador isso viraria SEARCH em texto.
  { campo: 'valor_autogestao',    tipo: 'booleano'  },
  { campo: 'valor_colaboracao',   tipo: 'booleano'  },
  { campo: 'valor_qualidade',     tipo: 'booleano'  },
  { campo: 'valor_transparencia', tipo: 'booleano'  },
  { campo: 'origem_id',           tipo: 'texto'     },
];

/**
 * Colunas da aba `Notas` — o recado solto.
 *
 * **NÃO é a aba Anotações, e a diferença é a razão de existirem duas.** `Anotações` é
 * feedback: tem `tipo` (positivo/melhoria) e os quatro `valor_*`, porque é material de 1:1 e
 * carrega juízo. `Notas` não tem nem um nem outro, porque não julga nada.
 *
 * O caso que separa as duas, nas palavras dele: *"colaborador Gustavo comentou que estava
 * cansado"* — informação verdadeira, útil, e que **não é feedback**. Registrá-la como
 * anotação a obrigaria a nascer positiva ou de melhoria, e a apareceria num compilado de
 * 1:1 como se fosse avaliação. Seria uma classificação inventada sobre uma frase que ninguém
 * classificou, que é exatamente o que o `tipo` sem default existe para evitar do outro lado.
 *
 * As duas FKs são **opcionais e independentes**: a nota pode não ter nenhuma ("lembrar de
 * revisar o processo de deploy"), só pessoa, só card, ou as duas ("Pessoa X gostaria de
 * participar da demanda A"). Nenhuma combinação é obrigatória.
 */
const COLUNAS_NOTAS = [
  { campo: 'id',            tipo: 'texto'     },
  { campo: 'texto',         tipo: 'texto'     },
  { campo: 'pessoa_id',     tipo: 'texto'     },  // FK → Pessoas.id, opcional, escalar
  { campo: 'card_id',       tipo: 'texto'     },  // FK → Kanban.id, opcional, escalar
  { campo: 'data',          tipo: 'data'      },
  // Nota lida e resolvida sai da lista sem sair da planilha. A alternativa — lista que só
  // cresce — deixa de servir para reler em dois meses, e apagar perderia o registro.
  { campo: 'arquivada',     tipo: 'booleano'  },
  { campo: 'criado_em',     tipo: 'data_hora' },
  { campo: 'atualizado_em', tipo: 'data_hora' },
  // Sem uso hoje: nenhuma skill escreve nota ainda. Fica porque "Gustavo comentou que estava
  // cansado" é exatamente uma frase de corredor, e o dia em que houver captura por voz a
  // dedupe do inbox depende desta coluna.
  { campo: 'origem_id',     tipo: 'texto'     },
];

/** Colunas da aba Log, na ordem do `02-camada-de-acesso`. */
const COLUNAS_LOG = [
  { campo: 'quando',    tipo: 'data_hora' },
  { campo: 'arquivo',   tipo: 'texto'     },
  { campo: 'origem_id', tipo: 'texto'     },
  { campo: 'tipo',      tipo: 'texto'     },
  { campo: 'resultado', tipo: 'texto'     },
  { campo: 'id_criado', tipo: 'texto'     },
  { campo: 'mensagem',  tipo: 'texto'     },
];

const FORMATO_DATA = 'dd/mm/yyyy';
const FORMATO_DATA_HORA = 'dd/mm/yyyy hh:mm:ss';

/**
 * Formato de texto puro nas colunas de texto.
 *
 * Sem ele, célula que começa com `-`, `=`, `+` ou `@` vira fórmula e o conteúdo se perde.
 * Não é hipótese: sete campos `contexto` do dump de Anotações começam com "- ", e
 * `descricao` de card corre o mesmo risco. Resolver no formato da coluna é melhor que
 * prefixar apóstrofo, que sujaria o valor e vazaria para toda leitura.
 */
const FORMATO_TEXTO = '@';

/** Largura em pixels por coluna. Só conforto de leitura; não é contrato. */
const LARGURAS = {
  id: 250,
  notion_id: 250,
  titulo: 320,
  status: 120,
  prioridade: 100,
  prazo: 110,
  descricao: 360,
  criado_em: 160,
  atualizado_em: 160,
  aguardando_cliente: 150,
  prazo_cliente: 120,
  pendencia_cliente: 280,
  delegado_para: 260,
  origem_id: 250,
  data_inicio: 110,
  data_conclusao: 120,
  data_delegacao: 120,
};

const LARGURAS_PESSOAS = {
  id: 250,
  notion_id: 250,
  nome: 200,
  nivel: 120,
  data_ultimo_1a1: 140,
  criado_em: 160,
  atualizado_em: 160,
  ativo: 70,
};

const LARGURAS_ANOTACOES = {
  id: 250,
  notion_id: 250,
  pessoa_id: 250,
  nota: 420,
  tipo: 100,
  contexto: 520,
  data: 110,
  criado_em: 160,
  atualizado_em: 160,
  valor_autogestao: 120,
  valor_colaboracao: 120,
  valor_qualidade: 110,
  valor_transparencia: 130,
  origem_id: 250,
};

const LARGURAS_NOTAS = {
  id: 250,
  texto: 560,
  pessoa_id: 250,
  card_id: 250,
  data: 110,
  arquivada: 90,
  criado_em: 160,
  atualizado_em: 160,
  origem_id: 250,
};

const LARGURAS_LOG = {
  quando: 160,
  arquivo: 260,
  origem_id: 250,
  tipo: 90,
  resultado: 90,
  id_criado: 250,
  mensagem: 420,
};

/**
 * Cria (ou reconfigura) a aba `Kanban` na planilha ativa.
 *
 * Idempotente: toda operação abaixo é substituição, não acumulação — rodar duas vezes
 * converge no mesmo estado. Não apaga nenhuma aba, inclusive a "Página1".
 *
 * Aborta sem escrever nada se a aba já existir com dados sob um cabeçalho divergente.
 */
function setupKanban() {
  const sheet = provisionarAba_(TAB_NAME, COLUNAS, LARGURAS);
  avisarTimezone_(SpreadsheetApp.getActiveSpreadsheet());
  return sheet;
}

/** Cria (ou reconfigura) a aba `Pessoas`, âncora das FKs do sistema. */
function setupPessoas() {
  return provisionarAba_(PESSOAS_TAB_NAME, COLUNAS_PESSOAS, LARGURAS_PESSOAS);
}

/** Cria (ou reconfigura) a aba `Anotações`, o feedback por pessoa. */
function setupAnotacoes() {
  return provisionarAba_(ANOTACOES_TAB_NAME, COLUNAS_ANOTACOES, LARGURAS_ANOTACOES);
}

/** Cria (ou reconfigura) a aba `Notas`, o recado solto — que não é feedback. */
function setupNotas() {
  return provisionarAba_(NOTAS_TAB_NAME, COLUNAS_NOTAS, LARGURAS_NOTAS);
}

/** Cria (ou reconfigura) a aba `Log`, onde o processarInbox registra cada arquivo lido. */
function setupLog() {
  return provisionarAba_(LOG_TAB_NAME, COLUNAS_LOG, LARGURAS_LOG);
}

/**
 * Provisiona uma aba a partir do seu schema. As três abas passam por aqui.
 *
 * Idempotente: toda operação é substituição, não acumulação — rodar duas vezes converge no
 * mesmo estado. Não apaga aba nenhuma. Aborta sem escrever nada se a aba já existir com
 * dados sob um cabeçalho divergente (exceto acréscimo de coluna à direita, que passa).
 */
function provisionarAba_(nome, colunas, larguras) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('Planilha ativa: "%s"', ss.getName());

  const alvo = obterOuCriarAba_(ss, nome);
  const sheet = alvo.sheet;
  const cabecalho = colunas.map(function (c) { return c.campo; });

  // Guarda: nunca realinhar rótulos por cima de dados existentes.
  if (!alvo.nova) verificarCabecalhoCompativel_(sheet, cabecalho);

  ajustarGrade_(sheet, alvo.nova, cabecalho.length);
  escreverCabecalho_(sheet, cabecalho);

  // Corpo = tudo abaixo do cabeçalho, até o fim da grade. Cobrir a coluna inteira (e não
  // só as linhas já preenchidas) é o que faz a linha criada depois já nascer com dropdown,
  // checkbox e formato — sem a camada de acesso precisar reconfigurar a aba.
  const totalLinhas = sheet.getMaxRows() - 1;
  if (totalLinhas > 0) {
    sheet.getRange(2, 1, totalLinhas, cabecalho.length).clearDataValidations();
    aplicarValidacoes_(sheet, colunas, 2, totalLinhas);
    aplicarFormatos_(sheet, colunas, 2, totalLinhas);
  }

  aplicarLarguras_(sheet, colunas, larguras);

  Logger.log(
    'Aba "%s" OK — %s colunas, cabeçalho congelado, validações e formatos em %s linha(s).',
    nome, cabecalho.length, totalLinhas
  );
  return sheet;
}

/** A aba pelo nome, criando se faltar. `nova` diz qual dos dois casos foi. */
function obterOuCriarAba_(ss, nome) {
  const existente = ss.getSheetByName(nome);
  if (existente) {
    Logger.log('Aba "%s" já existe — reconfigurando.', nome);
    return { sheet: existente, nova: false };
  }
  Logger.log('Aba "%s" criada.', nome);
  return { sheet: ss.insertSheet(nome), nova: true };
}

function escreverCabecalho_(sheet, cabecalho) {
  sheet.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/**
 * Aborta se a aba tem dados no corpo e o cabeçalho não bate com o contrato.
 *
 * Sobrescrever nesse caso trocaria os rótulos sem mexer nos dados embaixo — corrupção
 * silenciosa. Aba vazia ou cabeçalho já correto passam direto.
 *
 * **Acréscimo de coluna à direita passa.** Ganhar uma coluna nova no fim (foi assim que
 * `origem_id` entrou) não move dado nenhum de lugar: as colunas que já existiam continuam
 * casando uma a uma, e a nova está vazia dos dois lados. Isso é migração de schema, e é
 * diferente de cabeçalho trocado — que continua abortando.
 */
function verificarCabecalhoCompativel_(sheet, cabecalho) {
  const linhasDeDados = contarLinhasComConteudo_(sheet);
  if (linhasDeDados < 1) return;

  const largura = Math.max(sheet.getLastColumn(), cabecalho.length);
  const atual = sheet.getRange(1, 1, 1, largura).getValues()[0]
    .map(function (v) { return String(v).trim(); });

  const divergencias = cabecalho
    .map(function (esperado, i) {
      return { coluna: i + 1, esperado: esperado, encontrado: atual[i] };
    })
    .filter(function (d) { return d.encontrado !== d.esperado; });

  if (divergencias.length === 0) return;

  if (soAcrescimoNoFim_(sheet, cabecalho, divergencias)) {
    Logger.log(
      'Aba "%s": coluna(s) nova(s) à direita — %s. O cabeçalho antigo casa até a coluna %s, ' +
      'e as novas estão vazias. Acrescentando sem tocar nas %s linha(s) de dados.',
      sheet.getName(),
      divergencias.map(function (d) { return d.esperado; }).join(', '),
      colunaParaLetra_(divergencias[0].coluna - 1),
      linhasDeDados
    );
    return;
  }

  const detalhe = divergencias
    .map(function (d) {
      return '  ' + colunaParaLetra_(d.coluna) + ': esperado "' + d.esperado +
             '", encontrado "' + (d.encontrado || '(vazio)') + '"';
    })
    .join('\n');

  throw new Error(
    'A aba "' + sheet.getName() + '" tem ' + linhasDeDados + ' linha(s) de dados sob um ' +
    'cabeçalho que não bate com o contrato. Reescrever o cabeçalho trocaria os rótulos sem ' +
    'mover os dados. Abortado — nada foi alterado.\n' +
    'Divergências:\n' + detalhe + '\n' +
    'Corrija o cabeçalho à mão (ou esvazie/renomeie a aba) e rode o setup de novo.'
  );
}

/**
 * As divergências são só colunas novas no fim do cabeçalho?
 *
 * Exige as três coisas ao mesmo tempo: formam um bloco contíguo, esse bloco termina na
 * última coluna esperada, e cada uma está vazia tanto no cabeçalho quanto no corpo. Se
 * houvesse dado embaixo de uma coluna sem rótulo, escrever o rótulo por cima daria a esse
 * dado um significado que ele não tem — então esse caso continua abortando.
 */
function soAcrescimoNoFim_(sheet, cabecalho, divergencias) {
  const primeira = divergencias[0].coluna;

  const contiguas = divergencias.every(function (d, k) { return d.coluna === primeira + k; });
  const terminaNoFim = divergencias[divergencias.length - 1].coluna === cabecalho.length;
  if (!contiguas || !terminaNoFim) return false;

  return divergencias.every(function (d) {
    return d.encontrado === '' && colunaVaziaNoCorpo_(sheet, d.coluna);
  });
}

function colunaVaziaNoCorpo_(sheet, coluna) {
  if (coluna > sheet.getMaxColumns()) return true;   // ainda nem existe na grade
  const corpo = sheet.getMaxRows() - 1;
  if (corpo < 1) return true;

  return sheet.getRange(2, coluna, corpo, 1).getValues().every(function (linha) {
    return linha[0] === '' || linha[0] === false || linha[0] === null;
  });
}

/**
 * Quantas linhas do corpo têm conteúdo de verdade.
 *
 * Não usa `getLastRow()`: as validações e formatos que esta função aplica no corpo inteiro
 * fazem o Sheets contar linha em branco como conteúdo, e `getLastRow()` passa a devolver o
 * fim da grade. Aqui a pergunta é sobre dado, então a resposta tem que vir do dado.
 *
 * Varre sem depender da ordem das colunas — o cabeçalho pode estar justamente errado.
 */
function contarLinhasComConteudo_(sheet) {
  const corpo = sheet.getMaxRows() - 1;
  if (corpo < 1) return 0;

  const valores = sheet.getRange(2, 1, corpo, sheet.getMaxColumns()).getValues();
  return valores.filter(function (linha) {
    return linha.some(function (v) { return v !== '' && v !== false && v !== null; });
  }).length;
}

/**
 * Garante que a grade comporta todas as colunas do schema. Apara as excedentes só quando a
 * aba acabou de ser criada — numa aba preexistente, o que estiver à direita pode ser seu.
 */
function ajustarGrade_(sheet, abaNova, totalColunas) {
  const atuais = sheet.getMaxColumns();
  if (atuais < totalColunas) {
    sheet.insertColumnsAfter(atuais, totalColunas - atuais);
  } else if (abaNova && atuais > totalColunas) {
    sheet.deleteColumns(totalColunas + 1, atuais - totalColunas);
  }
}

/**
 * Dropdown em toda coluna `lista` e checkbox em toda `booleano`, dirigido pelo schema.
 *
 * requireCheckbox() em vez de insertCheckboxes(): renderiza o mesmo checkbox nativo sem
 * escrever FALSE nas células vazias. insertCheckboxes() escreveria, inflando getLastRow()
 * até o fim da grade e fazendo a leitura enxergar centenas de linhas fantasma.
 */
function aplicarValidacoes_(sheet, colunas, linhaInicial, totalLinhas) {
  colunas.forEach(function (c, i) {
    let validacao = null;

    if (c.tipo === 'lista') {
      if (!c.opcoes) throw new Error('Coluna "' + c.campo + '" é lista e não declarou opcoes.');
      validacao = SpreadsheetApp.newDataValidation()
        .requireValueInList(c.opcoes, true)
        .setAllowInvalid(false)
        .build();
    } else if (c.tipo === 'booleano') {
      validacao = SpreadsheetApp.newDataValidation()
        .requireCheckbox()
        .setAllowInvalid(false)
        .build();
    }

    if (validacao) {
      sheet.getRange(linhaInicial, i + 1, totalLinhas, 1).setDataValidation(validacao);
    }
  });
}

/** Formato numérico derivado do `tipo` do schema. Texto também ganha o seu — ver FORMATO_TEXTO. */
function aplicarFormatos_(sheet, colunas, linhaInicial, totalLinhas) {
  colunas.forEach(function (c, i) {
    let formato = null;
    if (c.tipo === 'data') formato = FORMATO_DATA;
    else if (c.tipo === 'data_hora') formato = FORMATO_DATA_HORA;
    else if (c.tipo === 'texto') formato = FORMATO_TEXTO;
    if (!formato) return;
    sheet.getRange(linhaInicial, i + 1, totalLinhas, 1).setNumberFormat(formato);
  });
}

function aplicarLarguras_(sheet, colunas, larguras) {
  colunas.forEach(function (c, i) {
    const largura = larguras[c.campo];
    if (largura) sheet.setColumnWidth(i + 1, largura);
  });
}

/**
 * Avisa se a timezone da planilha divergir da do script. Não corrige — mudar configuração
 * da planilha é decisão sua. Importa porque `criado_em`/`atualizado_em` são carimbados pelo
 * script e exibidos pela planilha.
 */
function avisarTimezone_(ss) {
  const tzPlanilha = ss.getSpreadsheetTimeZone();
  const tzScript = Session.getScriptTimeZone();
  if (tzPlanilha !== tzScript) {
    Logger.log(
      'AVISO: timezone da planilha ("%s") difere da do script ("%s"). As datas carimbadas ' +
      'pela camada de acesso vão aparecer defasadas na aba.',
      tzPlanilha, tzScript
    );
  }
}

/**
 * Índice 1-based da coluna de um campo dentro de um schema. Ninguém indexa coluna por
 * número solto — mudar a ordem no schema reordena tudo que depende dela de graça.
 */
function colunaDe_(colunas, campo) {
  const i = colunas.findIndex(function (c) { return c.campo === campo; });
  if (i === -1) throw new Error('Campo não declarado no schema: ' + campo);
  return i + 1;
}

/** A declaração de um campo dentro de um schema, ou undefined. */
function colunaPorCampo_(colunas, campo) {
  return colunas.filter(function (c) { return c.campo === campo; })[0];
}

/** 1 → "A", 27 → "AA". Só para mensagens de erro legíveis. */
function colunaParaLetra_(n) {
  let letra = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    n = (n - resto - 1) / 26;
  }
  return letra;
}
