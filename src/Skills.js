/**
 * Apoio às skills. Contrato: models/05-skills.md.
 *
 * As skills leem a planilha pelo conector do Drive e escrevem pelo inbox. Este arquivo é o
 * que a *construção* delas precisa do lado do Apps Script — hoje, o mapa nome→id que a
 * captura cola nas instruções.
 */

/**
 * Imprime o `references/pessoas.md` para colar na skill.
 *
 * **Por que colar em vez de ler a aba toda vez.** A captura é de cinco segundos: a skill ouve
 * "a Ana mandou bem no deploy" e precisa escrever o arquivo sem ida e volta. Uma consulta à
 * planilha antes de cada anotação paga latência no único lugar onde ela custa desistência.
 * Com sete pessoas, a lista colada resolve o caso comum sem custo nenhum.
 *
 * **E o que fazer quando ela envelhece.** Contratou alguém e a lista não tem: aí sim a skill
 * lê a aba `Pessoas` pelo conector, que é lento mas raro. O que ela nunca faz é chutar um id
 * — `createAnotacao` confere a FK e recusa, então o erro aparece na hora em vez de virar
 * anotação apontando para ninguém.
 *
 * **Só os ativos entram.** Quem saiu do time não deve ser oferecido na captura, e a camada
 * recusaria a escrita de qualquer forma. Desativar alguém é, portanto, motivo para regerar
 * este arquivo — igual a contratar.
 *
 * Rode à mão quando o time mudar, copie a saída do log e substitua o bloco na skill.
 *
 * @return {string} O markdown, também escrito no log.
 */
function gerarReferenciaDePessoas() {
  const todos = listPessoas();
  const pessoas = todos.filter(function (p) { return p.ativo; });

  if (!pessoas.length) {
    throw new Error(
      'Nenhuma pessoa ativa na aba ' + PESSOAS_TAB_NAME + ' (' + todos.length + ' linha(s) ' +
      'no total). Uma referência sem ninguém faria a skill cair sempre no caminho lento, e ' +
      'é sintoma de setup incompleto — a coluna "ativo" recém-criada nasce desmarcada.'
    );
  }

  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const linhas = [
    '<!-- Gerado por gerarReferenciaDePessoas() em ' +
      Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy') + '. Não edite à mão. -->',
    '',
    '| nome | pessoa_id | nível |',
    '|---|---|---|',
  ];

  pessoas.forEach(function (p) {
    linhas.push('| ' + p.nome + ' | `' + p.id + '` | ' + p.nivel + ' |');
  });

  linhas.push('');
  linhas.push(
    'Nome fora desta lista: leia a aba `' + PESSOAS_TAB_NAME + '` da planilha `Gestão` pelo ' +
    'conector do Drive e **confira a coluna `ativo`** — só linha marcada vale. Nunca invente ' +
    'um id: a camada recusa id inexistente e id inativo, e a captura se perde.'
  );

  const markdown = linhas.join('\n');
  Logger.log(
    '%s pessoa(s) ativa(s) de %s. Copie daqui para baixo:\n\n%s',
    pessoas.length, todos.length, markdown
  );
  return markdown;
}
