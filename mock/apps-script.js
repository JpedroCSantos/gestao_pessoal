'use strict';

/**
 * Dublês dos serviços do Apps Script, em memória.
 *
 * Só implementam o que o projeto realmente usa. Quando algo novo for chamado, o teste
 * quebra com "not a function" — que é o aviso certo para estender daqui, e não um `undefined`
 * silencioso passando por válido.
 *
 * A planilha fake replica dois comportamentos do Sheets que o projeto depende de conhecer:
 * célula nunca escrita devolve `''` (nunca `null`), e o grid tem tamanho fixo que só cresce
 * por `insertRowsAfter`.
 */

function criarSheet(nome, maxRows, maxCols) {
  let linhas = maxRows;
  let colunas = maxCols;
  const celulas = matriz(linhas, colunas);

  // Registrados para inspeção nos testes; o Sheets de verdade os aplica de fato.
  const formatos = {};      // "linha,coluna" -> string
  const validacoes = {};    // "linha,coluna" -> objeto de validação
  const larguras = {};      // coluna -> px
  let congeladas = 0;

  function matriz(nr, nc) {
    return Array.from({ length: nr }, () => Array.from({ length: nc }, () => ''));
  }

  function exigirDentroDoGrid(l, c, nl, nc) {
    if (l < 1 || c < 1 || nl < 1 || nc < 1) {
      throw new Error(`getRange fora de faixa: (${l},${c},${nl},${nc})`);
    }
    if (l + nl - 1 > linhas || c + nc - 1 > colunas) {
      throw new Error(
        `getRange excede o grid ${linhas}x${colunas}: pediu até (${l + nl - 1},${c + nc - 1})`
      );
    }
  }

  const sheet = {
    getName: () => nome,
    getMaxRows: () => linhas,
    getMaxColumns: () => colunas,

    // getLastRow do Sheets conta linha "com conteúdo" — e o projeto sabe que validação e
    // formato aplicados em massa inflam esse número. Reproduzimos a versão honesta (última
    // linha com valor); os testes que importam não dependem dela, justamente por isso.
    getLastRow() {
      for (let l = linhas - 1; l >= 0; l--) {
        if (celulas[l].some((v) => v !== '' && v !== null && v !== undefined)) return l + 1;
      }
      return 0;
    },
    getLastColumn() {
      for (let c = colunas - 1; c >= 0; c--) {
        if (celulas.some((linha) => linha[c] !== '' && linha[c] !== null)) return c + 1;
      }
      return 0;
    },

    getRange(l, c, nl = 1, nc = 1) {
      exigirDentroDoGrid(l, c, nl, nc);
      const range = {
        getValues: () =>
          Array.from({ length: nl }, (_, i) => celulas[l - 1 + i].slice(c - 1, c - 1 + nc)),
        getValue: () => celulas[l - 1][c - 1],
        setValues(valores) {
          if (valores.length !== nl || valores.some((linha) => linha.length !== nc)) {
            throw new Error(
              `setValues com dimensão errada: range é ${nl}x${nc}, recebeu ` +
              `${valores.length}x${valores[0] ? valores[0].length : 0}`
            );
          }
          valores.forEach((linha, i) =>
            linha.forEach((v, j) => { celulas[l - 1 + i][c - 1 + j] = v; })
          );
          return range;
        },
        setNumberFormat(f) {
          percorrer((li, ci) => { formatos[`${li},${ci}`] = f; });
          return range;
        },
        setDataValidation(v) {
          percorrer((li, ci) => { validacoes[`${li},${ci}`] = v; });
          return range;
        },
        clearDataValidations() {
          percorrer((li, ci) => { delete validacoes[`${li},${ci}`]; });
          return range;
        },
        setFontWeight: () => range,
      };
      function percorrer(fn) {
        for (let i = 0; i < nl; i++) for (let j = 0; j < nc; j++) fn(l + i, c + j);
      }
      return range;
    },

    insertRowsAfter(depois, quantas) {
      for (let i = 0; i < quantas; i++) {
        celulas.splice(depois + i, 0, Array.from({ length: colunas }, () => ''));
      }
      linhas += quantas;
      return sheet;
    },
    insertColumnsAfter(depois, quantas) {
      celulas.forEach((linha) => {
        for (let i = 0; i < quantas; i++) linha.splice(depois + i, 0, '');
      });
      colunas += quantas;
      return sheet;
    },
    deleteColumns(aPartirDe, quantas) {
      celulas.forEach((linha) => linha.splice(aPartirDe - 1, quantas));
      colunas -= quantas;
      return sheet;
    },

    setFrozenRows(n) { congeladas = n; return sheet; },
    setColumnWidth(c, px) { larguras[c] = px; return sheet; },

    // Portas para os testes espiarem o que o setup montou.
    _celulas: celulas,
    _formatos: formatos,
    _validacoes: validacoes,
    _larguras: larguras,
    _congeladas: () => congeladas,
  };
  return sheet;
}

function criarSpreadsheet({ nome = 'Gestão', tz = 'America/Sao_Paulo' } = {}) {
  const abas = [];
  return {
    getName: () => nome,
    getId: () => 'ss-fake',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/ss-fake',
    getSpreadsheetTimeZone: () => tz,
    getSheets: () => abas.slice(),
    getSheetByName: (n) => abas.filter((a) => a.getName() === n)[0] || null,
    insertSheet(n, maxRows = 1000, maxCols = 26) {
      const sheet = criarSheet(n, maxRows, maxCols);
      abas.push(sheet);
      return sheet;
    },
  };
}

function criarPasta(nome, mae) {
  const arquivos = [];
  const subpastas = [];
  const pasta = {
    getName: () => nome,
    getId: () => 'pasta-' + nome,
    getUrl: () => 'https://drive.fake/pasta-' + nome,
    getFiles: () => iterador(arquivos.slice()),
    getFilesByName: (n) => iterador(arquivos.filter((f) => f.getName() === n)),
    getFolders: () => iterador(subpastas.slice()),
    getParents: () => iterador(mae ? [mae] : []),
    createFile(nomeArquivo, conteudo) {
      return criarArquivo(nomeArquivo, conteudo, pasta);
    },
    _arquivos: arquivos,
    _subpastas: subpastas,
  };
  if (mae) mae._subpastas.push(pasta);
  return pasta;
}

/** Índice global id→arquivo, para o DriveApp.getFileById do dublê. */
const arquivosPorId = {};

function criarArquivo(nome, conteudo, pasta) {
  let id = 'file-' + (criarArquivo.seq = (criarArquivo.seq || 0) + 1);
  let atual = pasta;
  const file = {
    getId: () => id,
    getName: () => nome,
    getUrl: () => 'https://drive.fake/' + id,
    getLastUpdated: () => new Date(2026, 0, 1),
    getParents: () => iterador([atual]),
    getBlob: () => ({ getDataAsString: () => conteudo }),
    moveTo(destino) {
      const i = atual._arquivos.indexOf(file);
      if (i >= 0) atual._arquivos.splice(i, 1);
      destino._arquivos.push(file);
      atual = destino;
      return file;
    },
    setTrashed() {
      const i = atual._arquivos.indexOf(file);
      if (i >= 0) atual._arquivos.splice(i, 1);
      return file;
    },
    _pasta: () => atual,
    _conteudo: () => conteudo,
  };
  pasta._arquivos.push(file);
  arquivosPorId[id] = file;
  return file;
}

function iterador(itens) {
  let i = 0;
  return { hasNext: () => i < itens.length, next: () => itens[i++] };
}

/**
 * Formatação de data compatível com os padrões que o projeto usa.
 *
 * Lista fechada, e não um formatador de verdade: cada padrão entra aqui quando o projeto
 * passa a usá-lo. Padrão desconhecido **levanta erro** em vez de devolver algo parecido —
 * foi assim que `HH:mm` apareceu, quando a agenda entrou: o formato antigo casava por
 * `includes('HH')` e devolvia data e hora completas, e a coluna saiu com `NaN:NaN`.
 */
function formatDate(data, tz, formato) {
  const p = (n) => String(n).padStart(2, '0');
  const dia = `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}`;
  const hhmm = `${p(data.getHours())}:${p(data.getMinutes())}`;

  if (formato === 'yyyy-MM-dd') return dia;
  if (formato === "yyyy-MM-dd'T'HH:mm:ss") return `${dia}T${hhmm}:${p(data.getSeconds())}`;
  if (formato === 'HH:mm') return hhmm;
  if (formato === 'dd/MM/yyyy' || formato === 'dd/mm/yyyy') {
    return `${p(data.getDate())}/${p(data.getMonth() + 1)}/${data.getFullYear()}`;
  }

  throw new Error(
    `formatDate: o dublê não conhece o padrão "${formato}". Acrescente-o em ` +
    'mock/apps-script.js — devolver algo aproximado transformaria o teste em decoração.'
  );
}

/**
 * Monta os globais que o projeto espera.
 *
 * @param {Object} opcoes
 * @param {boolean} opcoes.lockOcupado  faz todo tryLock devolver false
 * @param {Object}  opcoes.propriedades Script Properties iniciais
 * @param {Object}  opcoes.pastas       nome → pasta fake, para o DriveApp
 */
function criarAmbiente(opcoes = {}) {
  const ss = criarSpreadsheet(opcoes);
  const logs = [];
  const propriedades = Object.assign({}, opcoes.propriedades);
  const pastasPorId = {};
  /* Registra a pasta e as subpastas dela: o getFolderById precisa achar qualquer uma, e
     a estrutura de Resumos é raiz → pessoa → Docs. */
  const registrar = (p) => {
    pastasPorId[p.getId()] = p;
    (p._subpastas || []).forEach(registrar);
  };
  Object.values(opcoes.pastas || {}).forEach(registrar);

  let seqUuid = 0;
  const travas = [];
  const triggers = [];

  const ambiente = {
    Logger: {
      // Interpola %s como o Logger de verdade: sem isso os logs saem com o formato de um
      // lado e os valores do outro, e um assert sobre a mensagem vira loteria.
      log(formato, ...args) {
        let i = 0;
        const texto = String(formato).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s'));
        logs.push([texto].concat(args.slice(i).map(String)).join(' '));
      },
    },
    Utilities: {
      getUuid: () => `uuid-${String(++seqUuid).padStart(4, '0')}`,
      formatDate,
    },
    Session: { getScriptTimeZone: () => ss.getSpreadsheetTimeZone() },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush() {},
      newDataValidation() {
        const regra = { tipo: null, opcoes: null, permiteInvalido: true };
        const builder = {
          requireValueInList(lista) { regra.tipo = 'lista'; regra.opcoes = lista; return builder; },
          requireCheckbox() { regra.tipo = 'checkbox'; return builder; },
          setAllowInvalid(b) { regra.permiteInvalido = b; return builder; },
          build: () => regra,
        };
        return builder;
      },
    },
    LockService: {
      getScriptLock: () => criarLock('script'),
      getUserLock: () => criarLock('user'),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in propriedades ? propriedades[k] : null),
        setProperty(k, v) { propriedades[k] = v; return this; },
      }),
    },
    DriveApp: {
      getFolderById(id) {
        if (!pastasPorId[id]) throw new Error(`pasta inexistente: ${id}`);
        return pastasPorId[id];
      },
      getFileById(id) {
        if (!arquivosPorId[id]) throw new Error(`arquivo inexistente: ${id}`);
        return arquivosPorId[id];
      },
    },
    // O corpo do "Doc" é o conteúdo com que o arquivo fake foi criado. Basta para o que o
    // projeto faz com ele: ler o texto inteiro e devolver.
    DocumentApp: {
      openById(id) {
        if (!arquivosPorId[id]) throw new Error(`documento inexistente: ${id}`);
        return { getBody: () => ({ getText: () => arquivosPorId[id]._conteudo() }) };
      },
    },
    // Dublê raso de propósito: o que o projeto faz com HTML é escolher *qual* conteúdo
    // servir, e é isso que os testes afirmam. Renderização é do Google.
    HtmlService: {
      createHtmlOutput(conteudo) {
        const saida = {
          _conteudo: conteudo,
          _titulo: '',
          getContent: () => conteudo,
          getTitle: () => saida._titulo,
          setTitle(t) { saida._titulo = t; return saida; },
          addMetaTag() { return saida; },
        };
        return saida;
      },
      createTemplateFromFile(nome) {
        return { evaluate: () => ambiente.HtmlService.createHtmlOutput(`<template:${nome}>`) };
      },
    },
    // Guarda os triggers de verdade: sem isso, `getProjectTriggers` devolvia sempre vazio e
    // nenhuma configuração completa podia passar no verificarConfiguracao — nem a duplicação
    // que o instalarTriggers existe para normalizar podia ser exercitada.
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      newTrigger: (funcao) => ({
        timeBased: () => ({
          everyMinutes: (min) => ({
            create() {
              const t = { getHandlerFunction: () => funcao, _minutos: min };
              triggers.push(t);
              return t;
            },
          }),
        }),
      }),
      deleteTrigger(t) {
        const i = triggers.indexOf(t);
        if (i >= 0) triggers.splice(i, 1);
      },
    },
    MimeType: { PLAIN_TEXT: 'text/plain' },

    /**
     * Agenda dublê. Recebe os eventos por `opcoes.eventos`, cada um como
     * `{ titulo, inicio, fim, diaInteiro, status, local }` — `inicio`/`fim` são Date.
     *
     * `getEventsForDay` filtra pelo dia de verdade, e não devolve a lista inteira: é assim
     * que o projeto se comporta contra o Calendar real, e um dublê que ignora a data
     * esconderia um filtro faltando no código.
     */
    CalendarApp: {
      GuestStatus: {
        YES: 'YES', NO: 'NO', MAYBE: 'MAYBE', INVITED: 'INVITED', OWNER: 'OWNER',
      },
      getDefaultCalendar: () => ({
        getName: () => 'agenda principal',
        getEventsForDay(data) {
          return (opcoes.eventos || [])
            .filter((e) => mesmoDia(e.inicio, data))
            .map(criarEvento);
        },
      }),
    },
  };

  function mesmoDia(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function criarLock(tipo) {
    return {
      tryLock(ms) {
        if (opcoes.lockOcupado) return false;
        travas.push(tipo);
        return true;
      },
      releaseLock() { travas.pop(); },
    };
  }

  ambiente._ss = ss;
  ambiente._logs = logs;
  ambiente._propriedades = propriedades;
  ambiente._travasAbertas = () => travas.length;
  return ambiente;
}

/**
 * Um evento de agenda dublê.
 *
 * `getMyStatus` levanta erro quando o evento não tem convidado, como o CalendarApp de
 * verdade faz — é o caso que o `recusado_()` precisa engolir sem excluir o compromisso.
 */
function criarEvento(dados) {
  return {
    getTitle: () => dados.titulo,
    getStartTime: () => dados.inicio,
    getEndTime: () => dados.fim,
    isAllDayEvent: () => dados.diaInteiro === true,
    getLocation: () => dados.local || '',
    getMyStatus() {
      if (!dados.status) throw new Error('evento sem convidados');
      return dados.status;
    },
  };
}

module.exports = {
  criarAmbiente, criarSpreadsheet, criarSheet, criarPasta, criarArquivo, criarEvento,
};
