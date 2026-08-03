# Instalar e publicar

Como subir o sistema numa conta Google de verdade. Para só ver funcionando, você quer
[EXECUTAR.md](EXECUTAR.md) — não precisa de nada disto.

---

## 1. Instalar do zero

### Pré-requisitos

- Uma conta Google com Drive e Sheets.
- `clasp` instalado (`npm i -g @google/clasp`) e autenticado (`clasp login`).

### Passo a passo

**1. Crie a planilha.** Uma planilha nova, chamada **`Gestão`**. O nome importa: as
skills a procuram por nome, nunca por ID.

**2. Crie o projeto Apps Script vinculado a ela.** Em *Extensões → Apps Script*. Ele
precisa ser **bound** à planilha — é o que permite `SpreadsheetApp.getActiveSpreadsheet()`
e dispensa ID hardcoded no código.

**3. Ligue o `clasp`.** Copie o ID do script (*Configurações do projeto → ID do script*) e
crie o `.clasp.json` na raiz deste repositório:

```json
{
  "scriptId": "COLE_O_ID_AQUI",
  "rootDir": "src",
  "scriptExtensions": [".js", ".gs"],
  "htmlExtensions": [".html"],
  "jsonExtensions": [".json"],
  "filePushOrder": [],
  "skipSubdirectories": false
}
```

> `rootDir: "src"` é o que faz o clasp enxergar só o código do Apps Script. `mock/`,
> `test/` e o resto ficam de fora por construção, e não por uma lista de exclusão que
> alguém precisa lembrar de manter.

**4. Suba o código.**

```bash
clasp push
```

**5. Crie as pastas no Drive.** Cinco, em qualquer lugar:

| Pasta | Para quê |
|---|---|
| `inbox` | onde a captura larga os envelopes |
| `processados` | para onde o envelope vai depois de virar linha |
| `erros` | envelope que falhou, com o motivo na aba `Log` |
| `paineis` | os HTMLs semanais |
| `Resumos` | uma subpasta por pessoa, com os compilados de 1:1 |

**6. Registre os IDs.** Em *Configurações do projeto → Propriedades do script*, uma
entrada por pasta. O ID é o trecho final da URL da pasta no Drive.

```
INBOX_FOLDER_ID          PROCESSADOS_FOLDER_ID    ERROS_FOLDER_ID
PAINEL_FOLDER_ID         RESUMOS_FOLDER_ID
```

**7. Provisione as abas.** No editor, rode uma vez cada:

```
setupKanban()   setupPessoas()   setupAnotacoes()   setupLog()
```

A primeira execução pede autorização. Os quatro são **idempotentes** — rodar de novo
converge no mesmo estado e não apaga nada.

**8. Cadastre o time.** Na aba `Pessoas`, uma linha por pessoa. E **marque a caixa
`ativo`**: booleano vazio lê como `false`, então quem não for marcado não aparece no app.

**9. Instale o trigger.**

```
instalarTriggers()
```

Cria o agendamento de 10 minutos do `processarInbox`. É idempotente: remove os do próprio
handler antes de recriar, e não toca em trigger de outro handler.

**10. Confira.**

```
verificarConfiguracao()
```

Percorre as cinco pastas (testando escrita nas três da ingestão), as quatro abas, o
trigger e a contagem de pessoas ativas. O log diz exatamente o que falta.

**11. Publique o Web App.** *Implantar → Nova implantação → App da Web*.
Execute como **você**, acesso conforme a sua necessidade. A URL `/exec` é o app.

---

## 2. Publicar uma versão nova

```bash
npm test          # nada sobe com teste vermelho
clasp push
```

> ### ⚠️ `clasp push` não atualiza a URL `/exec`
>
> O push troca o código no projeto. O Web App continua servindo **a versão publicada** até
> alguém criar uma nova implantação. É o erro mais comum aqui: o código está certo, o
> teste passa, e a tela não muda.
>
> Para publicar: *Implantar → Gerenciar implantações → editar (lápis) → Versão: Nova →
> Implantar*. Isso mantém a mesma URL.
>
> A URL `/dev` sempre serve o código mais recente, e é a que serve para conferir antes.

### Depois de subir

- **Escopo novo pede reautorização.** Se a versão introduziu um serviço que o projeto não
  usava (`DocumentApp`, por exemplo), a primeira execução pede autorização de novo. Não é
  problema, mas não pode ser surpresa.
- **Coluna nova no schema** exige rodar o `setupXxx` da aba correspondente. A guarda de
  cabeçalho aceita acréscimo à direita sem tocar no dado existente — ver
  [ARQUITETURA.md](ARQUITETURA.md#26-a-guarda-de-cabeçalho).
- **Coluna removida do schema não some da planilha.** `ajustarGrade_` só apara coluna
  excedente em aba nova. Apagar é manual, e o momento barato é enquanto ela ainda é a
  última à direita.

---

## 3. Runbook

**O card não aparece depois da captura.**
Ordem de checagem: o arquivo ainda está no `inbox`? Foi para `erros`? A aba `Log` diz o
motivo. Se o arquivo sumiu do inbox e nada apareceu, procure por `ErroDuplicado` no Log —
`origem_id` repetido é ignorado de propósito.

**A tela não reflete o que eu acabei de mudar no código.**
Web App não republicado. Ver o aviso acima.

**`getLastRow()` está devolvendo 1000.**
Comportamento esperado, não bug — a validação aplicada no corpo inteiro faz o Sheets
contar linha em branco como conteúdo. O código nunca deve usar `getLastRow()` para
posicionar escrita.

**Todo mundo sumiu das telas de Anotações e Resumos.**
A coluna `ativo` está desmarcada. `verificarConfiguracao()` acusa isso explicitamente.

**`setupXxx` abortou com "não bate com o contrato".**
A guarda impediu uma reescrita de cabeçalho sobre dados. Corrija o cabeçalho à mão, ou
esvazie/renomeie a aba, e rode de novo. Nada foi alterado.

---

## 4. Rollback

O sistema foi migrado de outra ferramenta com estratégia de **congela e corta** — a
origem virou somente leitura e serviu de rede por um ciclo.

A coluna `notion_id` é o que torna o rollback endereçável: **`notion_id` vazio significa
"nasceu aqui"**. Se o ciclo de validação der errado, são essas linhas — e só elas — que
precisam voltar. O delta se identifica sozinho, sem depender de data nem de título.

`src/Migracao.js` é descartável e sai quando o ciclo fechar, junto com a
`DUMPS_FOLDER_ID`.
