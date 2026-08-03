'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarProjeto } = require('./harness');

/**
 * A agenda do dia.
 *
 * O que importa aqui não é listar reuniões — é a **ocupação**: o que sai da leitura
 * (recusado, dia inteiro) e o que ela calcula (vãos, sobreposição). Os dois erros caros
 * são silenciosos: um evento sobreposto que desaparece atrás do outro, e um vão que sai
 * maior do que é porque duas reuniões no mesmo horário foram somadas.
 */

const HOJE = new Date();

/** Um evento de hoje, por hora de início e duração em minutos. */
function ev(titulo, h, m, dur, extra) {
  const inicio = new Date(HOJE.getFullYear(), HOJE.getMonth(), HOJE.getDate(), h, m, 0, 0);
  return Object.assign({
    titulo,
    inicio,
    fim: new Date(inicio.getTime() + dur * 60000),
  }, extra || {});
}

function comAgenda(eventos) {
  const ctx = carregarProjeto({ eventos });
  ctx.setupKanban();
  return ctx;
}

/* ------------------------------ o que entra ------------------------------- */

test('devolve hora como string, nunca Date', () => {
  // `Date` está entre os tipos proibidos no transporte do HtmlService. Ver `01`.
  const ctx = comAgenda([ev('Daily', 9, 0, 15)]);
  const a = ctx.listAgenda();

  assert.strictEqual(typeof a.eventos[0].inicio, 'string');
  assert.strictEqual(a.eventos[0].inicio, '09:00');
  assert.strictEqual(a.eventos[0].fim, '09:15');
  assert.strictEqual(a.eventos[0].inicioMin, 540);
});

test('evento recusado não ocupa o dia', () => {
  /* Mesmo raciocínio do card travado no cliente: gastar espaço com o que não vai acontecer
     empurra o que importa para baixo. */
  const ctx = comAgenda([
    ev('Vou', 9, 0, 60, { status: 'YES' }),
    ev('Não vou', 14, 0, 120, { status: 'NO' }),
  ]);

  const titulos = ctx.listAgenda().eventos.map((e) => e.titulo);
  assert.deepStrictEqual(titulos, ['Vou']);
});

test('evento sem convidado entra, mesmo com getMyStatus estourando', () => {
  /* O CalendarApp levanta erro em `getMyStatus()` quando não há convidados. Tratar isso
     como recusa esconderia justamente o compromisso que ele marcou para si mesmo. */
  const ctx = comAgenda([ev('Bloqueio de foco', 10, 0, 90)]);
  assert.strictEqual(ctx.listAgenda().eventos.length, 1);
});

test('evento de dia inteiro sai da linha do tempo e vira faixa', () => {
  const ctx = comAgenda([
    ev('Reunião', 9, 0, 60),
    { titulo: 'Feriado da empresa', inicio: HOJE, fim: HOJE, diaInteiro: true },
  ]);

  const a = ctx.listAgenda();
  assert.deepStrictEqual(a.diaInteiro.map((e) => e.titulo), ['Feriado da empresa']);
  assert.deepStrictEqual(a.eventos.map((e) => e.titulo), ['Reunião']);
});

test('evento de outro dia não entra', () => {
  // Se o filtro por dia sumir do código, é aqui que aparece — e não numa tela com a agenda
  // da semana inteira empilhada.
  const outroDia = new Date(HOJE.getFullYear(), HOJE.getMonth(), HOJE.getDate() + 3, 10, 0);
  const ctx = comAgenda([
    ev('Hoje', 9, 0, 60),
    { titulo: 'Depois', inicio: outroDia, fim: new Date(outroDia.getTime() + 3600000) },
  ]);

  assert.deepStrictEqual(ctx.listAgenda().eventos.map((e) => e.titulo), ['Hoje']);
});

/* ------------------------------ os vãos ----------------------------------- */

test('os vãos são os buracos da jornada, e o vão curto não conta', () => {
  /* 30 min é o mínimo em que faz sentido dizer "cabe aqui". Anunciar 10 minutos como espaço
     livre transformaria a coluna num conselho ruim. */
  const ctx = comAgenda([
    ev('Manhã', 9, 0, 60),      // 09:00–10:00
    ev('Quase junto', 10, 10, 50),  // 10:10–11:00 → vão de 10min entre elas
    ev('Tarde', 14, 0, 60),     // 14:00–15:00
  ]);

  const vaos = ctx.listAgenda().vaos.map((v) => v.inicio + '-' + v.fim);
  assert.ok(vaos.indexOf('10:00-10:10') < 0, 'vão de 10min não deveria ser oferecido');
  assert.ok(vaos.indexOf('11:00-14:00') >= 0, 'o buraco de 3h é o que interessa');
  assert.ok(vaos.indexOf('08:00-09:00') >= 0, 'antes do primeiro compromisso conta');
  assert.ok(vaos.indexOf('15:00-19:00') >= 0, 'depois do último também');
});

test('reunião sobreposta não infla a ocupação nem come o vão', () => {
  /* Duas das 10h às 11h são uma hora ocupada, não duas. Sem mesclar os intervalos, o vão
     seguinte sairia deslocado e o total de ocupação mentiria. */
  const ctx = comAgenda([
    ev('Comitê', 10, 0, 60),
    ev('1:1 em cima', 10, 0, 60),
  ]);

  const a = ctx.listAgenda();
  assert.strictEqual(a.ocupadoMin, 60);
  assert.ok(a.vaos.some((v) => v.inicio === '11:00'), 'o vão começa quando as duas acabam');
});

test('dia sem compromisso é um vão só, do começo ao fim da jornada', () => {
  const a = comAgenda([]).listAgenda();

  assert.deepStrictEqual(a.eventos, []);
  assert.strictEqual(a.ocupadoMin, 0);
  assert.strictEqual(a.vaos.length, 1);
  assert.strictEqual(a.vaos[0].minutos, a.fimMin - a.inicioMin);
});

/* --------------------------- a sobreposição ------------------------------- */

test('eventos que colidem recebem colunas distintas', () => {
  /* Sem isto, a reunião de baixo desenha atrás da de cima e simplesmente não existe na
     tela — o erro mais caro deste formato, porque é invisível. */
  const ctx = comAgenda([
    ev('A', 15, 0, 90),
    ev('B', 15, 30, 45),
  ]);

  const [a, b] = ctx.listAgenda().eventos;
  assert.strictEqual(a.colunas, 2);
  assert.strictEqual(b.colunas, 2);
  assert.notStrictEqual(a.coluna, b.coluna);
});

test('evento que não colide fica com a largura inteira', () => {
  const ctx = comAgenda([ev('A', 9, 0, 60), ev('B', 14, 0, 60)]);
  ctx.listAgenda().eventos.forEach((e) => {
    assert.strictEqual(e.colunas, 1);
    assert.strictEqual(e.coluna, 0);
  });
});

/* ------------------------------- a janela --------------------------------- */

test('a janela estica para caber compromisso fora da jornada', () => {
  // Recortar na jornada faria a reunião das 7h desaparecer — e é justamente a que se
  // precisa ver.
  const a = comAgenda([ev('Madrugada produtiva', 6, 30, 60)]).listAgenda();

  assert.ok(a.inicioMin <= 6 * 60 + 30, 'a janela precisa começar antes das 06:30');
  assert.strictEqual(a.eventos[0].inicio, '06:30');
});

test('a janela padrão é a jornada quando tudo cabe nela', () => {
  const a = comAgenda([ev('Meio-dia', 12, 0, 30)]).listAgenda();
  assert.strictEqual(a.inicioMin, 8 * 60);
  assert.strictEqual(a.fimMin, 19 * 60);
});

/* ------------------------------- ordenação -------------------------------- */

test('os eventos vêm em ordem de início', () => {
  const ctx = comAgenda([ev('Tarde', 16, 0, 30), ev('Manhã', 9, 0, 30), ev('Almoço', 12, 0, 60)]);
  assert.deepStrictEqual(
    ctx.listAgenda().eventos.map((e) => e.titulo), ['Manhã', 'Almoço', 'Tarde']);
});

test('evento sem título não vira linha em branco', () => {
  const ctx = comAgenda([ev('', 9, 0, 30)]);
  assert.strictEqual(ctx.listAgenda().eventos[0].titulo, '(sem título)');
});
