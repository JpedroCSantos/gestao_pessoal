# Arquitetura

> **Leia inteiro antes de editar `src/`.** O sistema tem invariantes que não são óbvias
> olhando o arquivo local — várias delas existem porque o comportamento do Google Sheets
> não é o que se espera. Apagar a linha errada quebra escrita, leitura ou os dois. Na
> dúvida, não remova.

---

## 1. As camadas

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Schemas e provisionamento | `src/Código.js` | a fonte única da ordem das colunas; cria e reconfigura as abas |
| Acesso a dado | `src/CamadaDeAcesso.js` | **a única porta de escrita**; mapeador linha↔objeto; contrato de erro |
| Ingestão | `src/Ingestao.js` | recolhe o inbox do Drive, traduz envelope e chama a camada |
| Leitura de Docs | `src/Resumos.js` | os compilados de 1:1, lidos do Drive |
| Leitura da agenda | `src/Agenda.js` | os compromissos de hoje e os vãos entre eles |
| Entrada HTTP | `src/WebApp.js` | `doGet`. Sem regra de negócio |
| Interface | `src/Index.html` | 5 telas, CSS e JS inline, sem biblioteca |
| Migração | `src/Migracao.js` | carga histórica. Descartável |

Em Apps Script **o escopo é global**: a separação em arquivos é organização, não
isolamento. Uma `const` de um arquivo é visível em todos. A ordem de avaliação é a do
editor — `Código.js` precisa vir primeiro, porque os schemas referenciam as listas
fechadas no nível do arquivo.

## 2. ⛔ Regras invioláveis

### 2.1 Caminho único de escrita

Front e ingestão **não escrevem célula**. Os dois chamam `createCard` / `updateCard` /
`createAnotacao` / `registrar1a1`, e é lá que id é gerado, data é carimbada e valor é
validado.

No dia em que dois lugares escreverem direto na aba, as regras divergem e o sintoma
aparece num card com prazo e sem `criado_em`.

### 2.2 `getLastRow()` não é confiável neste projeto

O setup aplica validação e formato no **corpo inteiro** da aba, para que a linha criada
depois já nasça com dropdown e checkbox. O efeito colateral é o Sheets passar a contar
linha em branco como conteúdo: `getLastRow()` devolve o fim da grade (1000 numa aba
nova), e `appendRow` escreve *depois* disso.

Foi assim que os primeiros cards foram parar na linha 1001 — invisíveis para quem
olhava o topo da aba, e perfeitamente visíveis no board.

**Regra: nunca use `appendRow` nem `getLastRow()` para posicionar escrita.** A âncora é
uma coluna que só a camada escreve (`id` nas três abas de dado, `quando` no Log), via
`ultimaLinhaComId_`.

### 2.3 `requireCheckbox()`, nunca `insertCheckboxes()`

Os dois renderizam o mesmo widget. `insertCheckboxes` **escreve `FALSE`** em toda célula
vazia do range — e como a validação cobre a coluna inteira, isso encheria a aba de
valores e recriaria o problema de 2.2.

Consequência que o mapeador absorve: célula nunca tocada volta `''`, e não `false`.

### 2.4 `Date` é proibido no transporte

O HtmlService lista `Date` entre os tipos que não atravessam `google.script.run`. Como
as colunas de data saem do `getValues()` como `Date` nativo, o mapeador é obrigado a
converter para string ISO na saída e de volta na entrada.

E **no navegador, nada de `new Date(iso)` para exibir**: o parser trata `"2026-08-02"`
como UTC e, em fuso negativo, mostra dia 01. Fatiar a string é o certo.

### 2.5 Sufixo `_` é privado, e isso é segurança

Toda função global **sem** sufixo `_` é chamável por qualquer usuário com acesso ao Web
App, direto do console do navegador. O sufixo é o que separa a API pública da interna.

O servidor local reproduz exatamente essa regra (`mock/servidor.js`, `funcoesPublicas`),
para o comportamento demonstrado ser o comportamento publicado.

### 2.6 Os escopos OAuth são declarados à mão

`src/appsscript.json` lista `oauthScopes` explicitamente, o que **desliga a detecção
automática** do Apps Script. Foi por necessidade: quando `CalendarApp` entrou, a detecção não
pediu o escopo do Calendar, o editor não oferecia consentimento, e a implantação falhava com
*"does not have permission"*.

**A consequência é permanente e silenciosa: serviço novo no código exige linha nova na
lista.** Um `GmailApp` acrescentado sem isso falha em produção, e nada no arquivo local
aponta o motivo. A lista e o roteiro de verificação estão em [DEPLOY.md](DEPLOY.md).

Efeito colateral bom: o Calendar entra como `calendar.readonly`. Um bug não consegue apagar
reunião.

### 2.7 A guarda de cabeçalho

`setupXxx` **aborta** se encontrar dados no corpo sob um cabeçalho que não bate com o
schema. Reescrever os rótulos trocaria o significado do dado embaixo, sem mover nada.

**Acrescentar coluna à direita é a exceção e passa**, exigindo as três condições juntas:
as divergências formam bloco contíguo, o bloco termina na última coluna esperada, e cada
uma está vazia no cabeçalho **e** no corpo.

É por isso que colunas novas vão sempre para o fim do schema, mesmo quando a posição
"bonita" seria no meio. Nada no código indexa coluna por número, então a ordem só importa
para a guarda.

### 2.8 Lock em toda escrita, e a checagem de duplicata dentro dele

`appendRow` não é atômico: duplo clique com latência ou duas abas abertas bastam para
dois appends disputarem a mesma linha.

A deduplicação por `origem_id` roda **dentro** do mesmo lock do append, nunca antes —
checar fora reabre exatamente a corrida que o lock existe para fechar. E precisa ser na
camada, não na ingestão: locks do Apps Script não são confiavelmente reentrantes, e um
`waitLock` aninhado é um deadlock esperando acontecer.

Por isso `processarInbox` usa `getUserLock()` e a camada usa `getScriptLock()`.

## 3. O schema dirige o código

Cada aba é uma lista ordenada de `{ campo, tipo, opcoes? }` em `src/Código.js`. Tipos
válidos: `texto`, `lista`, `data`, `data_hora`, `booleano`.

Dela derivam, sem exceção: cabeçalho, dropdown, checkbox, formato de célula, largura,
mapeador linha↔objeto, validação de entrada e serialização do transporte.

Duas consequências que valem por escrito:

- **A lista fechada mora no próprio schema** (`opcoes`), não num mapa `campo → lista` à
  parte. Foi assim que `Pessoas` ganhou dropdown de nível sem tocar em função nenhuma.
- **Aba nova é um schema, não código novo.** Os quatro `setupXxx` são uma linha cada
  sobre o mesmo `provisionarAba_`. Se um setup precisar de lógica própria, é sinal de que
  o schema não está expressando alguma coisa.

### As quatro abas

| Aba | O que guarda | Detalhe |
|---|---|---|
| `Kanban` | um card por linha | `delegado_para` é FK multivalor: ids separados por vírgula |
| `Pessoas` | o time | `ativo` diz quem ainda está; ver 5 |
| `Anotações` | feedback por pessoa | os quatro valores são **colunas booleanas**, não uma lista |
| `Log` | auditoria da ingestão | não é dado de negócio |

**Texto tem formato `@` obrigatório.** Sem ele, célula que começa com `-`, `=`, `+` ou
`@` vira fórmula e o conteúdo se perde — não é hipótese, sete campos do histórico
começam com `- `.

## 4. As duas direções de dado não são simétricas

**Leitura é direta.** As skills leem a planilha pelo conector do Drive, sem passar pela
camada. Consequência a lembrar: **o que a camada garante na escrita não vale na leitura.**
Uma linha digitada à mão na aba chega como está.

**Escrita é só pelo inbox.** O conector lê mas não escreve. Toda gravação vinda de fora é
um arquivo JSON numa pasta do Drive:

```json
{ "tipo": "card", "payload": { "titulo": "…", "prioridade": "Alta" } }
```

`processarInbox` recolhe, traduz o envelope e chama a camada. Três tipos: `card`,
`anotacao`, `1a1`. Arquivo bom vai para `processados/`, ruim vai para `erros/`, e um ruim
no meio da leva não derruba os outros. Tudo fica na aba `Log`.

**`origem_id` é a chave de deduplicação**, e é o que torna reprocessar o inbox inofensivo
por construção, e não por sorte.

### O contrato de erro

Por prefixo na mensagem, porque é o que atravessa o `google.script.run` sem virar
`ScriptError` genérico:

| Prefixo | Significa | O front faz |
|---|---|---|
| `ErroValidacao` | payload errado | mostra a mensagem no formulário |
| `ErroNaoEncontrado` | id que não existe | avisa e recarrega |
| `ErroDuplicado` | `origem_id` já processado | trata como "ignorado", não como falha |
| `ErroLock` | outra escrita em andamento | pede para tentar de novo |

## 5. `ativo` — quem ainda está no time

A coluna corta nos dois sentidos, **de formas diferentes**, e trocar isso quebra coisas
opostas:

| operação | quem vale |
|---|---|
| escrever (anotação, carimbo de 1:1) | **só ativo** — a camada recusa o resto |
| escolher quem recebe feedback, compilar 1:1 | só ativo |
| traduzir id → nome | **todo mundo, sempre** |

`listPessoas()` **não filtra**, e isso é contrato: ela é a tabela de tradução do sistema
inteiro. Filtrar na camada faria card delegado a quem saiu mostrar o uuid, anotação
antiga perder o nome, e a pasta de resumos virar "órfã" — três regressões numa decisão.
Quem esconde é cada tela, que sabe se está mostrando atenção ou histórico.

> **Booleano vazio é `false`.** Ao criar a coluna numa aba que já tem gente, todo mundo
> nasce inativo e some do app até as caixas serem marcadas. `verificarConfiguracao()`
> reprova enquanto não houver ninguém ativo.

## 6. O front

Cinco telas, navegação no cliente, sem parâmetro de URL — o `?view=` pertence às rotas de
painel, e reusar o nome colidiria dois namespaces na mesma query string.

**Hoje** é a principal e é calculada ao vivo: uma coluna, de cima para baixo, na ordem da
urgência, começando por uma frase que já conclui em vez de uma contagem que obriga o
leitor a concluir. Card travado no cliente **sai da fila do dia** — a bola está do outro
lado.

**Board** tem arrastar e soltar com atualização otimista. **Reverter é obrigatório:** se
o servidor recusar, o card volta para a coluna de origem e o erro aparece. Otimismo sem
reversão é mentira na tela. Soltar em `Delegado` abre o seletor de pessoas antes de
confirmar.

**Dashboard** tem a matriz prioridade × status e um Gantt cuja barra tem dois segmentos —
espera (de `criado_em` até o início real) e execução. Um Gantt de `data_inicio → prazo`
mostraria uma fração dos cards, porque a maioria nunca entrou em `In progress`.

**A coluna da direita da Hoje é a agenda do dia**, lida do Google Calendar pelo `CalendarApp`
— serviço embutido, sem GCP e sem token. Ela não repete o Calendar: calcula os **vãos** entre
os compromissos, que é a única leitura que nem o app nem o Calendar dão isolados. A regra que
sustenta a divisão em duas colunas: *à direita só entra o que responde uma pergunta diferente
da fila*. A fila responde "o quê"; a agenda, "quando cabe".

**Um princípio atravessa as cinco telas: o que sai da vista é declarado.** A coluna Done
diz quantos escondeu, o Gantt diz quantos ficaram fora do recorte, Anotações e Resumos
dizem quantos inativos sumiram. Filtro silencioso é como uma tela deste tipo perde a
confiança de quem a abre.

## 7. Onde as coisas dão errado

Armadilhas reais, todas descobertas na prática:

- **Coluna removida do schema não some da planilha.** `ajustarGrade_` só apara coluna
  excedente em aba nova; numa aba existente, o que está à direita pode ser de alguém.
- **`clasp push` não atualiza `/exec`.** O push muda o código; o Web App continua
  servindo a versão publicada até alguém republicar. Ver [DEPLOY.md](DEPLOY.md).
- **`.claspignore` é uma allowlist**, e comentário no fim de linha de padrão vira parte
  do padrão. Um arquivo de teste subindo derruba tudo: `require` roda na avaliação e
  quebra qualquer execução, inclusive as que funcionavam.
- **Fuso da planilha e fuso do script são independentes** e podem divergir. O mapeador
  formata com o da planilha, que é o inverso exato de como o `Date` foi construído.

## 8. Testes

`npm test` — runner embutido do Node, sem dependência.

O harness concatena os arquivos de `src/` num escopo só, que é como o Apps Script avalia,
e roda contra dublês em memória. Usa `new Function` e não `vm`: o `vm` cria outro realm, e
aí um array vindo do projeto não é `deepStrictEqual` a um array do teste — mesma
estrutura, protótipos diferentes.

**O mesmo emulador serve o servidor local** (`mock/emulador.js`). Uma segunda
implementação divergiria, e a demonstração passaria a mostrar um sistema que os testes
não cobrem.

Mudança em schema, camada ou ingestão passa pelos testes antes do push. Teste que
atrapalha uma mudança deliberada muda junto, com o porquê registrado — não é removido.
