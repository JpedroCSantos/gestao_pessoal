# Testes

```bash
npm test
```

Sem dependências: usa o runner embutido do Node (`node --test`). Não precisa de `npm install`.

Para rodar um arquivo só, enquanto mexe nele:

```bash
node --test test/escrita.test.js
```

## Como isto funciona

O código roda no Apps Script, que não tem `require` nem `module.exports` — os arquivos `.gs`
compartilham um escopo global só. O emulador reproduz isso: concatena os arquivos de `src/`,
avalia num escopo único e devolve tudo que eles declaram.

**O emulador mora em `mock/emulador.js`, e não aqui**, porque tem dois consumidores: estes
testes e o servidor local (`npm run mock`). Uma segunda implementação divergiria, e a
execução local passaria a demonstrar um sistema que a suíte não cobre. O que sobrou em
`harness.js` são os atalhos de teste: abas provisionadas, gente semeada, dumps e a classe do
erro lançado.

Os serviços do Google (`SpreadsheetApp`, `DriveApp`, `LockService`…) entram como dublês em
memória, definidos em `mock/apps-script.js`. A planilha fake não é um `{}` qualquer: ela
replica os dois comportamentos do Sheets de que o projeto depende — célula nunca escrita
devolve `''`, e o grid tem tamanho fixo que só cresce por `insertRowsAfter`.

**Quando um teste falhar com "não é uma função"**, é o dublê que não implementa aquele
método ainda. Estender `mock/apps-script.js` é a resposta certa; devolver `undefined` para
calar o erro transformaria o teste em decoração.

## Os arquivos

| arquivo | cobre |
|---|---|
| `schema.test.js` | ordem e tipos das colunas, coerência entre schema e as listas fechadas |
| `mapeador.test.js` | linha↔objeto, serialização ISO, as armadilhas de data |
| `validacao.test.js` | obrigatoriedade, defaults, e **qual** classe de erro cada falha produz |
| `setup.test.js` | provisionamento, idempotência, e os dois lados da guarda de cabeçalho |
| `escrita.test.js` | create/update contra a planilha, dedupe, lock, posicionamento de linha |
| `ingestao.test.js` | envelope, tradução, e o ciclo do `processarInbox` |
| `migracao.test.js` | a carga histórica: FK por page ID, `criado_em` da origem, idempotência, reconciliação |
| `skills.test.js` | a referência nome→id que a captura cola nas instruções |
| `webapp.test.js` | a rota `?view=`: lista fechada, painel ausente, escape do parâmetro |
| `dumps.test.js` | integridade dos dados reais de `data/input/` e o round-trip deles |

Os dumps de `data/input/` são os **finais**, os que rodaram a migração. Não são amostra: se
forem trocados, `dumps.test.js` acusa a contagem e o `00` precisa mudar junto.

> **Eles não estão no repositório público** — carregam 60 observações nominais sobre pessoas
> reais. `dumps.test.js` e `migracao.test.js` se pulam sozinhos quando `data/input/` não
> existe, e dizem por quê. Num clone sem os dumps, `npm test` roda 137 e pula 2.

## O que estes testes protegem

Não são testes de cobertura. Cada um existe porque algo pode quebrar de um jeito específico
e caro — e três deles existem porque **já quebraram**:

- **O card na linha 1001.** `appendRow` posicionava por `getLastRow()`, que a validação
  aplicada no corpo inteiro inflava até o fim da grade. Os cards nasciam invisíveis. Hoje
  `escrita.test.js` afirma que o primeiro card cai na linha 2.
- **A guarda de cabeçalho barrando evolução de schema.** Ela precisa deixar passar coluna
  nova à direita e continuar barrando rótulo trocado. `setup.test.js` fixa os dois lados.
- **Dedupe fora do lock.** Se a checagem sair de dentro do lock, o teste de reprocessamento
  continua verde por sorte — por isso ele reprocessa o *mesmo arquivo*, que é o caso real.

## Ao mexer no código

Alteração em schema, camada ou ingestão passa por aqui antes do `clasp push`. Se um teste
ficar no caminho de uma mudança deliberada, o certo é **mudar o teste junto e dizer por
quê** — não removê-lo.

Estes testes rodam contra os dumps reais de `data/input/`. Se um dump for refeito e a
contagem mudar, `dumps.test.js` acusa, e o `00-plano-de-fases` precisa ser atualizado junto.

## O que fica de fora

- **`Index.html`** — o JS do front não é exercitado aqui. Precisaria de DOM.
- **O texto das skills** — `skills/google/` não roda em teste. O que se pode travar
  daqui é o contrato que elas consomem (schema, envelope, referência), e isso está
  travado. Se uma skill descrever uma coluna que não existe, quem descobre é o uso.
- **O Drive de verdade** — `DriveApp` é dublê; permissão e cota só aparecem em execução real.
- **`clasp push`** — o `.claspignore` mantém esta pasta fora do projeto Apps Script. Se ela
  subir, `require` no nível do arquivo derruba toda execução, inclusive as que funcionam.
