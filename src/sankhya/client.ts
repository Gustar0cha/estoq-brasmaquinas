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
// do local — a gente só precisa IDENTIFICAR o que ele está contando, não
// validar contra um cadastro fechado ou contra listas de local "permitido"
// (essas listas/filtro "RUA%" existem só pra a listagem de conferência por
// movimentação, ver FILTROS_COMUNS — aqui não se aplicam: o colaborador pode
// contar qualquer local físico que exista em TGFLOC). TGFCTE (cópia de
// estoque oficial) só tem linha pra produto+local que já passou por uma
// contagem física antes, e TGFEST só tem linha pra combinações que já
// tiveram alguma movimentação — as duas são sparse, e a maior parte das
// prateleiras válidas nunca teve nenhuma das duas registradas pra ESSE
// produto específico (é exatamente o caso mais comum de uma contagem
// física: achar um produto num lugar que o sistema não sabia que tinha).
// Tenta TGFCTE primeiro (retrato "oficial"), depois TGFEST (estoque atual ao
// vivo); se nenhuma das duas tiver a combinação exata, ainda assim libera a
// contagem contanto que o produto e o local individualmente existam — só não
// dá pra saber a empresa (CODEMP não existe em TGFLOC), então busca em
// qualquer local onde esse produto já tenha estoque pra descobrir a qual
// empresa ele pertence; quantidadeEsperada nasce 0 (sistema não tinha nada
// registrado ali).
export async function getItemCopiaEstoque(
  codigoProduto: string,
  localCodigo: string
): Promise<ItemCopiaEstoqueSankhya | null> {
  const produto = Number(codigoProduto);
  const local = Number(localCodigo);
  if (!Number.isFinite(produto) || !Number.isFinite(local)) {
    return null;
  }

  const sqlCopia = `
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
      AND CTE.DTCONTAGEM = (
        SELECT MAX(CTE2.DTCONTAGEM) FROM TGFCTE CTE2
        WHERE CTE2.CODPROD = CTE.CODPROD AND CTE2.CODLOCAL = CTE.CODLOCAL AND CTE2.CODEMP = CTE.CODEMP
      )
    ORDER BY CTE.DTCONTAGEM DESC
    FETCH FIRST 1 ROWS ONLY
  `;

  const [linhaCopia] = await executarQuery<LinhaCopiaEstoqueSankhya>(sqlCopia);
  if (linhaCopia) {
    return {
      codigoProduto: String(linhaCopia.codigoProduto),
      descricao: linhaCopia.descricao,
      unidade: linhaCopia.unidade ?? '',
      localCodigo: String(linhaCopia.localCodigo),
      local: linhaCopia.local ?? '',
      empresaCodigo: String(linhaCopia.empresaCodigo),
      empresaNome: linhaCopia.empresaNome ?? `Empresa ${linhaCopia.empresaCodigo}`,
      quantidadeEsperada: linhaCopia.quantidadeEsperada,
      dataCopiaEstoque: linhaCopia.dataCopiaEstoque,
    };
  }

  const sqlEstoqueAtual = `
    SELECT
      EST.CODPROD          AS "codigoProduto",
      MAX(PRO.DESCRPROD)   AS "descricao",
      MAX(PRO.CODVOL)      AS "unidade",
      EST.CODLOCAL         AS "localCodigo",
      MAX(COALESCE(LOC.DESCRLOCAL, TO_CHAR(EST.CODLOCAL))) AS "local",
      EST.CODEMP           AS "empresaCodigo",
      MAX(EMP.NOMEFANTASIA) AS "empresaNome",
      NVL(SUM(EST.ESTOQUE), 0) AS "quantidadeEsperada"
    FROM TGFEST EST
    INNER JOIN TGFPRO PRO ON EST.CODPROD = PRO.CODPROD
    LEFT JOIN TGFLOC LOC ON EST.CODLOCAL = LOC.CODLOCAL
    LEFT JOIN TSIEMP EMP ON EST.CODEMP = EMP.CODEMP
    WHERE EST.CODPROD = ${produto}
      AND EST.CODLOCAL = ${local}
    GROUP BY EST.CODPROD, EST.CODLOCAL, EST.CODEMP
    FETCH FIRST 1 ROWS ONLY
  `;

  const [linhaEstoque] = await executarQuery<LinhaCopiaEstoqueSankhya>(sqlEstoqueAtual);
  if (linhaEstoque) {
    return {
      codigoProduto: String(linhaEstoque.codigoProduto),
      descricao: linhaEstoque.descricao,
      unidade: linhaEstoque.unidade ?? '',
      localCodigo: String(linhaEstoque.localCodigo),
      local: linhaEstoque.local ?? '',
      empresaCodigo: String(linhaEstoque.empresaCodigo),
      empresaNome: linhaEstoque.empresaNome ?? `Empresa ${linhaEstoque.empresaCodigo}`,
      quantidadeEsperada: linhaEstoque.quantidadeEsperada,
      dataCopiaEstoque: null,
    };
  }

  return getItemSemHistoricoDeEstoque(produto, local);
}

interface LinhaProdutoSankhya {
  codigoProduto: number;
  descricao: string;
  unidade: string | null;
}

interface LinhaLocalSankhya {
  localCodigo: number;
  local: string | null;
}

interface LinhaEmpresaDoProdutoSankhya {
  empresaCodigo: number;
  empresaNome: string | null;
}

// Produto e local existem e são válidos, mas nunca tiveram TGFCTE nem TGFEST
// pra essa combinação exata — a única coisa que falta é a empresa, que só dá
// pra descobrir olhando onde mais esse produto tem estoque.
async function getItemSemHistoricoDeEstoque(
  produto: number,
  local: number
): Promise<ItemCopiaEstoqueSankhya | null> {
  const sqlProduto = `
    SELECT PRO.CODPROD AS "codigoProduto", PRO.DESCRPROD AS "descricao", PRO.CODVOL AS "unidade"
    FROM TGFPRO PRO
    WHERE PRO.CODPROD = ${produto} AND PRO.ATIVO = 'S'
    FETCH FIRST 1 ROWS ONLY
  `;
  const [linhaProduto] = await executarQuery<LinhaProdutoSankhya>(sqlProduto);
  if (!linhaProduto) return null;

  const sqlLocal = `
    SELECT LOC.CODLOCAL AS "localCodigo", LOC.DESCRLOCAL AS "local"
    FROM TGFLOC LOC
    WHERE LOC.CODLOCAL = ${local}
    FETCH FIRST 1 ROWS ONLY
  `;
  const [linhaLocal] = await executarQuery<LinhaLocalSankhya>(sqlLocal);
  if (!linhaLocal) return null;

  const sqlEmpresaDoProduto = `
    SELECT EST.CODEMP AS "empresaCodigo", MAX(EMP.NOMEFANTASIA) AS "empresaNome"
    FROM TGFEST EST
    LEFT JOIN TSIEMP EMP ON EST.CODEMP = EMP.CODEMP
    WHERE EST.CODPROD = ${produto}
    GROUP BY EST.CODEMP
    FETCH FIRST 1 ROWS ONLY
  `;
  let [linhaEmpresa] = await executarQuery<LinhaEmpresaDoProdutoSankhya>(sqlEmpresaDoProduto);

  // Produto sem nenhuma linha em TGFEST (nunca movimentou, mas já apareceu
  // numa cópia de estoque) — descobre a empresa pela própria cópia. Sem esse
  // fallback o app recusava contar itens legítimos achados na prateleira.
  if (!linhaEmpresa) {
    const sqlEmpresaPelaCopia = `
      SELECT CTE.CODEMP AS "empresaCodigo", MAX(EMP.NOMEFANTASIA) AS "empresaNome"
      FROM TGFCTE CTE
      LEFT JOIN TSIEMP EMP ON CTE.CODEMP = EMP.CODEMP
      WHERE CTE.CODPROD = ${produto}
      GROUP BY CTE.CODEMP
      ORDER BY CTE.CODEMP
      FETCH FIRST 1 ROWS ONLY
    `;
    [linhaEmpresa] = await executarQuery<LinhaEmpresaDoProdutoSankhya>(sqlEmpresaPelaCopia);
  }
  if (!linhaEmpresa) return null;

  return {
    codigoProduto: String(linhaProduto.codigoProduto),
    descricao: linhaProduto.descricao,
    unidade: linhaProduto.unidade ?? '',
    localCodigo: String(linhaLocal.localCodigo),
    local: linhaLocal.local ?? '',
    empresaCodigo: String(linhaEmpresa.empresaCodigo),
    empresaNome: linhaEmpresa.empresaNome ?? `Empresa ${linhaEmpresa.empresaCodigo}`,
    quantidadeEsperada: 0,
    dataCopiaEstoque: null,
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

export interface ProdutoNegativadoSankhya {
  codigoProduto: string;
  descricao: string;
  codigoGrupoProduto: string;
  estoque: number;
  empresaCodigo: string;
  empresaNome: string;
}

interface LinhaProdutoNegativadoSankhya {
  codigoProduto: number;
  descricao: string;
  codigoGrupoProduto: number;
  estoque: number;
  empresaCodigo: number;
  empresaNome: string | null;
}

export interface FiltroProdutosNegativados {
  parceiro?: string;
  grupo?: string;
  empresa?: string;
}

// Consulta passada pela equipe: produtos ativos com estoque negativo (algo
// saiu do sistema sem ter entrada correspondente registrada). Paginado com
// a mesma técnica de getCopiaEstoqueSankhya — o gateway trunca em 5000 por
// chamada, e não dá pra garantir de antemão que negativados sempre fica
// abaixo disso.
export async function getProdutosNegativadosSankhya(
  filtro?: FiltroProdutosNegativados
): Promise<ProdutoNegativadoSankhya[]> {
  const filtroParceiro =
    filtro?.parceiro && Number.isFinite(Number(filtro.parceiro)) ? `AND PRO.CODPARCFORN = ${Number(filtro.parceiro)}` : '';
  const filtroGrupo =
    filtro?.grupo && Number.isFinite(Number(filtro.grupo)) ? `AND PRO.CODGRUPOPROD = ${Number(filtro.grupo)}` : '';
  const filtroEmpresa =
    filtro?.empresa && Number.isFinite(Number(filtro.empresa)) ? `AND EST.CODEMP = ${Number(filtro.empresa)}` : '';

  const todasAsLinhas: LinhaProdutoNegativadoSankhya[] = [];
  let offset = 0;

  while (true) {
    const sql = `
      SELECT
        EST.CODPROD       AS "codigoProduto",
        PRO.DESCRPROD     AS "descricao",
        PRO.CODGRUPOPROD  AS "codigoGrupoProduto",
        EST.ESTOQUE       AS "estoque",
        EST.CODEMP        AS "empresaCodigo",
        EMP.NOMEFANTASIA  AS "empresaNome"
      FROM TGFPRO PRO
      INNER JOIN TGFEST EST ON (PRO.CODPROD = EST.CODPROD)
      INNER JOIN TGFGRU GRU ON (PRO.CODGRUPOPROD = GRU.CODGRUPOPROD)
      INNER JOIN TSIEMP EMP ON (EST.CODEMP = EMP.CODEMP)
      WHERE EST.ESTOQUE < 0
        AND PRO.ATIVO = 'S'
        ${filtroParceiro}
        ${filtroGrupo}
        ${filtroEmpresa}
      ORDER BY EST.CODEMP, PRO.DESCRPROD
      OFFSET ${offset} ROWS FETCH NEXT 5000 ROWS ONLY
    `;

    const pagina = await executarQuery<LinhaProdutoNegativadoSankhya>(sql);
    todasAsLinhas.push(...pagina);

    if (pagina.length < 5000) break;
    offset += 5000;
  }

  return todasAsLinhas.map((l) => ({
    codigoProduto: String(l.codigoProduto),
    descricao: l.descricao,
    codigoGrupoProduto: String(l.codigoGrupoProduto),
    estoque: l.estoque,
    empresaCodigo: String(l.empresaCodigo),
    empresaNome: l.empresaNome ?? `Empresa ${l.empresaCodigo}`,
  }));
}

interface LinhaLocalComCopiaSankhya {
  localCodigo: number;
  local: string | null;
  empresaCodigo: number;
  empresaNome: string | null;
  totalItens: number;
}

export interface LocalComCopiaEstoqueSankhya {
  localCodigo: string;
  local: string;
  empresaCodigo: string;
  empresaNome: string;
  totalItens: number;
}

// Recorte de "o que está na cópia de estoque" usado pela contagem por prédio.
//
// A cópia (TGFCTE) é gerada todo dia, mas só traz linha pra produto+local
// que ainda TEM saldo. Quando o saldo zera, a combinação simplesmente some
// das cópias seguintes — então pegar "a última DTCONTAGEM daquele
// produto+local" ressuscita linhas velhas: o CODPROD 2207000 aparecia em RUA
// 2 PRÉDIO 6 NÍVEL 1 por causa de uma cópia de 14/05, sem saldo nenhum hoje
// (e 52.889 das 75.615 combinações estavam nessa situação). A referência
// certa é a última cópia DO LOCAL: vale só o que está nela.
//
// Também fica de fora:
//   - linha com QTDEST <= 0 (a cópia às vezes grava zerado/negativo);
//   - área de quarentena — produto em quarentena não pode ser contado. Os três
//     locais atuais ("ÁREA DE QUARENTENA", "AREA DE QUARENTENA LAPA", "JP
//     QUARENTENA") têm prefixo de loja, então não caem no corte do
//     endereçamento antigo e precisam ser barrados pelo nome.
const SQL_ULTIMA_COPIA_POR_LOCAL = `
  SELECT CODLOCAL, CODEMP, MAX(DTCONTAGEM) AS DTULTIMA
  FROM TGFCTE
  GROUP BY CODLOCAL, CODEMP
`;

export const FILTRO_SQL_SEM_QUARENTENA = `UPPER(NVL(LOC.DESCRLOCAL, ' ')) NOT LIKE '%QUARENTENA%'`;

export function ehLocalDeQuarentena(descricaoLocal: string | null | undefined): boolean {
  return (descricaoLocal ?? '').toUpperCase().includes('QUARENTENA');
}

// Base da contagem por prédio: todo local com saldo na última cópia de
// estoque dele (ver SQL_ULTIMA_COPIA_POR_LOCAL). Paginado (5000/página,
// limite do gateway).
export async function getLocaisComCopiaEstoque(empresa?: string): Promise<LocalComCopiaEstoqueSankhya[]> {
  const filtroEmpresa =
    empresa && Number.isFinite(Number(empresa)) ? `AND CTE.CODEMP = ${Number(empresa)}` : '';

  const todasAsLinhas: LinhaLocalComCopiaSankhya[] = [];
  let offset = 0;

  while (true) {
    const sql = `
      SELECT
        CTE.CODLOCAL AS "localCodigo",
        MAX(COALESCE(LOC.DESCRLOCAL, TO_CHAR(CTE.CODLOCAL))) AS "local",
        CTE.CODEMP AS "empresaCodigo",
        MAX(EMP.NOMEFANTASIA) AS "empresaNome",
        COUNT(DISTINCT CTE.CODPROD) AS "totalItens"
      FROM TGFCTE CTE
      INNER JOIN (${SQL_ULTIMA_COPIA_POR_LOCAL}) ULT
        ON ULT.CODLOCAL = CTE.CODLOCAL AND ULT.CODEMP = CTE.CODEMP AND ULT.DTULTIMA = CTE.DTCONTAGEM
      LEFT JOIN TGFLOC LOC ON CTE.CODLOCAL = LOC.CODLOCAL
      LEFT JOIN TSIEMP EMP ON CTE.CODEMP = EMP.CODEMP
      WHERE CTE.QTDEST > 0
        AND ${FILTRO_SQL_SEM_QUARENTENA}
      ${filtroEmpresa}
      GROUP BY CTE.CODLOCAL, CTE.CODEMP
      ORDER BY CTE.CODLOCAL
      OFFSET ${offset} ROWS FETCH NEXT 5000 ROWS ONLY
    `;

    const pagina = await executarQuery<LinhaLocalComCopiaSankhya>(sql);
    todasAsLinhas.push(...pagina);

    if (pagina.length < 5000) break;
    offset += 5000;
  }

  return todasAsLinhas.map((l) => ({
    localCodigo: String(l.localCodigo),
    local: l.local ?? String(l.localCodigo),
    empresaCodigo: String(l.empresaCodigo),
    empresaNome: l.empresaNome ?? `Empresa ${l.empresaCodigo}`,
    totalItens: l.totalItens,
  }));
}

interface LinhaItemCopiaPorLocalSankhya {
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

export interface ItemCopiaEstoquePorLocalSankhya {
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

// Puxa todos os itens (produto+quantidade) da cópia de estoque pra um lote
// de locais de uma empresa — usado na hora de atribuir um prédio inteiro
// (todos os locais daquele prédio de uma vez), em vez de consultar
// produto a produto.
export async function getItensCopiaEstoquePorLocais(
  localCodigos: string[],
  empresa: string
): Promise<ItemCopiaEstoquePorLocalSankhya[]> {
  const locaisValidos = localCodigos.map((l) => Number(l)).filter((l) => Number.isFinite(l));
  const empresaNum = Number(empresa);
  if (locaisValidos.length === 0 || !Number.isFinite(empresaNum)) return [];

  const todasAsLinhas: LinhaItemCopiaPorLocalSankhya[] = [];
  let offset = 0;

  while (true) {
    const sql = `
      SELECT
        CTE.CODPROD          AS "codigoProduto",
        MAX(PRO.DESCRPROD)   AS "descricao",
        MAX(PRO.CODVOL)      AS "unidade",
        CTE.CODLOCAL         AS "localCodigo",
        MAX(COALESCE(LOC.DESCRLOCAL, TO_CHAR(CTE.CODLOCAL))) AS "local",
        CTE.CODEMP           AS "empresaCodigo",
        MAX(EMP.NOMEFANTASIA) AS "empresaNome",
        -- A mesma cópia às vezes grava mais de uma linha pro mesmo
        -- produto+local (visto em teste: -3 e 2 no mesmo dia) — soma.
        SUM(CTE.QTDEST)      AS "quantidadeEsperada",
        TO_CHAR(MAX(CTE.DTCONTAGEM), 'YYYY-MM-DD"T"HH24:MI:SS') AS "dataCopiaEstoque"
      FROM TGFCTE CTE
      INNER JOIN (${SQL_ULTIMA_COPIA_POR_LOCAL}) ULT
        ON ULT.CODLOCAL = CTE.CODLOCAL AND ULT.CODEMP = CTE.CODEMP AND ULT.DTULTIMA = CTE.DTCONTAGEM
      INNER JOIN TGFPRO PRO ON CTE.CODPROD = PRO.CODPROD
      LEFT JOIN TGFLOC LOC ON CTE.CODLOCAL = LOC.CODLOCAL
      LEFT JOIN TSIEMP EMP ON CTE.CODEMP = EMP.CODEMP
      WHERE CTE.CODLOCAL IN (${locaisValidos.join(', ')})
        AND CTE.CODEMP = ${empresaNum}
        AND ${FILTRO_SQL_SEM_QUARENTENA}
      GROUP BY CTE.CODPROD, CTE.CODLOCAL, CTE.CODEMP
      HAVING SUM(CTE.QTDEST) > 0
      ORDER BY CTE.CODLOCAL, CTE.CODPROD
      OFFSET ${offset} ROWS FETCH NEXT 5000 ROWS ONLY
    `;

    const pagina = await executarQuery<LinhaItemCopiaPorLocalSankhya>(sql);
    todasAsLinhas.push(...pagina);

    if (pagina.length < 5000) break;
    offset += 5000;
  }

  return todasAsLinhas.map((l) => ({
    codigoProduto: String(l.codigoProduto),
    descricao: l.descricao,
    unidade: l.unidade ?? '',
    localCodigo: String(l.localCodigo),
    local: l.local ?? String(l.localCodigo),
    empresaCodigo: String(l.empresaCodigo),
    empresaNome: l.empresaNome ?? `Empresa ${l.empresaCodigo}`,
    quantidadeEsperada: l.quantidadeEsperada,
    dataCopiaEstoque: l.dataCopiaEstoque,
  }));
}

interface LinhaReservaSankhya {
  codigoProduto: number;
  localCodigo: number;
  empresaCodigo: number;
  reservado: number;
}

// Quantidade reservada (TGFEST.RESERVADO) por produto+local+empresa, pra
// entrar nos relatórios ao lado do que foi contado.
//
// Vem tudo de uma vez em vez de linha a linha: só as combinações COM reserva
// são trazidas (hoje ~1.870 de 22.781 linhas de estoque), o que cabe com
// folga numa consulta paginada e evita uma ida ao Sankhya por item do
// relatório. Quem não aparecer no mapa tem reserva zero.
//
// A soma é necessária porque TGFEST quebra a linha por CONTROLE (lote):
// o mesmo produto no mesmo local pode ter várias linhas.
export async function getReservadosSankhya(): Promise<Map<string, number>> {
  const reservas = new Map<string, number>();
  let offset = 0;

  while (true) {
    const sql = `
      SELECT
        EST.CODPROD          AS "codigoProduto",
        EST.CODLOCAL         AS "localCodigo",
        EST.CODEMP           AS "empresaCodigo",
        NVL(SUM(EST.RESERVADO), 0) AS "reservado"
      FROM TGFEST EST
      GROUP BY EST.CODPROD, EST.CODLOCAL, EST.CODEMP
      HAVING NVL(SUM(EST.RESERVADO), 0) > 0
      ORDER BY EST.CODPROD, EST.CODLOCAL, EST.CODEMP
      OFFSET ${offset} ROWS FETCH NEXT 5000 ROWS ONLY
    `;

    const pagina = await executarQuery<LinhaReservaSankhya>(sql);
    for (const linha of pagina) {
      reservas.set(chaveReserva(String(linha.codigoProduto), String(linha.localCodigo), String(linha.empresaCodigo)), linha.reservado);
    }

    if (pagina.length < 5000) break;
    offset += 5000;
  }

  return reservas;
}

// Saldo atual do sistema para VÁRIOS produto+local de uma vez.
//
// Existe porque o relatório "Sistema × Contado" consultava o Sankhya uma vez
// por linha, em sequência: um relatório de 500 itens virava 500 idas ao
// gateway, o que além de lento é o tipo de rajada que faz o Sankhya recusar
// com "Não autorizado".
//
// A regra de saldo é a MESMA de getItemCopiaEstoque, de propósito, pra não
// mudar nenhum número do relatório: a cópia de estoque mais recente do
// produto+local e, quando não existe cópia, o saldo atual do TGFEST.
export async function getSaldosAtuaisPorItem(
  pares: { codigoProduto: string; localCodigo: string }[]
): Promise<Map<string, number>> {
  const saldos = new Map<string, number>();

  const validos = pares
    .map((par) => ({ produto: Number(par.codigoProduto), local: Number(par.localCodigo) }))
    .filter((par) => Number.isFinite(par.produto) && Number.isFinite(par.local));

  // Sem duplicatas: o mesmo produto+local pode aparecer em mais de uma linha.
  const unicos = new Map<string, { produto: number; local: number }>();
  for (const par of validos) unicos.set(`${par.produto}|${par.local}`, par);
  const lista = [...unicos.values()];
  if (lista.length === 0) return saldos;

  // O Oracle limita a lista de um IN, e o gateway trunca em 5000 linhas —
  // 500 pares por consulta fica com folga dos dois lados.
  const TAMANHO_LOTE = 500;

  for (let inicio = 0; inicio < lista.length; inicio += TAMANHO_LOTE) {
    const lote = lista.slice(inicio, inicio + TAMANHO_LOTE);
    const tuplas = lote.map((par) => `(${par.produto}, ${par.local})`).join(', ');

    // ROW_NUMBER reproduz o "ORDER BY DTCONTAGEM DESC, primeira linha" que a
    // versão item a item fazia.
    const sqlCopia = `
      SELECT "codigoProduto", "localCodigo", "quantidadeEsperada"
      FROM (
        SELECT
          CTE.CODPROD  AS "codigoProduto",
          CTE.CODLOCAL AS "localCodigo",
          CTE.QTDEST   AS "quantidadeEsperada",
          ROW_NUMBER() OVER (
            PARTITION BY CTE.CODPROD, CTE.CODLOCAL ORDER BY CTE.DTCONTAGEM DESC
          ) AS RN
        FROM TGFCTE CTE
        WHERE (CTE.CODPROD, CTE.CODLOCAL) IN (${tuplas})
      )
      WHERE RN = 1
    `;

    for (const linha of await executarQuery<LinhaSaldoItemSankhya>(sqlCopia)) {
      saldos.set(`${linha.codigoProduto}|${linha.localCodigo}`, linha.quantidadeEsperada);
    }

    // Quem não tem cópia de estoque cai no saldo atual, como no item a item.
    const semCopia = lote.filter((par) => !saldos.has(`${par.produto}|${par.local}`));
    if (semCopia.length === 0) continue;

    const tuplasSemCopia = semCopia.map((par) => `(${par.produto}, ${par.local})`).join(', ');
    const sqlEstoque = `
      SELECT
        EST.CODPROD  AS "codigoProduto",
        EST.CODLOCAL AS "localCodigo",
        NVL(SUM(EST.ESTOQUE), 0) AS "quantidadeEsperada"
      FROM TGFEST EST
      WHERE (EST.CODPROD, EST.CODLOCAL) IN (${tuplasSemCopia})
      GROUP BY EST.CODPROD, EST.CODLOCAL
    `;

    for (const linha of await executarQuery<LinhaSaldoItemSankhya>(sqlEstoque)) {
      saldos.set(`${linha.codigoProduto}|${linha.localCodigo}`, linha.quantidadeEsperada);
    }
  }

  return saldos;
}

interface LinhaCustoSankhya {
  codigoProduto: number;
  empresaCodigo: number;
  custoSemIcms: number;
}

// Custo sem ICMS (TGFCUS.CUSSEMICM) mais recente de cada produto+empresa.
//
// O TGFCUS guarda histórico (uma linha por DTATUAL), então a leitura pega a
// linha mais recente de cada par — é o custo que vale hoje. Serve pro
// dashboard converter quantidade em dinheiro, que é a linguagem da diretoria.
export async function getCustosSemIcms(
  pares: { codigoProduto: string; empresaCodigo: string }[]
): Promise<Map<string, number>> {
  const custos = new Map<string, number>();

  const unicos = new Map<string, { produto: number; empresa: number }>();
  for (const par of pares) {
    const produto = Number(par.codigoProduto);
    const empresa = Number(par.empresaCodigo);
    if (!Number.isFinite(produto) || !Number.isFinite(empresa)) continue;
    unicos.set(`${produto}|${empresa}`, { produto, empresa });
  }

  const lista = [...unicos.values()];
  if (lista.length === 0) return custos;

  const TAMANHO_LOTE = 500;
  for (let inicio = 0; inicio < lista.length; inicio += TAMANHO_LOTE) {
    const lote = lista.slice(inicio, inicio + TAMANHO_LOTE);
    const tuplas = lote.map((par) => `(${par.produto}, ${par.empresa})`).join(', ');

    const sql = `
      SELECT "codigoProduto", "empresaCodigo", "custoSemIcms"
      FROM (
        SELECT
          CUS.CODPROD   AS "codigoProduto",
          CUS.CODEMP    AS "empresaCodigo",
          CUS.CUSSEMICM AS "custoSemIcms",
          ROW_NUMBER() OVER (
            PARTITION BY CUS.CODPROD, CUS.CODEMP ORDER BY CUS.DTATUAL DESC
          ) AS RN
        FROM TGFCUS CUS
        WHERE (CUS.CODPROD, CUS.CODEMP) IN (${tuplas})
      )
      WHERE RN = 1
    `;

    for (const linha of await executarQuery<LinhaCustoSankhya>(sql)) {
      custos.set(
        chaveCusto(String(linha.codigoProduto), String(linha.empresaCodigo)),
        linha.custoSemIcms ?? 0
      );
    }

    // Produto sem custo cadastrado naquela empresa: usa o custo mais recente
    // dele em qualquer empresa. Um custo aproximado diz muito mais que um
    // zero, que faria o valor do inventário parecer menor do que é.
    const semCusto = lote.filter((par) => !custos.has(chaveCusto(String(par.produto), String(par.empresa))));
    if (semCusto.length === 0) continue;

    const produtosSemCusto = [...new Set(semCusto.map((par) => par.produto))];
    const sqlQualquerEmpresa = `
      SELECT "codigoProduto", "custoSemIcms"
      FROM (
        SELECT
          CUS.CODPROD   AS "codigoProduto",
          CUS.CUSSEMICM AS "custoSemIcms",
          ROW_NUMBER() OVER (PARTITION BY CUS.CODPROD ORDER BY CUS.DTATUAL DESC) AS RN
        FROM TGFCUS CUS
        WHERE CUS.CODPROD IN (${produtosSemCusto.join(', ')})
          AND CUS.CUSSEMICM > 0
      )
      WHERE RN = 1
    `;

    const porProduto = new Map<number, number>();
    for (const linha of await executarQuery<LinhaCustoSankhya>(sqlQualquerEmpresa)) {
      porProduto.set(Number(linha.codigoProduto), linha.custoSemIcms ?? 0);
    }

    for (const par of semCusto) {
      const custo = porProduto.get(par.produto);
      if (custo !== undefined) {
        custos.set(chaveCusto(String(par.produto), String(par.empresa)), custo);
      }
    }
  }

  return custos;
}

export function chaveCusto(codigoProduto: string, empresaCodigo: string): string {
  return `${Number(codigoProduto)}|${Number(empresaCodigo)}`;
}

interface LinhaGrupoSankhya {
  codigoProduto: number;
  grupo: string | null;
}

// Grupo de cada produto (TGFPRO.CODGRUPOPROD -> TGFGRU), pra responder "quais
// famílias de produto mais divergem".
export async function getGruposDeProduto(codigosProduto: string[]): Promise<Map<string, string>> {
  const grupos = new Map<string, string>();

  const codigos = [...new Set(codigosProduto.map(Number).filter(Number.isFinite))];
  if (codigos.length === 0) return grupos;

  const TAMANHO_LOTE = 900;
  for (let inicio = 0; inicio < codigos.length; inicio += TAMANHO_LOTE) {
    const lote = codigos.slice(inicio, inicio + TAMANHO_LOTE);

    const sql = `
      SELECT
        PRO.CODPROD AS "codigoProduto",
        GRU.DESCRGRUPOPROD AS "grupo"
      FROM TGFPRO PRO
      LEFT JOIN TGFGRU GRU ON PRO.CODGRUPOPROD = GRU.CODGRUPOPROD
      WHERE PRO.CODPROD IN (${lote.join(', ')})
    `;

    for (const linha of await executarQuery<LinhaGrupoSankhya>(sql)) {
      grupos.set(String(linha.codigoProduto), linha.grupo ?? 'Sem grupo');
    }
  }

  return grupos;
}

export function chaveSaldoItem(codigoProduto: string, localCodigo: string): string {
  return `${Number(codigoProduto)}|${Number(localCodigo)}`;
}

interface LinhaSaldoItemSankhya {
  codigoProduto: number;
  localCodigo: number;
  quantidadeEsperada: number;
}

export function chaveReserva(codigoProduto: string, localCodigo: string, empresaCodigo: string): string {
  return `${codigoProduto}|${localCodigo}|${empresaCodigo}`;
}

interface LinhaProdutoBuscaSankhya {
  codigoProduto: number;
  descricao: string;
  unidade: string | null;
}

export interface ProdutoBuscaSankhya {
  codigoProduto: string;
  descricao: string;
  unidade: string;
}

// O gateway DbExplorerSP não aceita bind parameters (só string de SQL), então
// todo texto vindo do app precisa ser higienizado à mão antes de entrar na
// query — aqui só sobra o que pode aparecer numa descrição de produto.
function sanitizarTermoBusca(termo: string): string {
  return termo
    .toUpperCase()
    .replace(/[^A-Z0-9ÁÀÂÃÉÊÍÓÔÕÚÇ ./-]/g, ' ')
    // O hífen precisa sobreviver (as descrições são cheias de "9008-319-1350"),
    // mas "--" é comentário de linha e o gateway do Sankhya o remove ANTES de
    // mandar pro Oracle — o que corta a query no meio e deixa a aspas aberta
    // (ORA-01756, confirmado em teste). Colapsar a sequência resolve.
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 60);
}

// Busca de produto por código ou descrição — usada quando o colaborador acha
// um item que não estava na lista dele (item fora do lugar) e precisa dizer
// QUAL produto é. Não dá pra resolver isso pelo código de barras bipado:
// os produtos aqui não têm CODBARRA cadastrado no Sankhya, o que a câmera lê
// é o EAN do fabricante.
export async function buscarProdutosSankhya(termo: string): Promise<ProdutoBuscaSankhya[]> {
  const texto = sanitizarTermoBusca(termo);
  if (texto.length < 2) return [];

  // Código digitado inteiro vem primeiro na lista: sem isso o match exato fica
  // enterrado no meio das descrições que contêm o mesmo número.
  const ehCodigo = /^[0-9]+$/.test(texto) && Number.isFinite(Number(texto));
  const codigo = Number(texto);
  const filtroCodigo = ehCodigo ? `PRO.CODPROD = ${codigo} OR` : '';
  const ordemCodigo = ehCodigo ? `CASE WHEN PRO.CODPROD = ${codigo} THEN 0 ELSE 1 END,` : '';

  const sql = `
    SELECT PRO.CODPROD AS "codigoProduto", PRO.DESCRPROD AS "descricao", PRO.CODVOL AS "unidade"
    FROM TGFPRO PRO
    WHERE PRO.ATIVO = 'S'
      AND (${filtroCodigo} UPPER(PRO.DESCRPROD) LIKE '%${texto}%')
    ORDER BY ${ordemCodigo} PRO.CODPROD
    FETCH FIRST 30 ROWS ONLY
  `;

  const linhas = await executarQuery<LinhaProdutoBuscaSankhya>(sql);
  return linhas.map((l) => ({
    codigoProduto: String(l.codigoProduto),
    descricao: l.descricao,
    unidade: l.unidade ?? '',
  }));
}

interface LinhaLocalEsperadoSankhya {
  localCodigo: number;
  local: string | null;
  quantidade: number;
}

export interface LocalEsperadoSankhya {
  localCodigo: string;
  local: string;
  quantidade: number;
}

// Onde o ERP dizia que o produto deveria estar — base do alerta de
// "divergência de local": o colaborador achou o produto na prateleira X, e
// isso aqui responde "mas o sistema esperava ele em Y". Olha primeiro a
// cópia de estoque (TGFCTE, o retrato oficial da contagem) e cai pro estoque
// atual (TGFEST) quando o produto nunca entrou numa cópia.
export async function getLocaisEsperadosDoProduto(
  codigoProduto: string,
  empresa?: string
): Promise<LocalEsperadoSankhya[]> {
  const produto = Number(codigoProduto);
  if (!Number.isFinite(produto)) return [];
  const empresaNum = Number(empresa);
  const filtroEmpresaCte = Number.isFinite(empresaNum) ? `AND CTE.CODEMP = ${empresaNum}` : '';
  const filtroEmpresaEst = Number.isFinite(empresaNum) ? `AND EST.CODEMP = ${empresaNum}` : '';

  const sqlCopia = `
    SELECT
      CTE.CODLOCAL AS "localCodigo",
      MAX(COALESCE(LOC.DESCRLOCAL, TO_CHAR(CTE.CODLOCAL))) AS "local",
      NVL(SUM(CTE.QTDEST), 0) AS "quantidade"
    FROM TGFCTE CTE
    LEFT JOIN TGFLOC LOC ON CTE.CODLOCAL = LOC.CODLOCAL
    WHERE CTE.CODPROD = ${produto}
      ${filtroEmpresaCte}
      AND CTE.DTCONTAGEM = (
        SELECT MAX(CTE2.DTCONTAGEM) FROM TGFCTE CTE2
        WHERE CTE2.CODPROD = CTE.CODPROD AND CTE2.CODLOCAL = CTE.CODLOCAL AND CTE2.CODEMP = CTE.CODEMP
      )
    GROUP BY CTE.CODLOCAL
    HAVING NVL(SUM(CTE.QTDEST), 0) > 0
    ORDER BY 3 DESC
    FETCH FIRST 10 ROWS ONLY
  `;

  const linhasCopia = await executarQuery<LinhaLocalEsperadoSankhya>(sqlCopia);
  if (linhasCopia.length > 0) {
    return linhasCopia.map((l) => ({
      localCodigo: String(l.localCodigo),
      local: l.local ?? String(l.localCodigo),
      quantidade: l.quantidade,
    }));
  }

  const sqlEstoque = `
    SELECT
      EST.CODLOCAL AS "localCodigo",
      MAX(COALESCE(LOC.DESCRLOCAL, TO_CHAR(EST.CODLOCAL))) AS "local",
      NVL(SUM(EST.ESTOQUE), 0) AS "quantidade"
    FROM TGFEST EST
    LEFT JOIN TGFLOC LOC ON EST.CODLOCAL = LOC.CODLOCAL
    WHERE EST.CODPROD = ${produto}
      ${filtroEmpresaEst}
    GROUP BY EST.CODLOCAL
    HAVING NVL(SUM(EST.ESTOQUE), 0) > 0
    ORDER BY 3 DESC
    FETCH FIRST 10 ROWS ONLY
  `;

  const linhasEstoque = await executarQuery<LinhaLocalEsperadoSankhya>(sqlEstoque);
  return linhasEstoque.map((l) => ({
    localCodigo: String(l.localCodigo),
    local: l.local ?? String(l.localCodigo),
    quantidade: l.quantidade,
  }));
}
