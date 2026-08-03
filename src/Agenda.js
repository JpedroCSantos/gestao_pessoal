/**
 * A agenda do dia. Contrato em models/04-front-end.md.
 *
 * `CalendarApp` é serviço embutido do Apps Script, como `SpreadsheetApp` e `DriveApp` — a
 * conexão com a agenda não abriu porta nenhuma na stack: sem GCP, sem API externa, sem token
 * para guardar.
 *
 * **Aqui só se lê.** O app nunca cria, move nem apaga compromisso: quem manda na agenda é o
 * Google Calendar, e esta tela é uma leitura dela. Ver a nota de escopo no DEPLOY.
 *
 * O produto desta função não é a lista de reuniões — isso o Calendar já dá melhor. É a
 * **ocupação do dia ao lado da fila do dia**: onde o trabalho cabe. Por isso ela devolve os
 * `vaos` calculados, e não só os eventos.
 */

/** Janela padrão da linha do tempo, em minutos desde a meia-noite. Estica para caber evento fora dela. */
const JORNADA_INICIO = 8 * 60;   // 08:00
const JORNADA_FIM = 19 * 60;     // 19:00

/**
 * Vão curto não é bloco de trabalho.
 *
 * 30 minutos é o mínimo em que faz sentido dizer "cabe aqui". Abaixo disso o intervalo entre
 * duas reuniões é respiro, e anunciá-lo como espaço livre transformaria a coluna num
 * conselho ruim.
 */
const VAO_MINIMO = 30;

/**
 * Os compromissos de hoje, no formato de transporte.
 *
 * @return {{data: string, agora: string, agoraMin: number, inicioMin: number, fimMin: number,
 *           diaInteiro: Object[], eventos: Object[], vaos: Object[], ocupadoMin: number}}
 * @throws Error com mensagem explicativa se a agenda não estiver acessível.
 */
function listAgenda() {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const agora = new Date();

  const brutos = eventosDeHoje_(agora);

  const diaInteiro = [];
  const eventos = [];

  brutos.forEach(function (ev) {
    // Recusado não ocupa o dia. Mesmo raciocínio do card travado no cliente: gastar espaço
    // com o que não vai acontecer é ruído, e aqui o ruído empurra o que importa para baixo.
    if (recusado_(ev)) return;

    if (ev.isAllDayEvent()) {
      diaInteiro.push({ titulo: tituloDe_(ev) });
      return;
    }

    const inicio = minutosDe_(ev.getStartTime(), tz);
    const fim = minutosDe_(ev.getEndTime(), tz);

    eventos.push({
      titulo: tituloDe_(ev),
      local: localDe_(ev),
      inicio: horaDeMinutos_(inicio),
      fim: horaDeMinutos_(fim),
      inicioMin: inicio,
      // Evento que atravessa a meia-noite chegaria com fim menor que início e viraria uma
      // barra de largura negativa. Trunca no fim do dia — é o que a tela do dia comporta.
      fimMin: fim > inicio ? fim : 24 * 60,
    });
  });

  eventos.sort(function (a, b) { return a.inicioMin - b.inicioMin || a.fimMin - b.fimMin; });

  const ocupado = mesclarIntervalos_(eventos);
  const janela = janelaDoDia_(eventos);
  const agoraMin = minutosDe_(agora, tz);

  return {
    data: Utilities.formatDate(agora, tz, ISO_DATA),
    agora: horaDeMinutos_(agoraMin),
    agoraMin: agoraMin,
    inicioMin: janela.inicio,
    fimMin: janela.fim,
    diaInteiro: diaInteiro,
    eventos: distribuirColunas_(eventos),
    vaos: vaosDe_(ocupado, janela),
    ocupadoMin: ocupado.reduce(function (soma, i) { return soma + (i.fim - i.inicio); }, 0),
  };
}

/**
 * Os eventos de hoje da agenda principal.
 *
 * Só a principal, por decisão: agenda de time assinada entraria com compromisso que não é
 * dele e a coluna deixaria de responder "onde eu tenho espaço".
 *
 * A recorrência já vem expandida em instâncias pelo `getEventsForDay` — não há regra de
 * repetição para interpretar aqui.
 */
function eventosDeHoje_(agora) {
  let calendario;
  try {
    calendario = CalendarApp.getDefaultCalendar();
  } catch (err) {
    const original = err && err.message ? err.message : String(err);

    /* Falta de escopo é o caso comum aqui, e a mensagem crua do Google não diz o que fazer.
       O detalhe que importa: **o Web App não pede autorização.** A tela de consentimento não
       pode aparecer dentro dele, então a implantação roda com o que foi autorizado antes e
       simplesmente falha. Quem dispara o pedido é o editor. */
    if (/permission|autoriza|scope|escopo/i.test(original)) {
      throw new Error(
        'A agenda existe, mas esta implantação não tem autorização para lê-la. O Web App ' +
        'nunca pede autorização — a tela de consentimento só aparece no editor. Abra o ' +
        'editor do Apps Script, rode a função listAgenda uma vez, aceite o acesso ao ' +
        'Calendar, e recarregue esta página. Republicar sozinho não resolve. ' +
        '(Original: ' + original + ')'
      );
    }

    throw new Error('Não foi possível abrir a agenda: ' + original);
  }

  if (!calendario) {
    throw new Error('A conta não tem agenda principal acessível.');
  }
  return calendario.getEventsForDay(agora);
}

/**
 * O convidado recusou?
 *
 * Só exclui quando a recusa é explícita. Evento sem convidados não tem `GuestStatus` útil, e
 * tratar a ausência de resposta como recusa esconderia justamente o compromisso que ele
 * ainda não confirmou.
 */
function recusado_(ev) {
  try {
    return ev.getMyStatus() === CalendarApp.GuestStatus.NO;
  } catch (err) {
    return false;
  }
}

function tituloDe_(ev) {
  const titulo = texto_(ev.getTitle());
  return titulo || '(sem título)';
}

function localDe_(ev) {
  try {
    return texto_(ev.getLocation());
  } catch (err) {
    return '';
  }
}

/** Minutos desde a meia-noite, no fuso da planilha — o mesmo que o mapeador usa. */
function minutosDe_(data, tz) {
  const hhmm = Utilities.formatDate(data, tz, 'HH:mm').split(':');
  return Number(hhmm[0]) * 60 + Number(hhmm[1]);
}

function horaDeMinutos_(minutos) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(minutos)));
  const dois = function (n) { return (n < 10 ? '0' : '') + n; };
  return dois(Math.floor(m / 60)) + ':' + dois(m % 60);
}

/**
 * A janela que a linha do tempo desenha: a jornada padrão, esticada para caber o que ficou
 * fora dela.
 *
 * Recortar na jornada faria uma reunião das 7h desaparecer da tela — e reunião fora do
 * horário é justamente a que alguém precisa ver.
 */
function janelaDoDia_(eventos) {
  let inicio = JORNADA_INICIO;
  let fim = JORNADA_FIM;

  eventos.forEach(function (e) {
    if (e.inicioMin < inicio) inicio = Math.floor(e.inicioMin / 30) * 30;
    if (e.fimMin > fim) fim = Math.ceil(e.fimMin / 30) * 30;
  });

  return { inicio: inicio, fim: fim };
}

/**
 * Une os intervalos que se sobrepõem, para o cálculo de ocupação.
 *
 * Agenda real tem reunião em cima de reunião. Sem mesclar, duas das 10h às 11h contariam
 * como duas horas ocupadas e o vão seguinte sairia errado.
 */
function mesclarIntervalos_(eventos) {
  const unidos = [];

  eventos.forEach(function (e) {
    const ultimo = unidos[unidos.length - 1];
    if (ultimo && e.inicioMin <= ultimo.fim) {
      ultimo.fim = Math.max(ultimo.fim, e.fimMin);
      return;
    }
    unidos.push({ inicio: e.inicioMin, fim: e.fimMin });
  });

  return unidos;
}

/** Os buracos da janela que dão para trabalhar. */
function vaosDe_(ocupado, janela) {
  const vaos = [];
  let cursor = janela.inicio;

  ocupado.forEach(function (i) {
    if (i.inicio - cursor >= VAO_MINIMO) {
      vaos.push(vao_(cursor, i.inicio));
    }
    cursor = Math.max(cursor, i.fim);
  });

  if (janela.fim - cursor >= VAO_MINIMO) vaos.push(vao_(cursor, janela.fim));
  return vaos;
}

function vao_(inicio, fim) {
  return {
    inicio: horaDeMinutos_(inicio),
    fim: horaDeMinutos_(fim),
    inicioMin: inicio,
    fimMin: fim,
    minutos: fim - inicio,
  };
}

/**
 * Reparte a largura entre eventos que se sobrepõem.
 *
 * Sem isto, duas reuniões no mesmo horário desenham uma em cima da outra e a de baixo
 * simplesmente não existe na tela. Cada grupo de sobreposição recebe `colunas`, e cada
 * evento a sua `coluna` — o desenho divide a faixa por esses dois números.
 */
function distribuirColunas_(eventos) {
  let grupo = [];
  let fimDoGrupo = -1;

  const fechar = function () {
    grupo.forEach(function (e, i) { e.coluna = i; e.colunas = grupo.length; });
    grupo = [];
  };

  eventos.forEach(function (e) {
    if (grupo.length && e.inicioMin >= fimDoGrupo) fechar();
    grupo.push(e);
    fimDoGrupo = Math.max(fimDoGrupo, e.fimMin);
  });
  fechar();

  return eventos;
}
