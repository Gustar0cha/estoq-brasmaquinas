// Saldo REAL do estoque (TGFEST), em tempo quase real.
//
// Substitui a cópia de estoque (TGFCTE) como base da contagem. A cópia era um
// retrato tirado uma vez por dia: contar contra ela significava comparar o que
// está na prateleira agora com o que estava no sistema ontem, e toda venda do
// dia virava "divergência" do colaborador. Aqui a referência é o saldo atual,
// relido a cada VALIDADE_SALDO_MS (ver src/lib/cacheTemporario.ts).
//
// TGFEST quebra a linha por CONTROLE (lote): o mesmo produto no mesmo local
// pode ter várias linhas. Por isso toda consulta aqui agrega por
// produto+local+empresa antes de qualquer outra coisa.
//
// Três números, não um:
//   - total      = TGFEST.ESTOQUE   (tudo que o sistema diz que está lá)
//   - reservado  = TGFEST.RESERVADO (preso em pedido pendente, já separado)
//   - disponível = total - reservado
// A contagem é conferida contra o DISPONÍVEL, porque na operação o item
// reservado já foi separado e não deveria mais estar na prateleira.

import { comCache, VALIDADE_SALDO_MS } from '../lib/cacheTemporario';
import { executarQuery } from './gateway';
import { FILTRO_SQL_SEM_QUARENTENA } from './client';

const PAGINA = 5000;

// Agrega TGFEST por produto+local+empresa e descarta o que não tem saldo.
// Serve de base pra todas as consultas deste módulo.
const SUBCONSULTA_SALDO = `
  SELECT
    EST.CODPROD  AS CODPROD,
    EST.CODLOCAL AS CODLOCAL,
    EST.CODEMP   AS CODEMP,
    NVL(SUM(EST.ESTOQUE), 0)   AS TOTAL,
    NVL(SUM(EST.RESERVADO), 0) AS RESERVADO
  FROM TGFEST EST
  GROUP BY EST.CODPROD, EST.CODLOCAL, EST.CODEMP
  HAVING NVL(SUM(EST.ESTOQUE), 0) > 0
`;

export interface LocalComSaldoSankhya {
  localCodigo: string;
  local: string;
  localPaiCodigo: string | null;
  localPai: string | null;
  empresaCodigo: string;
  empresaNome: string;
  totalItens: number;
}

interface LinhaLocalComSaldo {
  localCodigo: number;
  local: string | null;
  localPaiCodigo: number | null;
  localPai: string | null;
  empresaCodigo: number;
  empresaNome: string | null;
  totalItens: number;
}

// Base da contagem por prédio: todo local que tem saldo agora.
export async function getLocaisComSaldo(empresa?: string): Promise<LocalComSaldoSankhya[]> {
  const empresaNum = empresa && Number.isFinite(Number(empresa)) ? Number(empresa) : null;

  return comCache(`locais-saldo|${empresaNum ?? 'todas'}`, VALIDADE_SALDO_MS, async () => {
    const linhas: LinhaLocalComSaldo[] = [];
    let offset = 0;

    while (true) {
      const sql = `
        SELECT
          S.CODLOCAL AS "localCodigo",
          MAX(COALESCE(LOC.DESCRLOCAL, TO_CHAR(S.CODLOCAL))) AS "local",
          MAX(LOC.CODLOCALPAI) AS "localPaiCodigo",
          MAX(PAI.DESCRLOCAL) AS "localPai",
          S.CODEMP AS "empresaCodigo",
          MAX(EMP.NOMEFANTASIA) AS "empresaNome",
          COUNT(DISTINCT S.CODPROD) AS "totalItens"
        FROM (${SUBCONSULTA_SALDO}) S
        LEFT JOIN TGFLOC LOC ON S.CODLOCAL = LOC.CODLOCAL
        LEFT JOIN TGFLOC PAI ON LOC.CODLOCALPAI = PAI.CODLOCAL
        LEFT JOIN TSIEMP EMP ON S.CODEMP = EMP.CODEMP
        WHERE ${FILTRO_SQL_SEM_QUARENTENA}
        ${empresaNum === null ? '' : `AND S.CODEMP = ${empresaNum}`}
        GROUP BY S.CODLOCAL, S.CODEMP
        ORDER BY S.CODLOCAL
        OFFSET ${offset} ROWS FETCH NEXT ${PAGINA} ROWS ONLY
      `;

      const pagina = await executarQuery<LinhaLocalComSaldo>(sql);
      linhas.push(...pagina);
      if (pagina.length < PAGINA) break;
      offset += PAGINA;
    }

    return linhas.map((l) => ({
      localCodigo: String(l.localCodigo),
      local: l.local ?? String(l.localCodigo),
      localPaiCodigo:
        l.localPaiCodigo === null || l.localPaiCodigo === undefined ? null : String(l.localPaiCodigo),
      localPai: l.localPai ?? null,
      empresaCodigo: String(l.empresaCodigo),
      empresaNome: l.empresaNome ?? `Empresa ${l.empresaCodigo}`,
      totalItens: l.totalItens,
    }));
  });
}

export interface ItemComSaldoSankhya {
  codigoProduto: string;
  descricao: string;
  unidade: string;
  localCodigo: string;
  local: string;
  empresaCodigo: string;
  empresaNome: string;
  // Marca e grupo entram aqui porque a atribuição filtra por eles.
  marca: string | null;
  grupoCodigo: string | null;
  grupo: string | null;
  quantidadeTotal: number;
  quantidadeReservada: number;
  // O número contra o qual a contagem é conferida (total - reservado).
  quantidadeDisponivel: number;
}

interface LinhaItemComSaldo {
  codigoProduto: number;
  descricao: string;
  unidade: string | null;
  localCodigo: number;
  local: string | null;
  empresaCodigo: number;
  empresaNome: string | null;
  marca: string | null;
  grupoCodigo: number | null;
  grupo: string | null;
  quantidadeTotal: number;
  quantidadeReservada: number;
}

function montarItem(l: LinhaItemComSaldo): ItemComSaldoSankhya {
  const total = Number(l.quantidadeTotal) || 0;
  const reservada = Number(l.quantidadeReservada) || 0;
  return {
    codigoProduto: String(l.codigoProduto),
    descricao: l.descricao,
    unidade: l.unidade ?? '',
    localCodigo: String(l.localCodigo),
    local: l.local ?? String(l.localCodigo),
    empresaCodigo: String(l.empresaCodigo),
    empresaNome: l.empresaNome ?? `Empresa ${l.empresaCodigo}`,
    marca: l.marca ?? null,
    grupoCodigo: l.grupoCodigo === null || l.grupoCodigo === undefined ? null : String(l.grupoCodigo),
    grupo: l.grupo ?? null,
    quantidadeTotal: total,
    quantidadeReservada: reservada,
    // Reserva maior que o saldo existe (pedido acima do que tem em casa) e
    // deixaria o esperado negativo — piso em zero.
    quantidadeDisponivel: Math.max(0, total - reservada),
  };
}

const CAMPOS_ITEM = `
  S.CODPROD            AS "codigoProduto",
  MAX(PRO.DESCRPROD)   AS "descricao",
  MAX(PRO.CODVOL)      AS "unidade",
  S.CODLOCAL           AS "localCodigo",
  MAX(COALESCE(LOC.DESCRLOCAL, TO_CHAR(S.CODLOCAL))) AS "local",
  S.CODEMP             AS "empresaCodigo",
  MAX(EMP.NOMEFANTASIA) AS "empresaNome",
  MAX(PRO.MARCA)       AS "marca",
  MAX(PRO.CODGRUPOPROD) AS "grupoCodigo",
  MAX(GRU.DESCRGRUPOPROD) AS "grupo",
  MAX(S.TOTAL)         AS "quantidadeTotal",
  MAX(S.RESERVADO)     AS "quantidadeReservada"
`;

const JUNCOES_ITEM = `
  INNER JOIN TGFPRO PRO ON S.CODPROD = PRO.CODPROD
  LEFT JOIN TGFGRU GRU ON PRO.CODGRUPOPROD = GRU.CODGRUPOPROD
  LEFT JOIN TGFLOC LOC ON S.CODLOCAL = LOC.CODLOCAL
  LEFT JOIN TSIEMP EMP ON S.CODEMP = EMP.CODEMP
`;

// Todos os itens com saldo num lote de locais de uma empresa — usado ao
// atribuir um prédio inteiro, em vez de consultar produto a produto.
export async function getItensComSaldoPorLocais(
  localCodigos: string[],
  empresa: string
): Promise<ItemComSaldoSankhya[]> {
  const locais = localCodigos.map(Number).filter(Number.isFinite);
  const empresaNum = Number(empresa);
  if (locais.length === 0 || !Number.isFinite(empresaNum)) return [];

  const chave = `itens-saldo|${empresaNum}|${[...locais].sort((a, b) => a - b).join(',')}`;

  return comCache(chave, VALIDADE_SALDO_MS, async () => {
    const linhas: LinhaItemComSaldo[] = [];
    let offset = 0;

    while (true) {
      const sql = `
        SELECT ${CAMPOS_ITEM}
        FROM (${SUBCONSULTA_SALDO}) S
        ${JUNCOES_ITEM}
        WHERE S.CODLOCAL IN (${locais.join(', ')})
          AND S.CODEMP = ${empresaNum}
          AND ${FILTRO_SQL_SEM_QUARENTENA}
        GROUP BY S.CODPROD, S.CODLOCAL, S.CODEMP
        ORDER BY S.CODLOCAL, S.CODPROD
        OFFSET ${offset} ROWS FETCH NEXT ${PAGINA} ROWS ONLY
      `;

      const pagina = await executarQuery<LinhaItemComSaldo>(sql);
      linhas.push(...pagina);
      if (pagina.length < PAGINA) break;
      offset += PAGINA;
    }

    return linhas.map(montarItem);
  });
}

// Saldo de um produto+local específico. Usado quando o colaborador bipa um
// item que não estava na lista dele (item fora do lugar): aí não se sabe a
// empresa de antemão, então traz a linha de qualquer empresa que tenha saldo.
export async function getSaldoDoItem(
  codigoProduto: string,
  localCodigo: string
): Promise<ItemComSaldoSankhya | null> {
  const produto = Number(codigoProduto);
  const local = Number(localCodigo);
  if (!Number.isFinite(produto) || !Number.isFinite(local)) return null;

  const linhas = await executarQuery<LinhaItemComSaldo>(`
    SELECT ${CAMPOS_ITEM}
    FROM (${SUBCONSULTA_SALDO}) S
    ${JUNCOES_ITEM}
    WHERE S.CODPROD = ${produto} AND S.CODLOCAL = ${local}
    GROUP BY S.CODPROD, S.CODLOCAL, S.CODEMP
    ORDER BY MAX(S.TOTAL) DESC
    OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY
  `);

  return linhas.length > 0 ? montarItem(linhas[0]) : null;
}

// Saldo de VÁRIOS produto+local de uma vez, para os relatórios (que antes
// consultavam um por um e derrubavam o gateway).
export function chaveSaldo(codigoProduto: string, localCodigo: string, empresaCodigo: string): string {
  return `${codigoProduto}|${localCodigo}|${empresaCodigo}`;
}

export async function getSaldosPorItens(
  pares: { codigoProduto: string; localCodigo: string }[]
): Promise<Map<string, ItemComSaldoSankhya>> {
  const mapa = new Map<string, ItemComSaldoSankhya>();

  const unicos = new Map<string, { produto: number; local: number }>();
  for (const par of pares) {
    const produto = Number(par.codigoProduto);
    const local = Number(par.localCodigo);
    if (!Number.isFinite(produto) || !Number.isFinite(local)) continue;
    unicos.set(`${produto}|${local}`, { produto, local });
  }
  const lista = [...unicos.values()];
  if (lista.length === 0) return mapa;

  // O Oracle limita a lista de um IN e o gateway trunca em 5000 linhas —
  // 500 pares por consulta fica com folga dos dois lados.
  const LOTE = 500;

  for (let inicio = 0; inicio < lista.length; inicio += LOTE) {
    const lote = lista.slice(inicio, inicio + LOTE);
    const tuplas = lote.map((p) => `(${p.produto}, ${p.local})`).join(', ');

    const linhas = await executarQuery<LinhaItemComSaldo>(`
      SELECT ${CAMPOS_ITEM}
      FROM (${SUBCONSULTA_SALDO}) S
      ${JUNCOES_ITEM}
      WHERE (S.CODPROD, S.CODLOCAL) IN (${tuplas})
      GROUP BY S.CODPROD, S.CODLOCAL, S.CODEMP
    `);

    for (const linha of linhas) {
      const item = montarItem(linha);
      mapa.set(chaveSaldo(item.codigoProduto, item.localCodigo, item.empresaCodigo), item);
    }
  }

  return mapa;
}

// ---------------------------------------------------------------------------
// Pedidos que prendem o item (de onde vem o RESERVADO)
// ---------------------------------------------------------------------------

export interface PedidoQueReserva {
  numeroUnico: string;
  numeroPedido: string | null;
  operacao: string | null;
  parceiro: string | null;
  data: string | null;
  quantidade: number;
}

interface LinhaPedidoReserva {
  numeroUnico: number;
  numeroPedido: number | null;
  operacao: string | null;
  parceiro: string | null;
  data: string | null;
  quantidade: number;
}

// Nem todo pedido pendente reserva estoque: só os de operação com
// TGFTOP.ATUALEST = 'R'. Os orçamentos (ATUALEST = 'N') não prendem nada.
// Conferido contra TGFEST.RESERVADO em 30 de 30 combinações sorteadas —
// somar todos os pendentes dava um número bem maior que a reserva real.
const TOP_QUE_RESERVA = `
  INNER JOIN TGFTOP TOP ON TOP.CODTIPOPER = CAB.CODTIPOPER
    AND TOP.DHALTER = (SELECT MAX(T2.DHALTER) FROM TGFTOP T2 WHERE T2.CODTIPOPER = TOP.CODTIPOPER)
`;

export async function getPedidosQueReservam(
  codigoProduto: string,
  localCodigo: string,
  empresaCodigo: string
): Promise<PedidoQueReserva[]> {
  const produto = Number(codigoProduto);
  const local = Number(localCodigo);
  const empresa = Number(empresaCodigo);
  if (!Number.isFinite(produto) || !Number.isFinite(local) || !Number.isFinite(empresa)) return [];

  return comCache(`pedidos-reserva|${produto}|${local}|${empresa}`, VALIDADE_SALDO_MS, async () => {
    const linhas = await executarQuery<LinhaPedidoReserva>(`
      SELECT
        CAB.NUNOTA  AS "numeroUnico",
        CAB.NUMNOTA AS "numeroPedido",
        MAX(TOP.DESCROPER) AS "operacao",
        MAX(PAR.NOMEPARC)  AS "parceiro",
        TO_CHAR(MAX(CAB.DTNEG), 'YYYY-MM-DD') AS "data",
        NVL(SUM(ITE.QTDNEG - NVL(ITE.QTDENTREGUE, 0)), 0) AS "quantidade"
      FROM TGFITE ITE
      INNER JOIN TGFCAB CAB ON CAB.NUNOTA = ITE.NUNOTA
      ${TOP_QUE_RESERVA}
      LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE ITE.CODPROD = ${produto}
        AND ITE.CODLOCALORIG = ${local}
        AND CAB.CODEMP = ${empresa}
        AND CAB.PENDENTE = 'S'
        AND TOP.ATUALEST = 'R'
      GROUP BY CAB.NUNOTA, CAB.NUMNOTA
      HAVING NVL(SUM(ITE.QTDNEG - NVL(ITE.QTDENTREGUE, 0)), 0) > 0
      ORDER BY 6 DESC
    `);

    return linhas.map((l) => ({
      numeroUnico: String(l.numeroUnico),
      numeroPedido: l.numeroPedido === null || l.numeroPedido === undefined ? null : String(l.numeroPedido),
      operacao: l.operacao ?? null,
      parceiro: l.parceiro ?? null,
      data: l.data ?? null,
      quantidade: Number(l.quantidade) || 0,
    }));
  });
}
