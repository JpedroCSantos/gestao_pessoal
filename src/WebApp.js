/**
 * Web App — ponto de entrada HTTP.
 *
 * Só serve HTML. Nada de regra de negócio nem de acesso a dado aqui: o Index.html
 * busca os cards por google.script.run.listCards(), que vive em CamadaDeAcesso.js.
 */

/** Script Property com o ID da pasta onde as rotinas escrevem os painéis. */
const PROP_PAINEL = 'PAINEL_FOLDER_ID';

/**
 * `?view=` aceito → arquivo na pasta de painéis. Lista fechada, e é ela que fecha a rota.
 *
 * **Não há `dia`.** Ele existia enquanto o painel do dia era escrito por uma skill; quando o
 * próprio app passou a calcular a tela Hoje da planilha, o painel virou a mesma informação
 * com até 10 minutos de atraso. Semana e Mês continuam porque o que elas trazem é prosa de
 * julgamento — "o que travou e por quê" — e isso o app não sabe escrever.
 */
const PAINEIS = {
  semana: { arquivo: 'semana.html', titulo: 'Semana' },
  mes:    { arquivo: 'mes.html',    titulo: 'Mês' },
};

/**
 * Serve o board, ou um painel quando `?view=` vier na URL.
 *
 * Os painéis são HTML que as rotinas escrevem no Drive. O board os serve porque no Notion
 * eles eram embeds da página Gestão, e aqui a superfície equivalente é esta — mas em rota
 * separada, para não preemptar o que a fase de front decidir sobre o board em si.
 *
 * `view` é conferido contra uma lista fechada, e não concatenado num nome de arquivo: o
 * parâmetro vem da URL, e montar caminho com ele deixaria qualquer arquivo da pasta legível
 * por quem adivinhasse o nome.
 *
 * @param {Object} e Parâmetros da requisição. `view` opcional.
 */
function doGet(e) {
  const view = e && e.parameter ? String(e.parameter.view || '').trim() : '';
  if (view) return servirPainel_(view);

  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Gestão — Kanban')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** O HTML do painel, ou uma página de aviso — nunca um erro cru de Apps Script. */
function servirPainel_(view) {
  const painel = PAINEIS[view];
  if (!painel) {
    return paginaDeAviso_(
      'Painel desconhecido',
      'Não existe painel "' + view + '". Disponíveis: ' + Object.keys(PAINEIS).join(', ') + '.'
    );
  }

  let conteudo;
  try {
    conteudo = conteudoDoPainel_(painel.arquivo);
  } catch (err) {
    // Painel que ainda não rodou é o caso comum, não uma falha: a rotina do dia escreve de
    // manhã, e antes disso o arquivo não existe. Uma tela explicando vale mais que um stack.
    return paginaDeAviso_(painel.titulo, mensagemDe_(err));
  }

  return HtmlService.createHtmlOutput(conteudo)
    .setTitle('Gestão — ' + painel.titulo)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function conteudoDoPainel_(nome) {
  const id = String(
    PropertiesService.getScriptProperties().getProperty(PROP_PAINEL) || ''
  ).trim();

  if (!id) {
    throw new Error(
      'Script Property "' + PROP_PAINEL + '" não configurada. Preencha com o ID da pasta ' +
      'onde as rotinas escrevem os painéis.'
    );
  }

  const arquivos = DriveApp.getFolderById(id).getFilesByName(nome);
  if (!arquivos.hasNext()) {
    throw new Error(
      'O arquivo "' + nome + '" ainda não existe na pasta de painéis. Ele aparece quando a ' +
      'rotina correspondente rodar.'
    );
  }

  return arquivos.next().getBlob().getDataAsString('UTF-8');
}

/** Aviso legível no lugar de erro cru. Texto escapado — a mensagem pode conter o que for. */
function paginaDeAviso_(titulo, mensagem) {
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;' +
    'max-width:36rem;margin:3rem auto;padding:0 1rem;color:#37352f;line-height:1.5">' +
    '<h1 style="font-size:1rem;margin:0 0 .5rem">' + escaparHtml_(titulo) + '</h1>' +
    '<p style="color:#6b6b6b;margin:0">' + escaparHtml_(mensagem) + '</p></div>';

  return HtmlService.createHtmlOutput(html).setTitle('Gestão — ' + titulo);
}

function escaparHtml_(valor) {
  return String(valor)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
