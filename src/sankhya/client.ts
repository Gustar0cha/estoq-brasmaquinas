import { executarQuery } from './gateway';
import { env } from '../lib/env';
import { DiaReferencia, formatarDiaReferencia } from '../lib/datas';
import { FiltroMovimentacoesSankhya, ItemMovimentacaoSankhya, MovimentacaoSankhya } from './types';

// Integração com o Sankhya via API Gateway (OAuth2 + DbExplorerSP.executeQuery)
// — ver src/sankhya/auth.ts e src/sankhya/gateway.ts. A query abaixo é
// adaptada da consulta usada no dashboard de estoque do Sankhya de vocês
// (TGFCAB/TGFITE/TGFPRO/TGFTOP/TGFPAR).
//
// ATENÇÃO — campos abaixo foram adicionados por cima da query original e
// ainda não foram totalmente confirmados; ajuste só a query se algo vier
// errado — o resto do backend não muda:
//   - PAR.NOMEPARC (nome do parceiro/fornecedor/cliente, join com TGFPAR)
//   - PRO.CODVOL (código de unidade do produto — é o CÓDIGO, não a sigla "UN")
// `codigoBarras` não é buscado (TGFPRO.CODBARRA não existe neste ambiente e
// o app não usa mais leitura de código de barras) — fica sempre "".
//
// `local` vem de TGFLOC.DESCRLOCAL (join por ITE.CODLOCALORIG), igual na
// query original de vocês; se não houver local cadastrado, cai pro código.
//
// `empresaNome` vem de TSIEMP.NOMEFANTASIA (join por CAB.CODEMP) — testado e
// confirmado no ambiente de vocês.
//
// `quantidadeEsperada` vem de TGFEST.ESTOQUE (tabela de estoque atual por
// produto+local+empresa) — NÃO é a quantidade movimentada nesta nota
// (SUM(ITE.QTDNEG)). Isso é proposital: a conferência física compara a
// contagem cega do operador contra o que deveria estar fisicamente no local
// agora, não contra a quantidade que entrou/saiu neste documento específico
// (confirmado testando contra o ambiente real: mesmo produto em locais
// diferentes tem estoques bem diferentes entre si e da quantidade da nota).
//
// Filtros de negócio (pedido pela equipe):
//   - Local tem que começar com "RUA" (é o padrão dos locais de armazenagem
//     físicos de verdade — endereços de rua/prédio/nível). O filtro antigo
//     (excluir "SEM LOCAL"/"AUTO" por texto) deixava passar local que não
//     deveria contar; a equipe trocou por uma allowlist de prefixo + uma
//     lista explícita de códigos de local pra excluir (locais que começam
//     com "RUA" mas são áreas de staging/auto-atendimento, não conferência
//     física de verdade) — ver LOCAIS_EXCLUIDOS_DA_CONFERENCIA abaixo.
//   - Não trazer notas do tipo de operação 700 (CAB.CODTIPOPER).
//   - Não filtra mais por empresa (CAB.CODEMP) — traz todas; o filtro por
//     empresa agora é feito no app, no lado do admin.
//
// O serviço DbExplorerSP.executeQuery só aceita uma string de SQL (sem bind
// parameters separados), então os valores abaixo são interpolados com
// cuidado — todos vêm de números já validados (Number.isFinite) ou de datas
// que nós mesmos construímos, nunca de texto vindo direto do usuário.

interface LinhaMovimentacaoSankhya {
  id: number;
  numeroNota: number;
  tipo: 'ENTRADA' | 'SAIDA' | null;
  parceiro: string | null;
  dataMovimentacao: string;
  empresaCodigo: number;
  empresaNome: string | null;
  codigoProduto: number;
  descricao: string;
  unidade: string | null;
  localCodigo: number;
  local: string | null;
  quantidadeEsperada: number;
}

function formatarDataOracle(data: Date): string {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `TO_DATE('${ano}-${mes}-${dia}', 'YYYY-MM-DD')`;
}

// Versão que parte de um DiaReferencia (ano/mês/dia explícitos) em vez de um
// Date — usada pelas consultas de conferência diária pra nunca depender do
// fuso horário do processo Node (ver src/lib/datas.ts).
function formatarDiaReferenciaOracle(diaRef: DiaReferencia): string {
  return `TO_DATE('${formatarDiaReferencia(diaRef)}', 'YYYY-MM-DD')`;
}

function montarSelectBase(): string {
  return `
    SELECT
      CAB.NUNOTA           AS "id",
      CAB.NUNOTA           AS "numeroNota",
      CASE
        WHEN CAB.CODTIPOPER = 800 THEN 'SAIDA'
        WHEN TOP.ATUALEST = 'E' THEN 'ENTRADA'
        WHEN TOP.ATUALEST = 'B' THEN 'SAIDA'
      END AS "tipo",
      PAR.NOMEPARC         AS "parceiro",
      TO_CHAR(CAB.DTNEG, 'YYYY-MM-DD"T"HH24:MI:SS') AS "dataMovimentacao",
      CAB.CODEMP           AS "empresaCodigo",
      EMP.NOMEFANTASIA     AS "empresaNome",
      ITE.CODPROD          AS "codigoProduto",
      PRO.DESCRPROD        AS "descricao",
      PRO.CODVOL           AS "unidade",
      ITE.CODLOCALORIG     AS "localCodigo",
      COALESCE(LOC.DESCRLOCAL, TO_CHAR(ITE.CODLOCALORIG)) AS "local",
      MAX((
        SELECT NVL(SUM(EST.ESTOQUE), 0)
        FROM TGFEST EST
        WHERE EST.CODPROD = ITE.CODPROD
          AND EST.CODLOCAL = ITE.CODLOCALORIG
          AND EST.CODEMP = CAB.CODEMP
      )) AS "quantidadeEsperada"
    FROM TGFCAB CAB
    INNER JOIN TGFITE ITE ON CAB.NUNOTA = ITE.NUNOTA
    INNER JOIN TGFPRO PRO ON ITE.CODPROD = PRO.CODPROD
    INNER JOIN TGFTOP TOP ON CAB.CODTIPOPER = TOP.CODTIPOPER AND CAB.DHTIPOPER = TOP.DHALTER
    LEFT JOIN TGFPAR PAR ON CAB.CODPARC = PAR.CODPARC
    LEFT JOIN TGFLOC LOC ON ITE.CODLOCALORIG = LOC.CODLOCAL
    LEFT JOIN TSIEMP EMP ON CAB.CODEMP = EMP.CODEMP
  `;
}

const GROUP_BY = `
  GROUP BY
    CAB.NUNOTA, CAB.CODTIPOPER, TOP.ATUALEST, PAR.NOMEPARC, CAB.DTNEG,
    CAB.CODEMP, EMP.NOMEFANTASIA,
    ITE.CODPROD, PRO.DESCRPROD, PRO.CODVOL, ITE.CODLOCALORIG, LOC.DESCRLOCAL
`;

// Códigos de local (ITE.CODLOCALORIG) que começam com "RUA" mas não devem
// contar pra conferência física (áreas de staging/auto-atendimento etc.) —
// lista passada pela equipe de estoque, atualizada em 2026-08-06.
const LOCAIS_EXCLUIDOS_DA_CONFERENCIA = [
  298012, 298005, 298006, 298004, 298001, 298002, 298003, 298013,
  297001, 298043, 199000, 298018, 298017, 298011, 298044, 298040,
  5006010, 298046, 298055, 298047, 298048, 298049, 298050, 298051,
  298052, 298053, 298054, 298056, 298045, 105997, 298042, 298007,
];

// Aplicados em toda consulta ao Sankhya (lista e por ID) — ver motivos no
// comentário no topo do arquivo.
const FILTROS_COMUNS = `
  AND ITE.CODLOCALORIG NOT IN (${LOCAIS_EXCLUIDOS_DA_CONFERENCIA.join(', ')})
  AND UPPER(LOC.DESCRLOCAL) LIKE 'RUA%'
  AND CAB.CODTIPOPER NOT IN (700)
`;

function agruparPorNota(linhas: LinhaMovimentacaoSankhya[]): MovimentacaoSankhya[] {
  const porNota = new Map<string, MovimentacaoSankhya>();

  for (const linha of linhas) {
    // Linhas sem ENTRADA/SAIDA definidas não deveriam ocorrer (o WHERE já
    // filtra só operações que mexem estoque), mas ignoramos defensivamente.
    if (!linha.tipo) continue;

    const id = String(linha.id);
    let movimentacao = porNota.get(id);

    if (!movimentacao) {
      movimentacao = {
        id,
        numeroNota: String(linha.numeroNota),
        tipo: linha.tipo,
        parceiro: linha.parceiro ?? 'Não identificado',
        dataMovimentacao: linha.dataMovimentacao,
        empresaCodigo: String(linha.empresaCodigo),
        empresaNome: linha.empresaNome ?? `Empresa ${linha.empresaCodigo}`,
        itens: [],
      };
      porNota.set(id, movimentacao);
    }

    const item: ItemMovimentacaoSankhya = {
      // Inclui o local no id: o mesmo produto pode aparecer em mais de um
      // local dentro da mesma nota (linhas diferentes), e cada linha precisa
      // de um id único — senão a contagem de uma linha "vaza" pra outra.
      id: `${id}-${linha.codigoProduto}-${linha.localCodigo}`,
      codigoProduto: String(linha.codigoProduto),
      codigoBarras: '',
      descricao: linha.descricao,
      unidade: linha.unidade ?? '',
      local: linha.local ?? '',
      quantidadeEsperada: linha.quantidadeEsperada,
    };
    movimentacao.itens.push(item);
  }

  return Array.from(porNota.values());
}

export async function getMovimentacoesSankhya(
  filtro?: FiltroMovimentacoesSankhya
): Promise<MovimentacaoSankhya[]> {
  const dataFim = new Date();
  const dataInicio = new Date(dataFim);
  dataInicio.setDate(dataInicio.getDate() - env.sankhya.diasHistorico);

  const sql = `
    ${montarSelectBase()}
    WHERE
      CAB.STATUSNOTA = 'L'
      AND (TOP.ATUALEST IN ('B', 'E') OR CAB.CODTIPOPER = 800)
      AND TRUNC(CAB.DTNEG) BETWEEN ${formatarDataOracle(dataInicio)} AND ${formatarDataOracle(dataFim)}
      ${FILTROS_COMUNS}
    ${GROUP_BY}
    ORDER BY CAB.DTNEG DESC, CAB.NUNOTA DESC
  `;

  const linhas = await executarQuery<LinhaMovimentacaoSankhya>(sql);
  const movimentacoes = agruparPorNota(linhas);

  if (filtro?.tipo) {
    return movimentacoes.filter((m) => m.tipo === filtro.tipo);
  }
  return movimentacoes;
}

export async function getMovimentacaoSankhyaPorId(id: string): Promise<MovimentacaoSankhya | null> {
  const nunota = Number(id);
  if (!Number.isFinite(nunota)) {
    return null;
  }

  const sql = `
    ${montarSelectBase()}
    WHERE
      CAB.NUNOTA = ${nunota}
      AND CAB.STATUSNOTA = 'L'
      ${FILTROS_COMUNS}
    ${GROUP_BY}
    ORDER BY ITE.CODPROD
  `;

  const linhas = await executarQuery<LinhaMovimentacaoSankhya>(sql);
  const [movimentacao] = agruparPorNota(linhas);
  return movimentacao ?? null;
}

export interface MovimentoDiarioSankhya {
  codigoProduto: string;
  descricao: string;
  localCodigo: string;
  local: string;
  empresaCodigo: string;
  empresaNome: string;
  entradas: number;
  saidas: number;
  // Estoque no snapshot diário do Sankhya (TGFCTE) mais recente ANTERIOR à
  // data pedida — a cópia não roda todo dia, então "anterior" é o último
  // disponível, não necessariamente D-1 exato.
  estoqueAnterior: number;
}

interface LinhaMovimentoDiarioSankhya {
  codigoProduto: number;
  descricao: string;
  localCodigo: number;
  local: string | null;
  empresaCodigo: number;
  empresaNome: string | null;
  entradas: number;
  saidas: number;
  estoqueAnterior: number;
}

// Movimento agregado por produto+local+empresa num único dia — base da
// conferência diária de estoque (cópia do dia anterior + entradas − saídas,
// comparado contra a contagem física feita no app). Mesmos filtros de
// negócio da consulta de movimentações (local válido, sem CODTIPOPER 700).
export async function getMovimentoDiarioSankhya(diaRef: DiaReferencia): Promise<MovimentoDiarioSankhya[]> {
  const dataOracle = formatarDiaReferenciaOracle(diaRef);
  const sql = `
    SELECT
      ITE.CODPROD          AS "codigoProduto",
      PRO.DESCRPROD         AS "descricao",
      ITE.CODLOCALORIG      AS "localCodigo",
      COALESCE(LOC.DESCRLOCAL, TO_CHAR(ITE.CODLOCALORIG)) AS "local",
      CAB.CODEMP            AS "empresaCodigo",
      EMP.NOMEFANTASIA      AS "empresaNome",
      SUM(CASE WHEN CAB.CODTIPOPER != 800 AND TOP.ATUALEST = 'E' THEN ITE.QTDNEG ELSE 0 END) AS "entradas",
      SUM(CASE WHEN CAB.CODTIPOPER = 800 OR TOP.ATUALEST = 'B' THEN ITE.QTDNEG ELSE 0 END) AS "saidas",
      (SELECT NVL(MAX(CTE.QTDEST), 0)
       FROM TGFCTE CTE
       WHERE CTE.CODPROD = ITE.CODPROD AND CTE.CODLOCAL = ITE.CODLOCALORIG AND CTE.CODEMP = CAB.CODEMP
         AND CTE.DTCONTAGEM = (
           SELECT MAX(CTE2.DTCONTAGEM) FROM TGFCTE CTE2
           WHERE CTE2.CODPROD = ITE.CODPROD AND CTE2.CODLOCAL = ITE.CODLOCALORIG AND CTE2.CODEMP = CAB.CODEMP
             AND CTE2.DTCONTAGEM < ${dataOracle}
         )
      ) AS "estoqueAnterior"
    FROM TGFCAB CAB
    INNER JOIN TGFITE ITE ON CAB.NUNOTA = ITE.NUNOTA
    INNER JOIN TGFPRO PRO ON ITE.CODPROD = PRO.CODPROD
    INNER JOIN TGFTOP TOP ON CAB.CODTIPOPER = TOP.CODTIPOPER AND CAB.DHTIPOPER = TOP.DHALTER
    LEFT JOIN TGFLOC LOC ON ITE.CODLOCALORIG = LOC.CODLOCAL
    LEFT JOIN TSIEMP EMP ON CAB.CODEMP = EMP.CODEMP
    WHERE CAB.STATUSNOTA = 'L'
      AND (TOP.ATUALEST IN ('B', 'E') OR CAB.CODTIPOPER = 800)
      AND TRUNC(CAB.DTNEG) = TRUNC(${dataOracle})
      ${FILTROS_COMUNS}
    GROUP BY ITE.CODPROD, PRO.DESCRPROD, ITE.CODLOCALORIG, LOC.DESCRLOCAL, CAB.CODEMP, EMP.NOMEFANTASIA
  `;

  const linhas = await executarQuery<LinhaMovimentoDiarioSankhya>(sql);

  return linhas.map((linha) => ({
    codigoProduto: String(linha.codigoProduto),
    descricao: linha.descricao,
    localCodigo: String(linha.localCodigo),
    local: linha.local ?? '',
    empresaCodigo: String(linha.empresaCodigo),
    empresaNome: linha.empresaNome ?? `Empresa ${linha.empresaCodigo}`,
    entradas: linha.entradas,
    saidas: linha.saidas,
    estoqueAnterior: linha.estoqueAnterior,
  }));
}

export interface ItemCopiaEstoqueSankhya {
  codigoProduto: string;
  descricao: string;
  unidade: string;
  localCodigo: string;
  local: string;
  empresaCodigo: string;
  empresaNome: string;
  quantidadeEsperada: number;
  dataCopiaEstoque: string | null;
}

interface LinhaCopiaEstoqueSankhya {
  codigoProduto: number;
  descricao: string;
  unidade: string | null;
  localCodigo: number;
  local: string | null;
  empresaCodigo: number;
  empresaNome: string | null;
  quantidadeEsperada: number;
  dataCopiaEstoque: string | null;
}

// Contagem física livre: o colaborador bipa o código do produto e o código
// do local, e a gente busca a última cópia de estoque (TGFCTE) só daquele
// par produto+local — não precisa mais carregar o estoque inteiro (>11 mil
// linhas, e o gateway do Sankhya trunca em 5000 por chamada de qualquer
// forma), é uma consulta pontual de 1 linha. Mesmos filtros de local das
// outras consultas (só "RUA%" de verdade, excluindo staging/auto-atendimento)
// — se o colaborador bipar um local fora dessas regras, não encontra nada.
export async function getItemCopiaEstoque(
  codigoProduto: string,
  localCodigo: string
): Promise<ItemCopiaEstoqueSankhya | null> {
  const produto = Number(codigoProduto);
  const local = Number(localCodigo);
  if (!Number.isFinite(produto) || !Number.isFinite(local)) {
    return null;
  }

  const sql = `
    SELECT
      CTE.CODPROD          AS "codigoProduto",
      PRO.DESCRPROD        AS "descricao",
      PRO.CODVOL           AS "unidade",
      CTE.CODLOCAL         AS "localCodigo",
      COALESCE(LOC.DESCRLOCAL, TO_CHAR(CTE.CODLOCAL)) AS "local",
      CTE.CODEMP           AS "empresaCodigo",
      EMP.NOMEFANTASIA     AS "empresaNome",
      CTE.QTDEST           AS "quantidadeEsperada",
      TO_CHAR(CTE.DTCONTAGEM, 'YYYY-MM-DD"T"HH24:MI:SS') AS "dataCopiaEstoque"
    FROM TGFCTE CTE
    INNER JOIN TGFPRO PRO ON CTE.CODPROD = PRO.CODPROD
    LEFT JOIN TGFLOC LOC ON CTE.CODLOCAL = LOC.CODLOCAL
    LEFT JOIN TSIEMP EMP ON CTE.CODEMP = EMP.CODEMP
    WHERE CTE.CODPROD = ${produto}
      AND CTE.CODLOCAL = ${local}
      AND CTE.CODLOCAL NOT IN (${LOCAIS_EXCLUIDOS_DA_CONFERENCIA.join(', ')})
      AND UPPER(LOC.DESCRLOCAL) LIKE 'RUA%'
      AND CTE.DTCONTAGEM = (
        SELECT MAX(CTE2.DTCONTAGEM) FROM TGFCTE CTE2
        WHERE CTE2.CODPROD = CTE.CODPROD AND CTE2.CODLOCAL = CTE.CODLOCAL AND CTE2.CODEMP = CTE.CODEMP
      )
    ORDER BY CTE.DTCONTAGEM DESC
    FETCH FIRST 1 ROWS ONLY
  `;

  const [linha] = await executarQuery<LinhaCopiaEstoqueSankhya>(sql);
  if (!linha) return null;

  return {
    codigoProduto: String(linha.codigoProduto),
    descricao: linha.descricao,
    unidade: linha.unidade ?? '',
    localCodigo: String(linha.localCodigo),
    local: linha.local ?? '',
    empresaCodigo: String(linha.empresaCodigo),
    empresaNome: linha.empresaNome ?? `Empresa ${linha.empresaCodigo}`,
    quantidadeEsperada: linha.quantidadeEsperada,
    dataCopiaEstoque: linha.dataCopiaEstoque,
  };
}

export interface EstoqueAnteriorDetalhe {
  data: string | null; // dia (YYYY-MM-DD) do snapshot TGFCTE usado — null se nunca houve cópia
  quantidade: number;
}

export interface MovimentoDetalheSankhya {
  numeroNota: string;
  tipo: 'ENTRADA' | 'SAIDA';
  parceiro: string;
  quantidade: number;
  dataMovimentacao: string;
}

export interface DetalheConferenciaDiariaSankhya {
  estoqueAnterior: EstoqueAnteriorDetalhe;
  movimentos: MovimentoDetalheSankhya[];
}

interface LinhaCopiaAnteriorSankhya {
  data: string | null;
  quantidade: number;
}

interface LinhaMovimentoDetalheSankhya {
  numeroNota: number;
  tipo: 'ENTRADA' | 'SAIDA' | null;
  parceiro: string | null;
  quantidade: number;
  dataMovimentacao: string;
}

// Drill-down de uma linha da conferência diária: qual cópia (TGFCTE) foi
// usada como "estoque anterior" e quais notas, uma a uma, formam os totais
// de entrada/saída daquele dia — pra dar pra auditar/validar a conta com
// alguém de fora do time técnico (ex: a gerência).
export async function getDetalheConferenciaDiariaSankhya(
  diaRef: DiaReferencia,
  codigoProduto: string,
  localCodigo: string,
  empresaCodigo: string
): Promise<DetalheConferenciaDiariaSankhya> {
  const dataOracle = formatarDiaReferenciaOracle(diaRef);
  const produto = Number(codigoProduto);
  const local = Number(localCodigo);
  const empresa = Number(empresaCodigo);

  const sqlCopia = `
    SELECT TO_CHAR(CTE.DTCONTAGEM, 'YYYY-MM-DD') AS "data", CTE.QTDEST AS "quantidade"
    FROM TGFCTE CTE
    WHERE CTE.CODPROD = ${produto} AND CTE.CODLOCAL = ${local} AND CTE.CODEMP = ${empresa}
      AND CTE.DTCONTAGEM = (
        SELECT MAX(CTE2.DTCONTAGEM) FROM TGFCTE CTE2
        WHERE CTE2.CODPROD = ${produto} AND CTE2.CODLOCAL = ${local} AND CTE2.CODEMP = ${empresa}
          AND CTE2.DTCONTAGEM < ${dataOracle}
      )
  `;

  const sqlMovimentos = `
    SELECT
      CAB.NUNOTA AS "numeroNota",
      CASE
        WHEN CAB.CODTIPOPER = 800 THEN 'SAIDA'
        WHEN TOP.ATUALEST = 'E' THEN 'ENTRADA'
        WHEN TOP.ATUALEST = 'B' THEN 'SAIDA'
      END AS "tipo",
      PAR.NOMEPARC AS "parceiro",
      ITE.QTDNEG AS "quantidade",
      TO_CHAR(CAB.DTNEG, 'YYYY-MM-DD"T"HH24:MI:SS') AS "dataMovimentacao"
    FROM TGFCAB CAB
    INNER JOIN TGFITE ITE ON CAB.NUNOTA = ITE.NUNOTA
    INNER JOIN TGFTOP TOP ON CAB.CODTIPOPER = TOP.CODTIPOPER AND CAB.DHTIPOPER = TOP.DHALTER
    LEFT JOIN TGFPAR PAR ON CAB.CODPARC = PAR.CODPARC
    WHERE CAB.STATUSNOTA = 'L'
      AND (TOP.ATUALEST IN ('B', 'E') OR CAB.CODTIPOPER = 800)
      AND TRUNC(CAB.DTNEG) = TRUNC(${dataOracle})
      AND ITE.CODPROD = ${produto}
      AND ITE.CODLOCALORIG = ${local}
      AND CAB.CODEMP = ${empresa}
      AND CAB.CODTIPOPER NOT IN (700)
    ORDER BY CAB.DTNEG
  `;

  const [linhasCopia, linhasMovimentos] = await Promise.all([
    executarQuery<LinhaCopiaAnteriorSankhya>(sqlCopia),
    executarQuery<LinhaMovimentoDetalheSankhya>(sqlMovimentos),
  ]);

  return {
    estoqueAnterior: {
      data: linhasCopia[0]?.data ?? null,
      quantidade: linhasCopia[0]?.quantidade ?? 0,
    },
    movimentos: linhasMovimentos
      .filter((l): l is LinhaMovimentoDetalheSankhya & { tipo: 'ENTRADA' | 'SAIDA' } => l.tipo !== null)
      .map((l) => ({
        numeroNota: String(l.numeroNota),
        tipo: l.tipo,
        parceiro: l.parceiro ?? 'Não identificado',
        quantidade: l.quantidade,
        dataMovimentacao: l.dataMovimentacao,
      })),
  };
}
