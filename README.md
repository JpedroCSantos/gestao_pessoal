# Gestão — sistema pessoal de gestão técnica

Board de demandas, registro de feedback e preparação de 1:1 para um líder técnico,
construído inteiro sobre **Google Sheets + Apps Script**. Sem banco, sem servidor,
sem GCP: uma planilha é o storage, um Web App é a interface, e uma pasta do Drive é
a porta de entrada da captura por voz.

O sistema substituiu um conjunto de databases do Notion. A migração foi feita e
reconciliada; este repositório é o que ficou de pé depois dela.

> **Roda na sua máquina em dois comandos.** Não precisa de conta Google, de
> credencial nem de acesso a nada — ver [Executar local](#executar-local).

---

## O que ele resolve

Três perguntas que um líder técnico faz toda semana, e que normalmente moram em
lugares diferentes:

| Pergunta | Onde o sistema responde |
|---|---|
| *Por onde eu começo hoje?* | tela **Hoje** — vencidos, prazo do dia, delegados a conferir, 1:1 pendente |
| *E onde isso cabe?* | a **agenda do dia**, ao lado da fila, com os vãos livres calculados |
| *Como está a distribuição do trabalho?* | tela **Board** (kanban com arrastar) e **Dashboard** (matriz prioridade × status, Gantt) |
| *Quem eu estou esquecendo?* | tela **Anotações** — dias desde o último feedback, por pessoa |

E, antes de uma conversa de 1:1, a tela **Resumos** entrega o compilado mais recente
daquela pessoa.

## Arquitetura em 30 segundos

```
       captura por voz                        uso diário
    (Claude + conector Drive)                (navegador)
              │                                   │
              │ escreve .json                     │ google.script.run
              ▼                                   ▼
      ┌───────────────┐   trigger 10min    ┌──────────────┐
      │ pasta "inbox" │ ─────────────────> │  Ingestao.js │
      └───────────────┘                    └──────┬───────┘
                                                  │
              ┌───────────────────────────────────┤
              │        CamadaDeAcesso.js          │  ← caminho único de escrita
              └───────────────────┬───────────────┘
                                  ▼
                    planilha "Gestão" (4 abas)
                                  ▲
                                  │ leitura direta pelo conector
                            (skills de síntese)
```

Três ideias sustentam o resto:

- **Caminho único de escrita.** Front e automação não tocam célula. Os dois chamam
  as mesmas funções, e é lá — e só lá — que id é gerado, data é carimbada e valor é
  validado. A planilha é storage burro.
- **O schema dirige o código.** Cada aba é uma lista de `{campo, tipo}`. Cabeçalho,
  dropdown, checkbox, formato, largura, mapeador linha↔objeto e validação de entrada
  saem toda dela. Não existe índice de coluna cravado em lugar nenhum.
- **O app faz o que é computável; a skill faz o que exige julgamento.** Contar
  vencidos e comparar datas é do app, e ele faz melhor porque está sempre atual.
  "O que travou e por quê" é da skill.

Detalhe em **[ARQUITETURA.md](ARQUITETURA.md)** — leitura obrigatória antes de editar
qualquer arquivo de `src/`.

## Executar local

Precisa de **Node 18+**. Nada além disso: zero dependências, nenhum `npm install`.

```bash
npm run mock
# → http://localhost:8080
```

O servidor carrega os arquivos de `src/` **como estão**, sobre dublês em memória do
`SpreadsheetApp`, `DriveApp` e companhia, semeia dados fictícios e serve o app.

Não é uma cópia do sistema: é o sistema, com o Google trocado por memória RAM.
O que é fake, o que não é e como demonstrar a captura estão em
**[EXECUTAR.md](EXECUTAR.md)**.

## Testes

```bash
npm test
```

185 testes sobre o runner embutido do Node, sem dependência. Cobrem schema, mapeador,
validação, provisionamento das abas, escrita, ingestão, migração, Web App e leitura
dos resumos e da agenda.

Dois arquivos dependem dos dumps da migração, que não estão neste repositório — eles
se pulam sozinhos e dizem por quê.

## Estrutura

| Caminho | O que é |
|---|---|
| `src/Código.js` | os schemas das quatro abas e o provisionamento (`setupKanban`, `setupPessoas`, …) |
| `src/CamadaDeAcesso.js` | **a única porta de escrita**: mapeador linha↔objeto, validação, carimbos, contrato de erro |
| `src/Ingestao.js` | `processarInbox`, os triggers e a verificação de configuração |
| `src/Resumos.js` | leitura dos compilados de 1:1 no Drive |
| `src/Agenda.js` | leitura da agenda do dia e cálculo dos vãos livres |
| `src/Migracao.js` | carga histórica do Notion. **Descartável** — sai quando o ciclo de validação fechar |
| `src/Skills.js` | o que a construção das skills precisa do lado do Apps Script |
| `src/WebApp.js` | `doGet` — serve o board e as rotas de painel. Sem regra de negócio |
| `src/Index.html` | a interface inteira: 5 telas, CSS e JS inline, sem biblioteca externa |
| `mock/servidor.js` | o app rodando local, sem Google |
| `mock/emulador.js` | carrega `src/` sobre os dublês — usado pelo servidor **e** pelos testes |
| `mock/apps-script.js` | os dublês dos serviços do Google |
| `mock/semente.js` | dados fictícios, com datas relativas a hoje |
| `mock/ponte.js` | o `google.script.run` do navegador, traduzido para `POST /api` |
| `test/` | os 185 testes |
| `ARQUITETURA.md` | como funciona por dentro, e o que nunca pode ser "simplificado" |
| `EXECUTAR.md` | a execução local em detalhe |
| `CONFIGURAR-GOOGLE.md` | instalar do zero numa conta Google: planilha, pastas, trigger, Web App e skills |
| `DEPLOY.md` | publicar versão nova, escopos e runbook |

## O que não está aqui

O sistema tem uma segunda metade que vive fora deste repositório: **nove skills** que
rodam no claude.ai e fazem a captura por voz e a síntese em prosa. Elas leem a planilha
pelo conector do Drive e escrevem largando arquivos no inbox.

Elas não estão versionadas aqui porque carregam a lista de pessoas reais do time e os
identificadores das pastas do Drive. A execução local demonstra o app inteiro e o
caminho de ingestão — a metade que se vê. A captura em si depende do claude.ai.

Também ficam de fora os dumps da migração (observações nominais sobre pessoas reais).

## Stack

Google Apps Script (V8) · HtmlService · Google Sheets · Google Drive · Google Docs · Google Calendar.
Nenhuma biblioteca de terceiros, nem no servidor nem no navegador.
