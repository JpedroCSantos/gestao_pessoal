'use strict';

/**
 * Dados sintéticos para a execução local.
 *
 * **Nada aqui é real.** Nomes, cards e feedbacks são inventados; a planilha de verdade tem
 * observações nominais sobre pessoas do time e não sai da conta do Google.
 *
 * O que é copiado do real é a **forma**, porque é ela que faz a demonstração significar
 * alguma coisa: ~20 cards ativos contra ~15 concluídos (a coluna Done é a que só cresce),
 * a maioria em `Not started` sem `data_inicio` (é o que justifica a barra de espera do
 * Gantt), prazos espalhados em volta de hoje, e uma pessoa inativa para a flag aparecer.
 *
 * **As datas são relativas a hoje**, e não fixas: com datas cravadas, a tela Hoje ficaria
 * vazia no mês seguinte e a demonstração morreria sozinha.
 */

const MS_DIA = 86400000;

/** Hoje à meia-noite local — a mesma âncora que a camada usa. */
function hoje() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** `dias` a partir de hoje (negativo = passado), como Date à meia-noite. */
function dia(dias) {
  return new Date(hoje().getTime() + dias * MS_DIA);
}

/** Como `dia`, mas com hora — para os carimbos de `criado_em`/`atualizado_em`. */
function instante(dias, hora = 9) {
  const d = dia(dias);
  d.setHours(hora, 30, 0, 0);
  return d;
}

const PESSOAS = [
  { nome: 'Ana Ribeiro',    nivel: 'SE',         ativo: true,  ultimo1a1: -12 },
  { nome: 'Bruno Tavares',  nivel: 'Trainee SE', ativo: true,  ultimo1a1: -40 },
  { nome: 'Camila Nunes',   nivel: 'SE',         ativo: true,  ultimo1a1: -5  },
  { nome: 'Diego Fontes',   nivel: 'Trainee SE', ativo: true,  ultimo1a1: null },
  { nome: 'Elisa Moraes',   nivel: 'TTL',        ativo: true,  ultimo1a1: -25 },
  { nome: 'Rafael Pinto',   nivel: 'Trainee SE', ativo: true,  ultimo1a1: -60 },
  // Trocou de projeto: é quem demonstra a coluna `ativo`. O histórico dele continua na
  // planilha, e o card que ainda está com ele continua aparecendo no board.
  { nome: 'Sofia Duarte',   nivel: 'SE',         ativo: false, ultimo1a1: -33 },
];

/**
 * Os cards. `inicio` só existe em quem passou por In progress — é a assimetria que faz o
 * Gantt ter dois segmentos.
 *
 * @typedef {{titulo, status, prioridade, nasceu, prazo, inicio?, fim?, delegados?,
 *            cliente?, prazoCliente?, pendencia?, descricao?}} Semente
 */
const CARDS = [
  // --- vencidos: é o que a tela Hoje precisa ter para o veredito não ser vazio ---
  { titulo: 'Fechar o inventário de integrações do cliente Aurora', status: 'In progress',
    prioridade: 'Alta', nasceu: -34, prazo: -6, inicio: -20,
    descricao: 'Levantar tudo que passa pelo barramento antes da migração.' },
  { titulo: 'Revisar o contrato de dados do time de Faturamento', status: 'Not started',
    prioridade: 'Alta', nasceu: -22, prazo: -2 },
  { titulo: 'Ajustar o job de carga que quebra na virada do mês', status: 'In progress',
    prioridade: 'Alta', nasceu: -41, prazo: -13, inicio: -30 },

  // --- hoje e amanhã ---
  { titulo: 'Preparar a apresentação de resultados do trimestre', status: 'In progress',
    prioridade: 'Alta', nasceu: -11, prazo: 0, inicio: -4 },
  { titulo: 'Aprovar o desenho da nova esteira de deploy', status: 'Not started',
    prioridade: 'Média', nasceu: -8, prazo: 0 },
  { titulo: 'Responder o levantamento de acessos da auditoria', status: 'Not started',
    prioridade: 'Alta', nasceu: -5, prazo: 1 },

  // --- próximos dias ---
  { titulo: 'Escrever o runbook de incidente do serviço de notas', status: 'Not started',
    prioridade: 'Média', nasceu: -14, prazo: 3 },
  { titulo: 'Padronizar os nomes das filas do ambiente de homologação', status: 'Not started',
    prioridade: 'Baixa', nasceu: -26, prazo: 5 },
  { titulo: 'Migrar o relatório de capacidade para a base nova', status: 'In progress',
    prioridade: 'Média', nasceu: -19, prazo: 7, inicio: -3 },
  { titulo: 'Fechar o plano de férias do time', status: 'Not started',
    prioridade: 'Média', nasceu: -9, prazo: 9 },
  { titulo: 'Refazer o dashboard de SLA com os cortes novos', status: 'Not started',
    prioridade: 'Baixa', nasceu: -30, prazo: 14 },
  { titulo: 'Estudar a troca do agendador de rotinas', status: 'Not started',
    prioridade: 'Baixa', nasceu: -45, prazo: 21 },

  // --- delegados ---
  { titulo: 'Corrigir o cálculo de aging do painel gerencial', status: 'Delegado',
    prioridade: 'Alta', nasceu: -18, prazo: 4, delegados: ['Ana Ribeiro'], delegadoEm: -11 },
  { titulo: 'Documentar o fluxo de aprovação do portal', status: 'Delegado',
    prioridade: 'Média', nasceu: -24, prazo: 8, delegados: ['Bruno Tavares', 'Diego Fontes'],
    delegadoEm: -3 },
  // Delegado a quem já saiu do time: o board continua mostrando o nome, e é justamente
  // este card que precisa de outro dono.
  { titulo: 'Revisar as permissões do repositório de scripts', status: 'Delegado',
    prioridade: 'Média', nasceu: -37, prazo: 6, delegados: ['Sofia Duarte'], delegadoEm: -16 },
  { titulo: 'Levantar o custo do ambiente de testes', status: 'Delegado',
    prioridade: 'Baixa', nasceu: -20, prazo: 12, delegados: ['Camila Nunes'] },

  // --- travados no cliente: saem da fila do dia e aparecem só no bloco de cliente ---
  { titulo: 'Publicar a integração de notas fiscais', status: 'In progress',
    prioridade: 'Alta', nasceu: -28, prazo: -1, inicio: -15,
    cliente: true, prazoCliente: -4, pendencia: 'Retornar com o certificado do ambiente novo.' },
  { titulo: 'Homologar o novo layout de arquivo', status: 'Not started',
    prioridade: 'Média', nasceu: -16, prazo: 10,
    cliente: true, prazoCliente: 2, pendencia: 'Enviar a massa de teste com os casos de exceção.' },

  // --- sem prazo: ficam de fora do Gantt, e a tela declara que ficaram ---
  { titulo: 'Organizar a base de conhecimento do time', status: 'Not started',
    prioridade: 'Baixa', nasceu: -52 },
  { titulo: 'Avaliar ferramenta de catálogo de dados', status: 'Not started',
    prioridade: 'Baixa', nasceu: -33 },

  // --- concluídos: a coluna que só cresce, colapsada por padrão ---
  { titulo: 'Subir a correção do relatório de horas', status: 'Done', prioridade: 'Alta',
    nasceu: -40, prazo: -25, inicio: -33, fim: -24 },
  { titulo: 'Fechar o plano de capacidade do semestre', status: 'Done', prioridade: 'Média',
    nasceu: -60, prazo: -30, inicio: -50, fim: -31 },
  { titulo: 'Trocar as credenciais expiradas do serviço de e-mail', status: 'Done',
    prioridade: 'Alta', nasceu: -22, prazo: -18, inicio: -20, fim: -18 },
  { titulo: 'Revisar o texto do comunicado de indisponibilidade', status: 'Done',
    prioridade: 'Baixa', nasceu: -19, prazo: -15, inicio: -17, fim: -16 },
  { titulo: 'Montar o comparativo de fornecedores', status: 'Done', prioridade: 'Média',
    nasceu: -48, prazo: -35, inicio: -44, fim: -36 },
  { titulo: 'Ajustar o alerta que disparava fora do horário', status: 'Done',
    prioridade: 'Alta', nasceu: -31, prazo: -26, inicio: -29, fim: -27 },
  { titulo: 'Consolidar os indicadores do time no painel', status: 'Done',
    prioridade: 'Média', nasceu: -55, prazo: -40, inicio: -50, fim: -41 },
  { titulo: 'Encerrar o chamado de lentidão do portal', status: 'Done', prioridade: 'Baixa',
    nasceu: -27, prazo: -20, inicio: -24, fim: -21 },
  { titulo: 'Rever o checklist de entrada de projeto', status: 'Done', prioridade: 'Média',
    nasceu: -37, prazo: -29, inicio: -34, fim: -30 },
  { titulo: 'Atualizar o diagrama de arquitetura', status: 'Done', prioridade: 'Baixa',
    nasceu: -44, prazo: -33, inicio: -40, fim: -34 },
  { titulo: 'Aprovar o orçamento de licenças', status: 'Done', prioridade: 'Alta',
    nasceu: -50, prazo: -44, inicio: -48, fim: -45 },
  { titulo: 'Fazer o repasse do projeto Aurora para o time', status: 'Done',
    prioridade: 'Média', nasceu: -29, prazo: -22, inicio: -26, fim: -23 },
  // Concluído com prazo estourado: vira história, e o board não destaca como atraso.
  { titulo: 'Corrigir a numeração dos protocolos antigos', status: 'Done',
    prioridade: 'Média', nasceu: -46, prazo: -38, inicio: -42, fim: -31 },
  // Sem status: existe de propósito, e o board tem uma coluna para ele.
  { titulo: 'Ideia: agrupar os alertas por serviço', status: '', prioridade: '',
    nasceu: -13, prazo: 18 },
];

/** Anotações: `d` é o deslocamento em dias, `v` são os valores EMPRESA marcados. */
const ANOTACOES = [
  { quem: 'Ana Ribeiro', tipo: 'positivo', d: -3, v: ['qualidade'],
    nota: 'Puxou a investigação do aging sem eu pedir e já veio com a causa.',
    contexto: 'Achou a diferença de fuso no cálculo e trouxe o print do caso.' },
  { quem: 'Ana Ribeiro', tipo: 'positivo', d: -14, v: ['colaboracao', 'transparencia'],
    nota: 'Avisou cedo que ia atrasar, e já com um plano.',
    contexto: 'Mandou mensagem na segunda dizendo que a entrega ia para quinta.' },
  { quem: 'Ana Ribeiro', tipo: 'melhoria', d: -21, v: ['autogestao'],
    nota: 'Fica esperando validação para tarefas que já sabe fazer.',
    contexto: 'Parou o ajuste do painel para perguntar se podia mexer no filtro.' },

  { quem: 'Bruno Tavares', tipo: 'melhoria', d: -8, v: ['qualidade'],
    nota: 'Subiu sem testar o caminho de erro.',
    contexto: 'O formulário quebrava com campo vazio; passou no happy path e seguiu.' },
  { quem: 'Bruno Tavares', tipo: 'positivo', d: -30, v: ['colaboracao'],
    nota: 'Sentou com o Diego para destravar o ambiente dele.',
    contexto: 'Perdeu a tarde e não reclamou.' },

  { quem: 'Camila Nunes', tipo: 'positivo', d: -2, v: ['autogestao', 'qualidade'],
    nota: 'Reorganizou o próprio backlog quando a prioridade mudou.',
    contexto: 'Sem me perguntar o que largar — já veio com a proposta pronta.' },
  { quem: 'Camila Nunes', tipo: 'positivo', d: -11, v: ['transparencia'],
    nota: 'Trouxe o erro dela antes de alguém perceber.',
    contexto: 'A carga tinha rodado duas vezes; ela mesma abriu o assunto na daily.' },
  { quem: 'Camila Nunes', tipo: 'melhoria', d: -26, v: ['colaboracao'],
    nota: 'Resolve sozinha coisa que valia dividir.',
    contexto: 'Fez a migração inteira sem passar por revisão de ninguém.' },

  { quem: 'Diego Fontes', tipo: 'melhoria', d: -6, v: ['autogestao'],
    nota: 'Ainda não estima o próprio trabalho.',
    contexto: 'Disse "rápido" para algo que levou três dias.' },
  { quem: 'Diego Fontes', tipo: 'positivo', d: -18, v: ['qualidade'],
    nota: 'A documentação do fluxo ficou melhor que a que existia.',
    contexto: 'Incluiu os casos de exceção que ninguém tinha escrito.' },

  { quem: 'Elisa Moraes', tipo: 'positivo', d: -4, v: ['colaboracao', 'autogestao'],
    nota: 'Assumiu a conversa difícil com o cliente sem eu entrar.',
    contexto: 'Reunião de escopo do Aurora; segurou o prazo sem prometer o impossível.' },
  { quem: 'Elisa Moraes', tipo: 'melhoria', d: -19, v: ['transparencia'],
    nota: 'Decidiu a arquitetura e comunicou depois.',
    contexto: 'O time descobriu a troca do agendador quando o PR apareceu.' },

  { quem: 'Rafael Pinto', tipo: 'melhoria', d: -35, v: ['qualidade', 'autogestao'],
    nota: 'Entrega para quando é cobrado, não quando combina.',
    contexto: 'Duas entregas seguidas saíram no dia seguinte ao combinado, sem aviso.' },

  // Quem saiu do time: as anotações continuam na aba, e a tela as esconde.
  { quem: 'Sofia Duarte', tipo: 'positivo', d: -50, v: ['qualidade'],
    nota: 'Deixou o handover do serviço de notas redondo.',
    contexto: 'Documentou tudo antes de sair do projeto.' },
];

/** Um resumo de 1:1 por pessoa, com o texto denso que a tela de Resumos abre. */
const RESUMOS = {
  'Ana Ribeiro': {
    '-12': 'Ana está acima da barra de SE em qualidade e no limite dela em autogestão.\n\n' +
      'O mês teve dois momentos que dizem a mesma coisa por caminhos diferentes. No aging ' +
      'do painel gerencial ela puxou a investigação sem ninguém pedir e voltou com a causa ' +
      'raiz, não com o sintoma — isso é trabalho de quem já entende o sistema, não de quem ' +
      'está executando tarefa. Duas semanas antes, avisou de um atraso na segunda-feira, com ' +
      'plano, e não na quinta com desculpa.\n\n' +
      'O ponto difícil é o contraste: a mesma pessoa que investiga sozinha para de mexer no ' +
      'filtro de um painel para pedir autorização. Não é insegurança técnica — é leitura de ' +
      'permissão. Ela ainda está esperando alguém dizer até onde o escopo dela vai.\n\n' +
      'O que perguntar: "o que você faria essa semana se não precisasse me perguntar nada?" ' +
      'A resposta dela é o tamanho do espaço que ela acha que tem.',
  },
  'Bruno Tavares': {
    '-40': 'Bruno está na barra de Trainee SE, com um buraco claro em qualidade.\n\n' +
      'A base deste compilado é fraca: duas anotações no período, e uma delas é de mais de ' +
      'um mês atrás. Isso é informação sobre a minha atenção, não sobre ele.\n\n' +
      'O que existe: subiu uma alteração sem testar o caminho de erro, e o formulário ' +
      'quebrava com campo vazio. Num Trainee isso é esperado e ensinável — o que interessa ' +
      'é se ele já sabe *procurar* o caminho de erro. Do outro lado, largou a própria tarde ' +
      'para destravar o ambiente do Diego, o que num nível inicial conta muito.\n\n' +
      'O que perguntar: "como você decide que uma alteração está pronta para subir?"',
  },
  'Camila Nunes': {
    '-5': 'Camila está acima da barra de SE em autogestão e abaixo dela em colaboração.\n\n' +
      'Ela reorganizou o próprio backlog quando a prioridade mudou, sem perguntar o que ' +
      'largar, e trouxe um erro dela para a daily antes de qualquer um perceber. As duas ' +
      'coisas são de quem já opera sozinha com segurança.\n\n' +
      'O ponto difícil vem do mesmo lugar: fez a migração inteira sem passar por revisão de ' +
      'ninguém. A autonomia que resolve é a mesma que isola, e no nível dela o próximo passo ' +
      'não é entregar mais — é fazer o time entregar junto.\n\n' +
      'O que perguntar: "quem mais no time saberia manter o que você entregou este mês?"',
  },
};

/* ========================================================================== */

/**
 * Semeia a planilha fake do projeto já carregado.
 *
 * Escreve linha direto pelo mapeador, e não pelo `createCard`, porque a camada carimba
 * `criado_em` com o relógio e recusa a chave no payload — de propósito. Para a
 * demonstração a data de nascimento precisa estar no passado, senão o Gantt vira um
 * traço só e a coluna Done não tem história.
 *
 * @return {{pessoas: number, cards: number, anotacoes: number}} contagens, para o log.
 */
function semear(projeto) {
  const idsPorNome = semearPessoas(projeto);
  const cards = semearCards(projeto, idsPorNome);
  const anotacoes = semearAnotacoes(projeto, idsPorNome);

  return { pessoas: Object.keys(idsPorNome).length, cards: cards, anotacoes: anotacoes };
}

function escrever(projeto, aba, colunas, objetos) {
  const sheet = projeto._ss.getSheetByName(aba);
  objetos.forEach((obj, i) => {
    const linha = projeto.objetoParaLinha_(obj, colunas);
    sheet.getRange(2 + i, 1, 1, colunas.length).setValues([linha]);
  });
  return objetos.length;
}

function semearPessoas(projeto) {
  const idsPorNome = {};

  const objetos = PESSOAS.map((p, i) => {
    const id = 'pessoa-' + String(i + 1).padStart(2, '0');
    idsPorNome[p.nome] = id;
    return {
      id: id,
      notion_id: '',
      nome: p.nome,
      nivel: p.nivel,
      data_ultimo_1a1: p.ultimo1a1 === null ? '' : dia(p.ultimo1a1),
      criado_em: instante(-90),
      atualizado_em: instante(-90),
      ativo: p.ativo,
    };
  });

  escrever(projeto, projeto.PESSOAS_TAB_NAME, projeto.COLUNAS_PESSOAS, objetos);
  return idsPorNome;
}

function semearCards(projeto, idsPorNome) {
  const objetos = CARDS.map((c, i) => ({
    id: 'card-' + String(i + 1).padStart(2, '0'),
    notion_id: '',
    titulo: c.titulo,
    status: c.status === undefined ? 'Not started' : c.status,
    prioridade: c.prioridade === undefined ? 'Média' : c.prioridade,
    prazo: c.prazo === undefined ? '' : dia(c.prazo),
    descricao: c.descricao || '',
    criado_em: instante(c.nasceu),
    // Tocado no dia em que fechou, começou ou nasceu — nessa ordem de precedência.
    atualizado_em: instante(c.fim !== undefined ? c.fim : (c.inicio !== undefined ? c.inicio : c.nasceu), 16),
    aguardando_cliente: c.cliente === true,
    prazo_cliente: c.prazoCliente === undefined ? '' : dia(c.prazoCliente),
    pendencia_cliente: c.pendencia || '',
    delegado_para: (c.delegados || []).map((nome) => idsPorNome[nome]).join(','),
    origem_id: '',
    data_inicio: c.inicio === undefined ? '' : dia(c.inicio),
    data_conclusao: c.fim === undefined ? '' : dia(c.fim),
    data_delegacao: c.delegadoEm === undefined ? '' : dia(c.delegadoEm),
  }));

  return escrever(projeto, projeto.TAB_NAME, projeto.COLUNAS, objetos);
}

function semearAnotacoes(projeto, idsPorNome) {
  const objetos = ANOTACOES.map((a, i) => {
    const marcados = a.v || [];
    return {
      id: 'nota-' + String(i + 1).padStart(2, '0'),
      notion_id: '',
      pessoa_id: idsPorNome[a.quem],
      nota: a.nota,
      tipo: a.tipo,
      contexto: a.contexto || '',
      data: dia(a.d),
      criado_em: instante(a.d, 18),
      atualizado_em: instante(a.d, 18),
      valor_autogestao: marcados.indexOf('autogestao') >= 0,
      valor_colaboracao: marcados.indexOf('colaboracao') >= 0,
      valor_qualidade: marcados.indexOf('qualidade') >= 0,
      valor_transparencia: marcados.indexOf('transparencia') >= 0,
      origem_id: '',
    };
  });

  return escrever(projeto, projeto.ANOTACOES_TAB_NAME, projeto.COLUNAS_ANOTACOES, objetos);
}

/**
 * A agenda de hoje.
 *
 * Desenhada para as três telas em avaliação terem o que mostrar: um dia com reunião cedo,
 * um bloco livre grande no meio da manhã, duas reuniões colidindo à tarde (que é o que
 * quebra layout ingênuo), um evento de dia inteiro e um recusado — que **não** deve
 * aparecer em nenhuma delas.
 *
 * `hora` e `minuto` em número; a duração em minutos.
 */
const EVENTOS = [
  { titulo: 'Daily do time',              h: 9,  m: 0,  dur: 15, status: 'YES' },
  { titulo: 'Alinhamento com o Aurora',   h: 9,  m: 30, dur: 60, local: 'Meet', status: 'YES' },
  // Vão de 10:30 a 13:00 — o bloco em que o card vencido cabe.
  { titulo: 'Almoço com a liderança',     h: 13, m: 0,  dur: 60 },
  { titulo: 'Comitê de arquitetura',      h: 15, m: 0,  dur: 90, local: 'Sala 4', status: 'YES' },
  // Colide com o comitê de propósito: agenda real tem reunião em cima de reunião, e sem
  // repartir a largura a de baixo desaparece da tela.
  { titulo: '1:1 com a Camila',           h: 15, m: 30, dur: 45, status: 'YES' },
  { titulo: 'Retrospectiva do trimestre', h: 17, m: 0,  dur: 60, status: 'MAYBE' },
  // Recusado: entra na semente para provar que sai da leitura.
  { titulo: 'Treinamento opcional',       h: 11, m: 0,  dur: 120, status: 'NO' },
  { titulo: 'Semana de fechamento contábil', diaInteiro: true },
];

/** Os eventos no formato que o dublê de `CalendarApp` espera — tudo no dia de hoje. */
function eventosDeHoje() {
  return EVENTOS.map((e) => {
    if (e.diaInteiro) {
      return { titulo: e.titulo, inicio: hoje(), fim: hoje(), diaInteiro: true };
    }
    const inicio = hoje();
    inicio.setHours(e.h, e.m, 0, 0);
    return {
      titulo: e.titulo,
      inicio: inicio,
      fim: new Date(inicio.getTime() + e.dur * 60000),
      local: e.local || '',
      status: e.status,
    };
  });
}

/** ISO `AAAA-MM-DD` de um deslocamento em dias — o nome dos Docs de resumo. */
function isoDe(dias) {
  const d = dia(dias);
  const dois = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate());
}

module.exports = { semear, PESSOAS, RESUMOS, isoDe, dia, instante, eventosDeHoje };
