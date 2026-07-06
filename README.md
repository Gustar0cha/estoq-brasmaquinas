# estoq-api

Backend do app **BRAS CHECK** (conferência de estoque). Expõe a API REST que
o app mobile consome, autentica usuários, guarda no Postgres a camada de
"conferência" (atribuição, itens conferidos, divergências) e busca as
movimentações (notas de entrada/saída) reais via **API Gateway do Sankhya**
(OAuth2 + `DbExplorerSP.executeQuery`).

## Arquitetura

O Sankhya é a fonte da verdade para **o que existe** (nota, itens, quantidade
esperada). Este backend **não duplica** esses dados — ele os busca ao vivo
via `src/sankhya/client.ts` e só guarda no Postgres o que é específico deste
app e que o Sankhya não tem:

- `usuarios` — login/senha dos operadores e admins (independente do Sankhya)
- `movimentacao_atribuicoes` — qual usuário é responsável por conferir cada nota
- `conferencia_resultados` + `itens_conferidos` + `divergencias` — o resultado
  de cada conferência física finalizada

`src/services/movimentacoes.service.ts` é quem combina as duas fontes antes
de responder ao app.

## Configurar e rodar

```bash
npm install
cp .env.example .env   # depois preencha com os dados reais da VPS
```

Edite o `.env` (nunca cole esses valores em chat/conversas — só no arquivo local):

- `DATABASE_URL`: string de conexão do Postgres da VPS da empresa
- `JWT_SECRET`: qualquer string longa e aleatória (ex: `openssl rand -hex 32`)
- `SANKHYA_AMBIENTE`: `sandbox` ou `producao` — comece com sandbox
- `SANKHYA_CLIENT_ID` / `SANKHYA_CLIENT_SECRET`: gerados na "Área do
  desenvolvedor" do Sankhya (aba da solução, ex: "ApiConferenciaEstoque")
- `SANKHYA_X_TOKEN`: token gerado na tela "Configurações do Gateway" do
  Sankhya Om
- `SANKHYA_CODEMP`: código da empresa no Sankhya (padrão `1`)
- `SANKHYA_DIAS_HISTORICO`: quantos dias pra trás buscar notas na listagem (padrão `30`)

Depois:

```bash
npm run prisma:migrate   # cria as tabelas no Postgres
npm run prisma:seed      # cria usuários de exemplo (admin/joao/maria, senha 1234)
npm run dev               # sobe o servidor em modo desenvolvimento (porta 3000)
```

`npm run build && npm start` para rodar a versão compilada (produção).

## Integração com o Sankhya (`src/sankhya/`)

- `src/sankhya/auth.ts`: autentica via OAuth2 `client_credentials` em
  `POST {baseUrl}/authenticate` e mantém o bearer token em cache até expirar
  (renovando um pouco antes do prazo).
- `src/sankhya/gateway.ts`: executa SQL via `DbExplorerSP.executeQuery` e já
  converte a resposta (formato `fieldsMetadata` + `rows`) em objetos comuns.
- `src/sankhya/client.ts`: a query real, adaptada da consulta de dashboard já
  usada no Sankhya de vocês (`TGFCAB`/`TGFITE`/`TGFPRO`/`TGFTOP`, com a mesma
  regra de `ENTRADA`/`SAIDA` por `CODTIPOPER`/`ATUALEST`).

> Esse serviço não aceita bind parameters — os valores de filtro (empresa,
> datas, número da nota) são interpolados diretamente no SQL, sempre a partir
> de números validados (`Number.isFinite`) ou datas construídas pelo próprio
> código, nunca de texto vindo direto do usuário.

✅ **Testado com dados reais de produção** — `parceiro` (`TGFPAR.NOMEPARC`) e
`unidade` (`TGFPRO.CODVOL`, que já vem como sigla — ex: "UN" — neste ambiente)
retornam corretamente. `codigoBarras` não é buscado (`TGFPRO.CODBARRA` não
existe neste ambiente e o app não usa mais leitura de código de barras) —
fica sempre `""`.

O restante da query (cabeçalho, itens, tipo de operação, filtro de empresa/
status) veio direto da consulta que vocês já usam — sem suposições.

Nenhum outro arquivo do backend depende de como isso é buscado — rotas e
`services/movimentacoes.service.ts` só conhecem o formato `MovimentacaoSankhya`
(`src/sankhya/types.ts`).

## Endpoints

Autenticação: `Authorization: Bearer <token>` (retornado por `/auth/login`).
Rotas marcadas com 🔒 exigem papel `ADMIN`.

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/login` | `{ login, senha }` → `{ token, usuario }` |
| POST | `/auth/logout` | No-op (autenticação é stateless/JWT) |
| GET | `/usuarios?role=OPERADOR` | Lista operadores (para o seletor de atribuição) |
| GET | `/movimentacoes?tipo=&status=&atribuidoPara=` | Lista movimentações |
| GET | `/movimentacoes/:id` | Detalhe de uma movimentação |
| POST | `/movimentacoes/:id/conferencia` | Envia o resultado de uma conferência |
| PATCH | `/movimentacoes/:id/atribuicao` 🔒 | `{ usuarioId }` — atribui/reatribui/remove |
| PATCH | `/movimentacoes/:id/divergencias/:itemId` 🔒 | `{ comentarioAdmin }` |
| GET | `/movimentacoes/indicadores` 🔒 | Contagens para o painel do admin |
| GET | `/divergencias` 🔒 | Todas as divergências registradas, com contexto |

Este contrato é exatamente o que o README do app mobile (`estoq/README.md`)
já documentava como "onde entra a API real" — nenhuma tela do app precisa
mudar, só o `EXPO_PUBLIC_API_URL`/`lib/config.ts` apontando pra cá e o corpo
das funções em `services/*.ts` do app trocando de mock para `fetch`.

## Stack

Node.js + TypeScript + Express 5 + Prisma 7 (driver adapter `@prisma/adapter-pg`,
sem depender de binário nativo) + API Gateway do Sankhya (OAuth2 via `fetch`
nativo) + JWT (`jsonwebtoken`) + `bcryptjs` + `zod` para validação de payloads.
