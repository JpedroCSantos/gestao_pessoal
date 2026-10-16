# Configurar no Google, do zero

O passo a passo completo para sair de uma conta Google vazia e chegar no app funcionando:
planilha, código, pastas, automação, Web App e skills. Conta uns 30 minutos.

Para só ver o app rodando, sem Google nenhum, você quer [EXECUTAR.md](EXECUTAR.md).
Para publicar uma versão nova depois de instalado, e para o runbook, [DEPLOY.md](DEPLOY.md).

---

## O que você vai montar

| Peça | Onde mora | Quem cria |
|---|---|---|
| Planilha **`Gestão`** com 5 abas | Google Sheets | você cria; `setupXxx()` provisiona as abas |
| Projeto Apps Script **vinculado** à planilha | Apps Script | você cria; `clasp push` sobe o código |
| 5 pastas | Google Drive | você |
| 5 propriedades do script (IDs das pastas) | Apps Script | você |
| Trigger de 10 minutos do `processarInbox` | Apps Script | `instalarTriggers()` |
| Web App (a URL `/exec`) | Apps Script | você, pela implantação |
| As skills de captura e síntese | claude.ai | você, fora deste repositório |

A ordem abaixo importa em dois lugares, e o guia avisa quando chegar neles: a autorização
acontece **no editor** antes do Web App existir, e o time só pode ser cadastrado **depois**
do Web App publicado.

---

## 0. Pré-requisitos

**Na conta Google:** Drive, Sheets e Calendar ativos. Uma conta Workspace da empresa serve,
desde que o administrador não bloqueie Apps Script.

**Na máquina:**

```bash
node --version            # precisa ser 18 ou mais
npm i -g @google/clasp    # a CLI do Apps Script
clasp login               # abre o navegador; entre com a conta que vai hospedar o sistema
```

**Ative a Apps Script API** em <https://script.google.com/home/usersettings>
(*Configurações → API Google Apps Script → Ativada*). Sem isso o `clasp push` falha com
*"User has not enabled the Apps Script API"*. É uma chave por conta, liga uma vez só.

**No repositório:** confira que está tudo verde antes de subir qualquer coisa.

```bash
npm test
```

---

## 1. Crie a planilha

1. Abra <https://sheets.new>.
2. Renomeie para **`Gestão`**, exatamente assim, com acento. As skills procuram a planilha
   **pelo nome**, nunca por ID, então outro nome deixa a captura sem destino.
3. Em *Arquivo → Configurações → Fuso horário*, escolha **(GMT-03:00) São Paulo**.

> **Por que o fuso:** o `src/appsscript.json` declara `America/Sao_Paulo`. Se a planilha
> estiver em outro fuso, toda data carimbada pela camada de acesso aparece defasada na aba.
> O `setupKanban()` avisa no log quando os dois divergem, mas é mais barato acertar agora.

Não crie abas nem cabeçalhos à mão: o passo 7 faz isso a partir do schema.

## 2. Crie o projeto Apps Script vinculado

1. Na planilha, *Extensões → Apps Script*. Abre o editor com um projeto novo.
2. Renomeie o projeto (canto superior esquerdo) para algo como `Gestão`. O nome é só para
   você achar depois.
3. Na engrenagem **Configurações do projeto**, copie o **ID do script**.

O projeto precisa ser criado **por dentro da planilha**, e não em script.google.com. É o
vínculo que faz `SpreadsheetApp.getActiveSpreadsheet()` funcionar, e é por isso que o código
não tem ID de planilha nenhum.

## 3. Ligue o repositório ao projeto

Crie o arquivo **`.clasp.json`** na raiz do repositório, com o ID do passo anterior:

```json
{
  "scriptId": "COLE_O_ID_DO_SCRIPT_AQUI",
  "rootDir": "src",
  "scriptExtensions": [".js", ".gs"],
  "htmlExtensions": [".html"],
  "jsonExtensions": [".json"],
  "filePushOrder": [],
  "skipSubdirectories": false
}
```

Ele está no `.gitignore` de propósito: identifica um recurso da sua conta e não vai para o
repositório.

O `rootDir: "src"` é o que faz o clasp enxergar só o código do Apps Script. Um arquivo de
`mock/` ou `test/` que subisse levaria um `require` junto, e um `require` no nível do
arquivo derruba **todas** as funções do projeto, não só a dele.

## 4. Suba o código

```bash
clasp push
```

Se ele perguntar se pode sobrescrever o manifesto, responda **sim**: o `appsscript.json`
do repositório é o que declara fuso, runtime V8 e escopos.

Recarregue o editor. Devem aparecer `Agenda`, `CamadaDeAcesso`, `Código`, `Index`,
`Ingestao`, `Migracao`, `Resumos`, `Skills` e `WebApp`, cada um **uma vez só**. Se
`Código` aparecer duplicado, veja [Problemas comuns](#problemas-comuns).

## 5. Crie as pastas no Drive

Recomendo uma pasta-mãe `Gestão` no Drive, com as cinco dentro:

| Pasta | Para quê | Nome importa? |
|---|---|---|
| `inbox` | onde as skills largam os envelopes `.json` | não |
| `processados` | para onde o envelope vai depois de virar linha | não |
| `erros` | envelope que falhou; o motivo fica na aba `Log` | não |
| `paineis` | os HTMLs `semana.html` e `mes.html` das rotinas | não |
| `Resumos` | uma subpasta por pessoa, um Doc por compilado de 1:1 | **sim**: exatamente `Resumos`, e só uma com esse nome no Drive |

As skills de 1:1 acham a `Resumos` pelo nome. Duas pastas com esse nome no mesmo Drive
fazem a skill escolher uma sem avisar.

**Como pegar o ID de cada pasta:** abra a pasta no navegador. O ID é o trecho final da URL:

```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345
                                       └────────────── ID ──────────────┘
```

Anote os cinco. Vão ser usados no passo 6 e de novo no passo 12.

## 6. Registre os IDs como propriedades do script

No editor, *Configurações do projeto → Propriedades do script → Adicionar propriedade do
script*, uma por pasta:

| Propriedade | Valor |
|---|---|
| `INBOX_FOLDER_ID` | ID da pasta `inbox` |
| `PROCESSADOS_FOLDER_ID` | ID da pasta `processados` |
| `ERROS_FOLDER_ID` | ID da pasta `erros` |
| `PAINEL_FOLDER_ID` | ID da pasta `paineis` |
| `RESUMOS_FOLDER_ID` | ID da pasta `Resumos` |

Salve. O nome da propriedade tem que ser exatamente o da tabela, e o valor é só o ID, sem
URL nem espaço.

`DUMPS_FOLDER_ID` não entra numa instalação nova: ela só existiu para a carga histórica do
Notion (`src/Migracao.js`).

## 7. Autorize e provisione as abas

No editor, escolha **`setupKanban`** no seletor de funções e clique em **Executar**.

A primeira execução abre a tela de autorização:

1. Escolha a sua conta.
2. Aparece *"O Google não verificou este app"*. É esperado: o app é o seu próprio script, e
   não passou por verificação pública. Clique em **Avançado → Acessar Gestão (não seguro)**.
3. Aceite os acessos. São os cinco escopos declarados no `appsscript.json`: Planilhas, Drive,
   Documentos, Agenda (**só leitura**) e gerenciamento de triggers.

Como os escopos estão declarados à mão, essa tela pede **todos de uma vez**. Não vai
aparecer outra tela depois, nem para a agenda.

Em seguida, rode as outras quatro, uma por vez:

```
setupPessoas()   setupAnotacoes()   setupNotas()   setupLog()
```

A planilha passa a ter as abas `Kanban`, `Pessoas`, `Anotações`, `Notas` e `Log`, com
cabeçalho, dropdowns, checkboxes e larguras. As cinco funções são **idempotentes**: rodar de
novo converge no mesmo estado e não apaga dado. Se uma delas parar com *"não bate com o
contrato"*, é a guarda de cabeçalho protegendo uma aba que já tinha conteúdo (veja o
[runbook](DEPLOY.md#3-runbook)).

Pode apagar a `Página1` vazia que veio com a planilha.

## 8. Confira a agenda

Rode **`listAgenda`** no editor. O log deve mostrar os compromissos de hoje do **calendário
principal** da conta (o app sempre lê o padrão). Dia vazio também conta como sucesso; o
que não pode aparecer é erro de permissão.

Vale fazer agora porque **o Web App não consegue pedir autorização**: a tela de
consentimento do Google não abre dentro dele. Escopo que falta só aparece como erro na tela,
então o lugar de descobrir é aqui.

## 9. Instale o trigger da ingestão

Rode **`instalarTriggers`**. Ele cria o agendamento que roda o `processarInbox` a cada 10
minutos. Confira no ícone de relógio (**Acionadores**) do editor: deve haver exatamente um,
de `processarInbox`.

Também é idempotente: rodar de novo troca o trigger, não duplica.

## 10. Publique o Web App

1. *Implantar → Nova implantação*.
2. Na engrenagem de *Selecionar tipo*, escolha **App da Web**.
3. Preencha:
   - **Descrição:** `v1`, ou o que preferir.
   - **Executar como:** **Eu**.
   - **Quem pode acessar:** **Somente eu**.
4. *Implantar*, e copie a **URL do app da Web**, a que termina em `/exec`. Esse é o app.
   Salve nos favoritos.

> **Por que "Somente eu":** o Web App executa como você, ou seja, com a sua permissão de
> escrita na planilha. Qualquer pessoa com acesso à URL leria e escreveria anotações de
> feedback sobre o time. Abra o acesso só se souber exatamente quem precisa entrar.

## 11. Cadastre o time

Abra a URL `/exec`, vá na tela **Pessoas** e use *Novo → Pessoa* para cada pessoa.

O formulário gera o `id` (UUID), carimba as datas e já marca `ativo`. Prefira ele a digitar
na aba. Se digitar mesmo assim, três regras:

- o `id` precisa ser um UUID, porque é o alvo das referências de cards e anotações;
- `nivel` só aceita os valores do dropdown;
- **marque a caixa `ativo`**: em branco lê como `false`, e a pessoa some de todas as telas.

Dois ativos com o mesmo nome são recusados de propósito: é pelo nome que a skill de captura
resolve "a Ana" em um id.

## 12. Verifique tudo de uma vez

Rode **`verificarConfiguracao`** no editor. Ele confere as cinco pastas (testando **escrita**
nas três da ingestão), as cinco abas, o trigger e se existe pelo menos uma pessoa ativa. O
fim do log deve ser:

```
=== Configuração OK ===
```

Se terminar em `=== Há pendências acima ===`, a linha com `FALTANDO` ou `ERRO` diz qual
passo refazer.

## 13. Teste a ingestão de ponta a ponta

Este teste prova o caminho completo, sem depender das skills:

1. Envie o arquivo [`mock/inbox/exemplo-card.json`](mock/inbox/exemplo-card.json) do
   repositório para a pasta **`inbox`** no Drive (arrastar para o navegador serve).
2. No editor, rode **`processarInbox`** para não esperar os 10 minutos.
3. Confira:
   - o card *"Card que entrou pelo inbox"* aparece na tela **Board** do app;
   - o arquivo saiu do `inbox` e foi para `processados`;
   - a aba `Log` tem uma linha de sucesso.

Se o arquivo for para `erros`, a aba `Log` diz o motivo. Depois do teste, apague a linha do
card direto na aba `Kanban`: o app não tem exclusão de card, e um card recém-criado não é
referenciado por nada.

## 14. Conecte as skills no claude.ai

As skills são a metade do sistema que **não** está versionada aqui, porque carregam a lista
real do time e IDs de pasta (estão no `.gitignore`, em `skills/`). O que elas precisam
desta instalação:

| A skill acha... | Como | O que fazer numa instalação nova |
|---|---|---|
| a planilha `Gestão` | pelo nome | nada, se o passo 1 foi seguido |
| a pasta `Resumos` | pelo nome | nada, se o passo 5 foi seguido |
| a pasta `inbox` | **ID escrito no `SKILL.md`** | trocar pelo ID novo em `criar-card-drive`, `anotar-feedback-drive` e `compilador-1a1-rotina` |
| a pasta `paineis` | **ID escrito no `SKILL.md`** | trocar pelo ID novo em `rotina-semanal` |
| quem é quem no time | `references/pessoas.md` | regerar (abaixo) |

Uma skill com o ID velho do `inbox` não dá erro: ela continua escrevendo na pasta antiga, e o
card simplesmente nunca chega. É o primeiro lugar para olhar se a captura não aparecer.

**Para regerar a lista do time:** rode **`gerarReferenciaDePessoas`** no editor, copie a saída
do log para `skills/google/references/pessoas.md`, e remonte os zips (ver
`skills/google/README.md`). Faça isso de novo sempre que alguém entrar ou sair do time.

**No claude.ai:**

1. Ative o conector do **Google Drive** com a mesma conta da planilha. As skills leem a
   planilha e escrevem os envelopes por ele.
2. Envie os zips das skills na área de Skills das configurações do claude.ai.
3. As duas rotinas (`rotina-semanal` e `o-que-tenho-hoje-rotina`) só rodam como tarefa
   agendada no claude.ai. Crie os agendamentos lá: a `rotina-semanal` toda segunda de manhã,
   e a `o-que-tenho-hoje-rotina` nos dias úteis de manhã.

Para testar, diga a uma conversa no claude.ai algo como *"preciso revisar o script de
migração até sexta"*. Em até 10 minutos o card aparece no Board.

---

## Checklist final

- [ ] Planilha `Gestão`, fuso São Paulo
- [ ] Projeto Apps Script vinculado, `.clasp.json` apontando para ele, `clasp push` feito
- [ ] 5 pastas criadas, `Resumos` com esse nome exato e única
- [ ] 5 propriedades do script preenchidas
- [ ] 5 abas provisionadas pelos `setupXxx()`
- [ ] `listAgenda()` sem erro de permissão
- [ ] 1 trigger de `processarInbox`
- [ ] Web App publicado como *Eu* / *Somente eu*
- [ ] Time cadastrado, todos com `ativo` marcado
- [ ] `verificarConfiguracao()` termina em `Configuração OK`
- [ ] Envelope de teste virou card
- [ ] Skills com os IDs novos de `inbox` e `paineis`, `pessoas.md` regerado, conector do Drive ativo

---

## Problemas comuns

**`clasp push` falha com "User has not enabled the Apps Script API".**
Falta o passo 0: ativar a API em <https://script.google.com/home/usersettings>. Depois de
ligar, pode levar alguns minutos para valer.

**`clasp push` falha com "Could not find script" ou "Request contains an invalid argument".**
O `scriptId` do `.clasp.json` está errado, ou o `clasp login` foi feito com outra conta. Rode
`clasp logout && clasp login` com a conta dona do projeto.

**O editor mostra dois arquivos `Código` e nada roda ("Identifier has already been declared").**
O git deste repositório guarda o `src/Código.js` com duas grafias Unicode do "ó". No macOS
elas viram um arquivo só; em Linux ou Windows o clone traz dois, o `clasp push` sobe os dois,
e a constante duplicada derruba o projeto inteiro. Apague um deles no editor, ou remova a
entrada duplicada do índice do git.

**A tela do app mostra "does not have permission to perform that action".**
Algum escopo não foi autorizado no editor. Rode a função correspondente no editor (por
exemplo `listAgenda`) e aceite a tela de acesso. O Web App passa a funcionar sem republicar.

**Mudei o código, dei `clasp push`, e a tela não mudou.**
O `/exec` serve a versão **implantada**, não a última enviada. *Implantar → Gerenciar
implantações → lápis → Versão: Nova → Implantar*. Detalhe em [DEPLOY.md](DEPLOY.md#2-publicar-uma-versão-nova).

**As telas de Anotações e Resumos estão vazias.**
Ninguém está com `ativo` marcado na aba `Pessoas`. O `verificarConfiguracao()` acusa.

**A captura pelo claude.ai não vira card.**
Ordem de checagem: o arquivo chegou no `inbox` **desta** instalação (ou foi para a pasta do
ID antigo)? Foi para `erros`? A aba `Log` diz o motivo. Mais casos no
[runbook](DEPLOY.md#3-runbook).
