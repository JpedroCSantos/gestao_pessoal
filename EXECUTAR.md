# Executar local

O app inteiro na sua máquina, sem conta Google, sem credencial e sem acesso a nada.

```bash
npm run mock
# → http://localhost:8080
```

Precisa de **Node 18+**. Não há `npm install`: o projeto não tem dependência nenhuma.

Para trocar a porta: `PORTA=3000 npm run mock`.

---

## Não é uma cópia — é o projeto

Esta é a decisão que sustenta o resto. O servidor carrega os arquivos de `src/` **como
estão**, no mesmo escopo compartilhado em que o Apps Script os avalia, sobre dublês em
memória dos serviços do Google.

Uma correção no `CamadaDeAcesso.js` aparece aqui na próxima execução, sem ninguém copiar
nada. E são os **mesmos dublês** que os 171 testes usam — o que você vê rodando é o que
a suíte cobre.

```
navegador ──> GET /            ──> doGet() do WebApp.js, scriptlets resolvidos
          ──> GET /mock/ponte  ──> o shim de google.script.run
          ──> POST /api        ──> a função do projeto, pelo nome
```

O `Index.html` **não sabe** que está rodando local. Se soubesse, a demonstração deixaria
de provar que o app funciona.

## O que é falso

| Peça | No Google | Aqui |
|---|---|---|
| Planilha | Google Sheets | matriz em memória, com o mesmo comportamento de célula vazia e grade fixa |
| Pastas e arquivos | Google Drive | objetos em memória |
| Docs de resumo | Google Docs | texto em memória |
| Agenda | Google Calendar | eventos sintéticos de hoje, em `mock/semente.js` |
| `google.script.run` | ponte do HtmlService | `fetch` para `POST /api` (`mock/ponte.js`) |
| Dados | o time real | `mock/semente.js`, tudo inventado |
| Trigger de 10 min | agendador do Apps Script | o botão **Sincronizar** |

**Tudo é volátil.** Fechar o servidor apaga o que você criou. Reiniciar devolve o estado
inicial — o que é conveniente para demonstrar duas vezes seguidas.

## Os dados de exemplo

Ninguém em `mock/semente.js` existe. O que foi copiado do sistema real é a **forma**,
porque é ela que faz a demonstração significar alguma coisa:

- ~20 cards ativos contra ~14 concluídos — a coluna `Done` é a única que só cresce, e é
  por isso que ela nasce colapsada;
- a maioria em `Not started`, **sem `data_inicio`** — é o que justifica a barra de espera
  do Gantt ter dois segmentos;
- prazos espalhados em volta de hoje, com vencidos, um card que vence hoje e outro amanhã;
- dois cards travados no cliente, que somem da fila do dia e aparecem só no bloco de
  cliente;
- dois sem prazo, que ficam de fora do Gantt e são declarados abaixo dele;
- uma pessoa **inativa**, com um card ainda delegado a ela — é o caso que mostra a
  assimetria da coluna `ativo`: ela some das telas de atenção, mas o card continua
  aparecendo com o nome dela, porque é exatamente o card que precisa de outro dono.

**As datas são relativas a hoje**, calculadas a cada boot. Com datas fixas, a tela Hoje
ficaria vazia no mês seguinte e a demonstração morreria sozinha.

## Roteiro de demonstração

Cinco minutos, na ordem que conta a história:

1. **Hoje.** A frase do topo é o produto da tela — ela conclui em vez de exibir uma
   contagem. Repare que o card travado no cliente não está na fila do dia.

   À direita, a **agenda do dia**: o próximo compromisso numa tira em cima, e a linha do
   tempo embaixo com os **vãos livres desenhados do tamanho que têm** — é ali que se vê onde
   o card vencido cabe. A agenda sintética tem, de propósito, duas reuniões colidindo às 15h
   (que é o que quebra layout ingênuo, e por isso elas dividem a largura), um evento de dia
   inteiro na faixa do topo, um vão de 2h30 no meio da manhã e um compromisso recusado que
   **não** deve aparecer em lugar nenhum.
2. **Board.** Arraste um card entre colunas: ele se move sob o cursor e só depois o
   servidor confirma. Solte em **Delegado** — abre o seletor de pessoas, porque um card
   delegado a ninguém é um estado quebrado.
3. **Dashboard.** A matriz mostra onde prioridade e atenção discordam. No Gantt, arraste
   sobre a régua para recortar o período; clique num status da legenda para escondê-lo;
   duplo clique na régua volta ao todo. O que sumiu é sempre contado.
4. **Anotações.** A ordem é do mais esquecido para o menos — a tela responde "quem eu
   estou deixando sem feedback", não "quantas anotações eu fiz".
5. **Resumos.** Clique em **Ler**: é o texto que se lê antes de entrar numa sala de 1:1,
   escrito por uma skill que aqui não roda.

E, se houver tempo, a metade invisível: a ingestão, abaixo.

## Demonstrar a captura

A metade difícil de explicar em palavras. No sistema real, falar com o Claude gera um
arquivo JSON numa pasta do Drive, e um trigger de 10 minutos o transforma em linha.

Aqui você faz o mesmo à mão:

1. Crie um arquivo em **`mock/inbox/`**, com qualquer nome terminado em `.json`:

   ```json
   {
     "tipo": "card",
     "payload": {
       "titulo": "Revisar o orçamento da squad",
       "prioridade": "Alta",
       "prazo": "2026-09-30"
     }
   }
   ```

2. Clique em **Sincronizar**, no topo do app.
3. O card aparece no board.

Não precisa reiniciar: o servidor varre a pasta a cada sincronização. Já existe um
`exemplo-card.json` lá para o primeiro teste.

Os outros dois envelopes:

```json
{ "tipo": "anotacao",
  "payload": { "pessoa_id": "pessoa-01", "nota": "Puxou a investigação sozinha",
               "tipo_nota": "positivo", "valores": ["Autogestão", "Qualidade"] } }
```

```json
{ "tipo": "1a1", "payload": { "pessoa_id": "pessoa-03", "data": "2026-09-01" } }
```

Os ids vão de `pessoa-01` a `pessoa-07`, na ordem de `mock/semente.js`.

**Erre de propósito**, que é onde a arquitetura aparece: mande um envelope sem `titulo`,
ou com `pessoa_id` que não existe. O arquivo vai para a pasta de erros, a mensagem
aparece na tela, e nada entra pela metade.

## Os painéis

`http://localhost:8080/?view=semana` e `?view=mes` servem os painéis de exemplo.

No sistema real quem escreve esses HTMLs é uma skill semanal, que roda no claude.ai — o
conteúdo aqui é propositalmente magro. O que a rota demonstra é que `view` é conferido
contra uma **lista fechada** e nunca concatenado num nome de arquivo: tente
`?view=qualquercoisa` e veja a tela de aviso.

## O que a execução local não demonstra

**As nove skills.** Elas rodam no claude.ai com o conector do Drive, e não há como
executá-las fora dali. O que você vê é o app e o caminho de ingestão — a metade visível.

**Concorrência real.** O `LockService` fake sempre concede a trava. O comportamento sob
duas abas disputando a mesma linha está coberto nos testes, não aqui.

**Autorização e escopos.** No Google, a primeira execução depois de um deploy pede
reautorização quando um escopo novo entra. Local não tem escopo nenhum.

## Quando algo quebrar

O servidor imprime no terminal cada erro de negócio, com o nome da função e a mensagem —
inclusive os esperados, como uma validação recusando um card sem título.

Se a página subir em branco, olhe o console do navegador: quase sempre é o `Index.html`
chamando uma função que o projeto não expõe, e a ponte diz exatamente qual.
