/**
 * A ponte entre o `Index.html` e o servidor local.
 *
 * No Google, o front conversa com o servidor por `google.script.run`, que não existe fora
 * do Apps Script. Este arquivo põe um `google.script.run` no `window` com a mesma forma —
 * encadeável, assíncrono, com handler de sucesso e de falha — e traduz cada chamada num
 * `POST /api`.
 *
 * **É a única peça de código que existe só para o mock.** O `Index.html` não sabe que está
 * rodando local: se ele soubesse, a demonstração deixaria de provar que o app funciona.
 *
 * Servido pelo `mock/servidor.js` e injetado antes do script da página.
 */
(function () {
  'use strict';

  /* As funções que o projeto expõe, injetadas pelo servidor. Chamar o que não está aqui é
     erro de programação, e falha alto em vez de virar um POST 404 silencioso. */
  var disponiveis = window.__FUNCOES_DO_SERVIDOR__ || [];

  function criarRunner(handlers) {
    return new Proxy({}, {
      get: function (_alvo, nome) {
        if (nome === 'withSuccessHandler') {
          return function (fn) { return criarRunner(comHandler(handlers, 'ok', fn)); };
        }
        if (nome === 'withFailureHandler') {
          return function (fn) { return criarRunner(comHandler(handlers, 'erro', fn)); };
        }
        /* O front guarda o runner numa variável e chama o método depois
           (`var r = google.script.run.withSuccessHandler(f); r.updateCard(...)`), então
           qualquer outro nome é a chamada de fato. */
        if (typeof nome !== 'string') return undefined;

        return function () {
          chamar(nome, Array.prototype.slice.call(arguments), handlers);
        };
      }
    });
  }

  function comHandler(handlers, chave, fn) {
    var novo = {};
    Object.keys(handlers).forEach(function (k) { novo[k] = handlers[k]; });
    novo[chave] = fn;
    return novo;
  }

  function chamar(funcao, args, handlers) {
    if (disponiveis.length && disponiveis.indexOf(funcao) < 0) {
      return falhar(handlers, 'O servidor local não expõe "' + funcao + '".');
    }

    fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ funcao: funcao, args: args })
    })
      .then(function (r) { return r.json(); })
      .then(function (resposta) {
        if (resposta.ok) {
          if (handlers.ok) handlers.ok(resposta.valor);
          return;
        }
        falhar(handlers, resposta.erro);
      })
      .catch(function (err) {
        falhar(handlers, 'Servidor local fora do ar: ' + err.message);
      });
  }

  /* O front lê `err.message` — é preciso entregar algo com essa forma, e não uma string
     crua, senão toda mensagem de erro na tela vira "[object Object]". */
  function falhar(handlers, texto) {
    if (handlers.erro) handlers.erro(new Error(texto));
    else console.error('[mock] sem withFailureHandler:', texto);
  }

  window.google = { script: { run: criarRunner({}) } };
})();
